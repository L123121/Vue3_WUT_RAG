"use strict";

const config = require('../config');
const { logEvent } = require('./observability.service');

const DEFAULT_COLLECTION = 'wuli_elf_chunks';
const DENSE_DIM = 512;
// Qdrant(actix-web) 默认单请求体上限 ~2MB：长 parentText 下 128 条/批会超限被断连(EPIPE)，
// 减小批量 + 失败重试，保证大文档重建稳定
const BATCH_SIZE = 32;
const UPSERT_MAX_RETRY = 3;

/**
 * QdrantVectorStore — Qdrant 独立服务向量库（单例，唯一实现）
 *
 * 外部接口：
 *   addChunks / search / deleteByDocId / resetCollection / count / isAvailable / ensureReady / setDocumentProvider
 *
 * 设计：
 *   - collection 命名向量：dense(512d, Cosine) + sparse(idf modifier)
 *   - payload 存全量元数据：docId / parentId / parentIdx / parentText / title / category / chunkIndex / text
 *   - point id：原始字符串 id（docId_sent_i）确定性哈希为 uint32，冲突时线性探测
 *   - search：dense + sparse 两次查询，客户端按 weights 加权融合（与文件版评分语义一致）
 *   - 评分：score = vectorWeight·denseCosine + sparseWeight·sparseDot，附带 _vectorScore/_sparseScore/_hybridScore
 *   - ⚠️ 两类分数原始量纲差约两个数量级（dense 余弦 ≤1，sparse IDF 点积可达数十），
 *     加权前必须各自除以本通道最大分归一化，否则 0.6/0.4 权重形同虚设、稠密通道被淹没
 */
class QdrantVectorStore {
  constructor(documentProvider = null) {
    const vectorConfig = config.vectorStore || {};
    this.vectorWeight = vectorConfig.vectorWeight ?? 0.6;
    this.sparseWeight = vectorConfig.sparseWeight ?? 0.4;
    // 通道内归一化开关（RAG_FUSION_NORM=false 回退原始加权行为，供 A/B 对比）
    this.fusionNorm = vectorConfig.fusionNorm ?? true;
    this.url = vectorConfig.qdrantUrl || 'http://localhost:6333';
    this.apiKey = vectorConfig.qdrantApiKey || '';
    this.collectionName = vectorConfig.collectionName || DEFAULT_COLLECTION;
    // payload 关键词索引（docId/category）：元数据过滤由全量扫描变为索引查找
    this.payloadIndexEnabled = vectorConfig.payloadIndexEnabled !== false;
    // 标量量化（'int8'）：向量内存约省 75%；对已存在 collection 需重建后才全量生效
    this.quantization = vectorConfig.quantization || '';

    this._client = null;
    this._ready = false;
    this._readyPromise = null;
    this._readyResolve = null;
    this._readyChecked = false; // ensureReady 是否已完成空库检查/重建
    // _ready 表示「初始化已尘埃落定(成功或降级放行)」;_connected 才表示当前真实连通。
    // 连接失败时 _ready 仍置 true(解除 _waitConnected 阻塞,各操作按 _client 判空降级),
    // 由 _connected + _scheduleReconnect 驱动后台自动重连
    this._connected = false;
    this._reconnectTimer = null;
    this._reconnectAttempts = 0;
    this._documentProvider = documentProvider;
    this._initializing = false;
    this._pointCount = 0;
    this._idMap = new Map(); // hash → originalId，用于碰撞探测

    this._connect();
  }

  setDocumentProvider(provider) {
    if (typeof provider === 'function') this._documentProvider = provider;
  }

  // ==================== 初始化 ====================

  /** 创建 Qdrant 客户端（独立方法便于测试注入 fake） */
  _createClient() {
    const { QdrantClient } = require('@qdrant/js-client-rest');
    return new QdrantClient({
      url: this.url,
      apiKey: this.apiKey || undefined,
      timeout: 15000,
      // 客户端(1.19)与服务端(如 1.12)小版本差异超 1 时仅提示不阻断；
      // 本服务只使用基础 REST API（collection/upsert/query/count/delete），跨小版本兼容
      checkCompatibility: false,
    });
  }

  async _connect() {
    try {
      this._client = this._createClient();
      const { exists } = await this._client.collectionExists(this.collectionName);
      if (!exists) {
        const quantization = this._quantizationConfig();
        await this._client.createCollection(this.collectionName, {
          vectors: {
            dense: { size: DENSE_DIM, distance: 'Cosine', on_disk: false },
          },
          sparse_vectors: {
            sparse: { modifier: 'idf' },
          },
          ...(quantization ? { quantization_config: quantization } : {}),
        });
        logEvent('info', 'vector_store_collection_created', {
          collection: this.collectionName,
          denseDim: DENSE_DIM,
          quantization: quantization || null,
        });
      } else {
        logEvent('info', 'vector_store_collection_connected', { collection: this.collectionName });
        // 已存在的 collection 补配量化：新写入的点开始量化，存量点需重建后全量生效
        if (this.quantization === 'int8') {
          try {
            await this._client.updateCollection(this.collectionName, { quantization_config: this._quantizationConfig() });
            logEvent('info', 'vector_store_quantization_enabled_existing', { message: '已为现有 collection 开启 int8 量化（存量向量需重建后全量生效）' });
          } catch (err) {
            logEvent('warn', 'vector_store_quantization_enable_failed', { message: '开启量化失败(忽略)', error: err.message });
          }
        }
      }
      await this._ensurePayloadIndexes();
      const count = await this._client.count(this.collectionName, { exact: true });
      this._pointCount = count.count || 0;
      this._connected = true;
      this._reconnectAttempts = 0;
      if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
      // 重连成功(含首次连接):重置就绪检查状态,让下一次 ensureReady 重新执行
      // 空库检查/自动重建——修复后无需重启后端即可自愈
      this._readyPromise = null;
      this._readyChecked = false;
      this._ready = true;
      if (this._readyResolve) this._readyResolve();
      logEvent('info', 'vector_store_ready', { pointCount: this._pointCount });
    } catch (err) {
      // 降级放行(与原行为一致):search 等操作按 _client 判空返回空结果;
      // 差别在于现在会安排后台重连,而不是打一条 warn 后永久吞掉故障。
      // _client 必须置空:探测失败时客户端实例已创建,若保留,search 会带着
      // 不可达的 client 抛 ECONNREFUSED,而不是按降级契约返回空结果
      logEvent('warn', 'vector_store_connect_failed', { message: '连接失败(将自动重连，期间 search 返回空)', error: err.message });
      this._client = null;
      this._connected = false;
      this._ready = true;
      if (this._readyResolve) this._readyResolve();
      this._scheduleReconnect();
    }
  }

  /** 连接失败后的后台重连:指数退避 30s→60s→…→上限 5min;unref 不阻止进程退出 */
  _scheduleReconnect() {
    if (this._reconnectTimer) return;
    const delay = Math.min(30000 * 2 ** this._reconnectAttempts, 300000);
    this._reconnectAttempts += 1;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      if (!this._connected) void this._connect();
    }, delay);
    if (typeof this._reconnectTimer.unref === 'function') this._reconnectTimer.unref();
  }

  /** 标量量化配置：仅显式配置 QDRANT_QUANTIZATION=int8 时返回 */
  _quantizationConfig() {
    if (this.quantization !== 'int8') return null;
    return { scalar: { type: 'int8', quantile: 0.99, always_ram: true } };
  }

  /**
   * 为 docId/category 创建关键词 payload 索引（幂等，已存在时跳过）
   * 元数据过滤（category 自动推断 / deleteByDocId）走索引，避免全量扫描
   */
  async _ensurePayloadIndexes() {
    if (!this._client || !this.payloadIndexEnabled) return;
    for (const field of ['docId', 'category']) {
      try {
        await this._client.createPayloadIndex(this.collectionName, {
          field_name: field,
          field_schema: 'keyword',
          wait: true,
        });
        logEvent('info', 'vector_store_payload_index_created', { field });
      } catch (err) {
        const msg = String(err?.message || err || '');
        if (/already exists/i.test(msg)) continue;
        logEvent('warn', 'vector_store_payload_index_failed', { field, error: msg });
      }
    }
  }

  /** 仅等待连接就绪（不触发重建）。内部写/查操作使用，避免与 ensureReady 的重建流程互相等待 */
  async _waitConnected() {
    while (!this._ready) {
      await new Promise(r => setTimeout(r, 100));
    }
    return this._client;
  }

  async ensureReady() {
    // 已就绪且已完成空库检查 → 直接返回
    if (this._ready && this._readyChecked) return;
    if (this._readyPromise) return this._readyPromise;

    this._readyPromise = (async () => {
      // 等待构造函数里异步发起的 _connect 完成
      await this._waitConnected();
      if (!this._client) return; // 连接失败，search 会返回空
      // collection 为空且有文档提供者 → 从文档库重建索引
      if (this._pointCount === 0) {
        await this._rebuildFromDocuments();
      }
      this._readyChecked = true;
    })();

    try {
      await this._readyPromise;
    } catch (err) {
      logEvent('warn', 'vector_store_ensure_ready_failed', { error: err.message });
      this._readyChecked = true;
    }
    return this._readyPromise;
  }

  async _rebuildFromDocuments() {
    if (!this._documentProvider) return;
    if (this._initializing) return;
    this._initializing = true;
    try {
      const docs = await this._documentProvider();
      if (!Array.isArray(docs) || docs.length === 0) {
        logEvent('info', 'vector_store_rebuild_skipped_empty', { message: '文档库为空，跳过重建' });
        return;
      }
      logEvent('info', 'vector_store_rebuild_start', { docCount: docs.length });
      const t0 = Date.now();
      const { IndexingService } = require('./indexing.service');
      const { EmbeddingService } = require('./embedding.service');
      const indexing = new IndexingService(this, new EmbeddingService());
      await indexing.reindexAll(docs);
      logEvent('info', 'vector_store_rebuild_done', { pointCount: this._pointCount, elapsedMs: Date.now() - t0 });
    } catch (err) {
      logEvent('warn', 'vector_store_rebuild_failed', { error: err.message });
      if (err.cause) {
        const causeMsg = err.cause.message || (typeof err.cause === 'string' ? err.cause : JSON.stringify(err.cause).slice(0, 300));
        logEvent('warn', 'vector_store_rebuild_failed_cause', { cause: causeMsg });
      }
      if (err.stack) {
        logEvent('warn', 'vector_store_rebuild_failed_stack', { stack: err.stack.split('\n').slice(0, 8).join('\n') });
      }
    } finally {
      this._initializing = false;
    }
  }

  // ==================== 公开 API ====================

  async addChunks(ids, embeddings, documents, metadatas) {
    if (!ids.length) return;
    // 内部写操作只等连接就绪（不触发/等待重建），避免 reindexAll 期间与外层 ensureReady 互相等待
    await this._waitConnected();
    if (!this._client) throw new Error('Qdrant not initialized');

    const points = [];
    for (let i = 0; i < ids.length; i++) {
      const metadata = metadatas[i] || {};
      const embedding = this._normalizeEmbedding(embeddings[i]);
      if (!embedding?.dense?.length) continue;

      const pointId = this._toPointId(ids[i]);
      points.push({
        id: pointId,
        vector: {
          dense: embedding.dense,
          sparse: this._toSparseVector(embedding.sparse),
        },
        payload: {
          id: ids[i],
          text: documents[i] || '',
          docId: metadata.docId || '',
          parentId: metadata.parentId || metadata.docId || '',
          parentIdx: metadata.parentIdx ?? -1,
          parentText: metadata.parentText || '',
          title: metadata.title || '',
          category: metadata.category || '',
          chunkIndex: metadata.chunkIndex ?? -1,
        },
      });
    }

    for (let i = 0; i < points.length; i += BATCH_SIZE) {
      const batch = points.slice(i, i + BATCH_SIZE);
      // 大文档重建时可能偶发瞬时断连(EPIPE/超时)，重试提高稳定性
      for (let attempt = 1; attempt <= UPSERT_MAX_RETRY; attempt++) {
        try {
          await this._client.upsert(this.collectionName, { points: batch });
          break;
        } catch (err) {
          if (attempt === UPSERT_MAX_RETRY) throw err;
          logEvent('warn', 'vector_store_upsert_retry', { batch: i / BATCH_SIZE + 1, attempt, error: err.message });
          await new Promise(r => setTimeout(r, 300 * attempt));
        }
      }
    }
    this._pointCount += points.length;
  }

  async search(queryEmbedding, topK = 10, filter = null, weights = null) {
    await this._waitConnected();
    if (!this._client) return [];

    const embedding = this._normalizeEmbedding(queryEmbedding);
    if (!embedding?.dense?.length) return [];

    const vectorWeight = weights?.vector ?? this.vectorWeight;
    const sparseWeight = weights?.sparse ?? this.sparseWeight;
    const qdrantFilter = this._buildFilter(filter);

    // dense + sparse 并行查询（RAG 首包延迟关键路径）
    const [denseRes, sparseRes] = await Promise.all([
      // dense 查询（Cosine，score 即余弦相似度）
      this._client.query(this.collectionName, {
        query: embedding.dense,
        using: 'dense',
        limit: topK,
        filter: qdrantFilter,
        with_payload: true,
      }),
      // sparse 查询（dot + idf modifier）
      (async () => {
        const sparseVector = this._toSparseVector(embedding.sparse);
        if (sparseVector.indices.length === 0) return { points: [] };
        return this._client.query(this.collectionName, {
          query: sparseVector,
          using: 'sparse',
          limit: topK,
          filter: qdrantFilter,
          with_payload: true,
        });
      })(),
    ]);

    // 客户端融合：按原始 id 合并，score = w·dense + (1-w)·sparse
    const merged = new Map();
    const add = (point, denseScore, sparseScore) => {
      const id = point.payload?.id || point.id;
      const existing = merged.get(id) || {
        id,
        docId: point.payload?.docId || '',
        parentId: point.payload?.parentId || point.payload?.docId || '',
        parentText: point.payload?.parentText || '',
        parentIdx: point.payload?.parentIdx ?? -1,
        text: point.payload?.text || '',
        title: point.payload?.title || '',
        category: point.payload?.category || '',
        chunkIndex: point.payload?.chunkIndex ?? -1,
        _vectorScore: 0,
        _sparseScore: 0,
        _retrievalChannels: [],
      };
      existing._vectorScore = Math.max(existing._vectorScore, denseScore);
      existing._sparseScore = Math.max(existing._sparseScore, sparseScore);
      if (denseScore > 0 && !existing._retrievalChannels.includes('vector')) existing._retrievalChannels.push('vector');
      if (sparseScore > 0 && !existing._retrievalChannels.includes('sparse')) existing._retrievalChannels.push('sparse');
      merged.set(id, existing);
    };

    for (const p of denseRes.points || []) add(p, p.score || 0, 0);
    for (const p of sparseRes.points || []) add(p, 0, p.score || 0);

    const scored = [...merged.values()].map(item => {
      const rawScore = vectorWeight * item._vectorScore + sparseWeight * item._sparseScore;
      return {
        ...item,
        score: rawScore,
        _hybridScore: rawScore,
        _retrievalChannels: item._retrievalChannels.length ? item._retrievalChannels : ['vector', 'sparse'],
      };
    });

    // 通道内归一化后再加权：dense 余弦 ≤1，sparse IDF 点积可达数十，
    // 直接加权和会被稀疏通道独占（"0.6/0.4 权重"名存实亡）。
    // 各自除以本通道最大分（归一到 [0,1]）后，权重才真正表达两通道的相对重要性。
    let fused = scored;
    if (this.fusionNorm) {
      const maxDense = Math.max(0, ...scored.map(item => item._vectorScore));
      const maxSparse = Math.max(0, ...scored.map(item => item._sparseScore));
      fused = scored.map(item => {
        const denseNorm = maxDense > 0 ? item._vectorScore / maxDense : 0;
        const sparseNorm = maxSparse > 0 ? item._sparseScore / maxSparse : 0;
        const score = vectorWeight * denseNorm + sparseWeight * sparseNorm;
        return { ...item, score, _hybridScore: score };
      });
    }

    fused.sort((a, b) => b.score - a.score);
    return fused.slice(0, topK);
  }

  async deleteByDocId(docId) {
    if (!this._client) return;
    await this._waitConnected();
    const result = await this._client.delete(this.collectionName, {
      filter: { must: [{ key: 'docId', match: { value: docId } }] },
    });
    if (result?.status === 'completed') this._pointCount = 0; // 懒刷新，下次 count 修正
  }

  /**
   * 取回指定文档的全部向量点（含向量），供增量重索引按内容 hash 复用
   * @returns {Promise<Array<{ id: string, text: string, dense: number[], sparse: Object }>>}
   *          sparse 转回 {dim: weight} map 形式，与 embedBatch 输出一致
   */
  async getDocPoints(docId) {
    await this._waitConnected();
    if (!this._client) return [];
    const points = [];
    let offset = undefined;
    do {
      const page = await this._client.scroll(this.collectionName, {
        filter: { must: [{ key: 'docId', match: { value: docId } }] },
        with_vector: true,
        with_payload: true,
        limit: 256,
        ...(offset !== undefined ? { offset } : {}),
      });
      for (const p of page.points || []) {
        const vector = p.vector || {};
        const rawSparse = vector.sparse || {};
        const sparse = Array.isArray(rawSparse.indices)
          ? Object.fromEntries(rawSparse.indices.map((dim, i) => [dim, rawSparse.values[i]]))
          : (rawSparse || {});
        points.push({
          id: p.payload?.id || String(p.id),
          text: p.payload?.text || '',
          dense: vector.dense || null,
          sparse,
        });
      }
      offset = page.next_page_offset ?? undefined;
    } while (offset !== undefined);
    return points;
  }

  async resetCollection() {
    if (!this._client) return;
    try {
      await this._client.deleteCollection(this.collectionName);
      logEvent('info', 'vector_store_collection_deleted', { collection: this.collectionName });
    } catch (err) {
      logEvent('warn', 'vector_store_collection_delete_failed', { error: err.message });
    }
    this._pointCount = 0;
    this._idMap.clear();
    this._ready = false;
    this._client = null;
    await this._connect();
  }

  async count() {
    if (!this._client) return 0;
    try {
      const result = await this._client.count(this.collectionName, { exact: true });
      this._pointCount = result.count || 0;
      return this._pointCount;
    } catch {
      return this._pointCount;
    }
  }

  async isAvailable() {
    return !!this._client;
  }

  // ==================== 工具 ====================

  _toPointId(originalId) {
    const hash = this._hashString(String(originalId));
    let pointId = hash;
    // 线性探测避免哈希碰撞
    while (this._idMap.has(pointId) && this._idMap.get(pointId) !== originalId) {
      pointId = (pointId + 1) >>> 0;
    }
    this._idMap.set(pointId, originalId);
    return pointId;
  }

  _hashString(str) {
    let hash = 2166136261; // FNV-1a 32bit
    for (let i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }

  _toSparseVector(sparse) {
    if (!sparse || typeof sparse !== 'object') return { indices: [], values: [] };
    const entries = Object.entries(sparse).filter(([, v]) => v > 0);
    entries.sort((a, b) => Number(a[0]) - Number(b[0]));
    return {
      indices: entries.map(([k]) => Number(k)),
      values: entries.map(([, v]) => v),
    };
  }

  _buildFilter(filter) {
    if (!filter || typeof filter !== 'object') return undefined;
    const must = [];
    for (const [key, value] of Object.entries(filter)) {
      if (value === undefined || value === null || value === '') continue;
      const payloadKey = key === 'docId' ? 'docId' : key;
      must.push({ key: payloadKey, match: { value } });
    }
    return must.length ? { must } : undefined;
  }

  _normalizeEmbedding(embedding) {
    if (!embedding) return null;
    if (Array.isArray(embedding)) return { dense: embedding, sparse: {} };
    if (Array.isArray(embedding.dense)) {
      return { dense: embedding.dense, sparse: embedding.sparse || {} };
    }
    if (Array.isArray(embedding.embedding)) {
      return {
        dense: embedding.embedding,
        sparse: embedding.sparse || embedding.sparse_vector || {},
      };
    }
    return null;
  }
}

// ==================== 单例 ====================

let instance = null;
function getInstance() {
  if (!instance) instance = new QdrantVectorStore();
  return instance;
}
function registerDocumentProvider(provider) {
  getInstance().setDocumentProvider(provider);
}

module.exports = { vectorStore: getInstance(), registerDocumentProvider, QdrantVectorStore, _class: QdrantVectorStore };
