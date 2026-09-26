"use strict";

const { logEvent } = require('./observability.service');

const crypto = require('crypto');
const chunker = require('./rag-chunker');
const { EmbeddingService, SparseStats, getSparseStats, setSparseStats } = require('./embedding.service');

/** 稀疏通道语料统计的持久化 key（含 df / docCount / totalLen） */
const SPARSE_STATS_KEY = 'sparse:stats';

class IndexingService {
  /**
   * @param {object} [vectorStore] - 向量库实例（默认使用全局单例）
   * @param {object} [embeddingService] - embedding 服务（可选，避免重复加载模型）
   */
  constructor(vectorStore = null, embeddingService = null) {
    // 延迟解析默认单例：避免模块加载时的循环依赖
    this._getVectorStore = vectorStore
      ? () => vectorStore
      : () => require('./vector-store-qdrant.service').vectorStore;
    this.embeddingService = embeddingService || new EmbeddingService();
  }

  get vectorStore() { return this._getVectorStore(); }

  /** 最近一次 indexDocument 的复用统计 { reused, embedded, total }，供重索引接口展示 */
  get lastReuseStats() { return this._lastReuseStats || { reused: 0, embedded: 0, total: 0 }; }

  /** chunk 内容 hash：增量复用的对齐键（trim 归一化） */
  _contentHash(text) {
    return crypto.createHash('sha256').update(String(text || '').trim()).digest('hex');
  }

  /**
   * 取回文档现有向量并按内容 hash 建复用表
   * @returns {Promise<Map<string, {dense: number[], sparse: Object}> | null>}
   *          向量库不支持 getDocPoints 或取回失败时返回 null（退化为全量重算）
   */
  async _buildReuseMap(docId) {
    if (typeof this.vectorStore.getDocPoints !== 'function') return null;
    try {
      const oldPoints = await this.vectorStore.getDocPoints(docId);
      const map = new Map();
      for (const point of oldPoints) {
        if (!point?.dense?.length) continue;
        // Qdrant 线上 sparse 为 {indices, values}，归一化回 embedBatch 的 {dim: weight} map 形式
        let sparse = point.sparse || {};
        if (Array.isArray(sparse.indices)) {
          sparse = Object.fromEntries(sparse.indices.map((dim, i) => [dim, sparse.values[i]]));
        }
        map.set(this._contentHash(point.text), { dense: point.dense, sparse });
      }
      return map;
    } catch (err) {
      logEvent('warn', 'indexing_reuse_fetch_failed_full_recompute', { error: err.message });
      return null;
    }
  }

  // ==================== 文本分块（纯函数实现见 rag-chunker.js） ====================

  static get LIST_MARKER_RE() { return chunker.LIST_MARKER_RE; }
  static get FAQ_LINE_RE() { return chunker.FAQ_LINE_RE; }
  static get TABLE_SEPARATOR_RE() { return chunker.TABLE_SEPARATOR_RE; }

  _splitParagraphs(text) {
    return chunker.splitParagraphs(text);
  }

  _stripFrontmatter(text) {
    return chunker.stripFrontmatter(text);
  }

  _mergeBySection(paragraphs) {
    return chunker.mergeBySection(paragraphs);
  }

  _mergeBySectionHeadings(paragraphs, isHeading) {
    return chunker.mergeBySectionHeadings(paragraphs, isHeading);
  }

  _mergeShortParagraphs(paragraphs, minLen) {
    return chunker.mergeShortParagraphs(paragraphs, minLen);
  }

  _splitSentences(paragraph, targetMinLen) {
    return chunker.splitSentences(paragraph, targetMinLen);
  }

  _mergeShortSentences(sentences, targetMinLen) {
    return chunker.mergeShortSentences(sentences, targetMinLen);
  }

  _blockLines(paragraph) {
    return chunker.blockLines(paragraph);
  }

  _splitChildChunks(paragraph) {
    return chunker.splitChildChunks(paragraph);
  }

  _detectBlockType(paragraph) {
    return chunker.detectBlockType(paragraph);
  }

  _looksLikeFaq(lines) {
    return chunker.looksLikeFaq(lines);
  }

  _looksLikeList(lines) {
    return chunker.looksLikeList(lines);
  }

  _splitFaqChildren(paragraph) {
    return chunker.splitFaqChildren(paragraph);
  }

  _splitTableChildren(paragraph) {
    return chunker.splitTableChildren(paragraph);
  }

  _splitListChildren(paragraph) {
    return chunker.splitListChildren(paragraph);
  }

  /**
   * 索引单个文档（段落→句子双层切片 → 向量化子级 → 存储到 Qdrant）
   * @param {string} docId
   * @param {string} title
   * @param {string} content
   * @param {string} category
   * @param {Object} [options]
   * @param {Map|null} [options.oldVectors] - 内容 hash → 旧向量复用表（增量重索引用）
   */
  async indexDocument(docId, title, content, category = 'general', { oldVectors = null } = {}) {
    // 0. 语料统计必须在编码前就绪：稀疏权重里的 idf 依赖它，
    //    查询侧读的是同一份（持久化）统计，否则两侧错配
    await this._ensureSparseStatsLoaded();

    // 1~2. 段落（父级）→ 句子（子级）两层切片
    const { paragraphs, childChunks, metadatas, typeTally } = this._chunkDocument(docId, title, content, category);
    if (childChunks.length === 0) return 0;

    logEvent('info', 'indexing_doc_chunked', {
      paragraphs: paragraphs.length,
      childChunks: childChunks.length,
      faq: typeTally.faq,
      table: typeTally.table,
      list: typeTally.list,
    });

    // 3. 向量化子级：hash 命中旧向量直接复用，只对新增/变化的 chunk 调用模型
    const reused = new Array(childChunks.length).fill(null);
    const freshIdx = [];
    const freshTexts = [];
    if (oldVectors) {
      childChunks.forEach((text, i) => {
        const hit = oldVectors.get(this._contentHash(text));
        if (hit) reused[i] = hit;
        else freshIdx.push(i);
      });
    } else {
      freshIdx.push(...childChunks.map((_, i) => i));
    }

    if (freshIdx.length > 0) {
      freshIdx.forEach(i => freshTexts.push(childChunks[i]));
      const freshEmbeddings = await this.embeddingService.embedBatch(freshTexts);
      if (freshEmbeddings.some(e => !e?.dense)) {
        logEvent('warn', 'indexing_embed_failed_skip', { docId });
        return 0;
      }
      freshIdx.forEach((chunkIdx, j) => { reused[chunkIdx] = freshEmbeddings[j]; });
    }

    this._lastReuseStats = {
      reused: childChunks.length - freshIdx.length,
      embedded: freshIdx.length,
      total: childChunks.length,
    };
    if (oldVectors) {
      logEvent('info', 'indexing_incremental_reuse', { reused: childChunks.length - freshIdx.length, total: childChunks.length, recomputed: freshIdx.length });
    }

    // 4. 构造 point ID（docId_sent_i，确定性可重放）并存储
    const ids = childChunks.map((_, i) => `${docId}_sent_${i}`);

    await this.vectorStore.addChunks(ids, reused, childChunks, metadatas);
    logEvent('info', 'indexing_doc_done', { docId, vectorCount: childChunks.length });
    return childChunks.length;
  }

  /**
   * 段落 → 句子两层切片，返回子块文本与元数据。
   *
   * 抽成独立方法的原因：索引本身与稀疏通道的 df 预统计都要走**完全同一次**切片，
   * 各写一份的话，统计用的块和真正入库的块会悄悄漂移（df 与向量对不上）。
   *
   * @returns {{paragraphs: string[], childChunks: string[], metadatas: object[], typeTally: object}}
   */
  _chunkDocument(docId, title, content, category) {
    const paragraphs = this._splitParagraphs(content);
    const childChunks = [];
    const metadatas = [];
    const typeTally = { prose: 0, faq: 0, table: 0, list: 0 };

    for (let paraIdx = 0; paraIdx < paragraphs.length; paraIdx++) {
      const paraText = paragraphs[paraIdx];
      const { type, chunks: childTexts } = this._splitChildChunks(paraText);
      typeTally[type] += 1;

      for (const sentence of childTexts) {
        childChunks.push(sentence);
        metadatas.push({
          docId,
          parentId: `${docId}_para_${paraIdx}`,
          parentIdx: paraIdx,
          parentText: paraText,          // 父段落全文，检索时直接使用
          title,
          category,
          chunkIndex: metadatas.length,  // 句子级别的索引
        });
      }
    }

    if (childChunks.length === 0) {
      logEvent('warn', paragraphs.length ? 'indexing_skipped_empty_sentences' : 'indexing_skipped_empty_paragraphs', { docId });
    }

    return { paragraphs, childChunks, metadatas, typeTally };
  }

  /**
   * 注入的 embedding 服务是否具备语料统计能力。
   * 能力检测而非假设：替身/精简实现只保证 embedBatch，语料统计是可选增强，
   * 缺了它整套索引流程必须照常跑（稀疏权重退回纯 tf）。
   */
  get _sparseStatsSupported() {
    return typeof this.embeddingService?.buildSparseStats === 'function';
  }

  /**
   * 构建并激活稀疏通道的语料统计（df / 文档数 / 平均块长），随后持久化。
   *
   * 为什么必须持久化：idf 会被烤进文档侧稀疏向量，进程重启后查询侧必须能拿到
   * **同一份** idf；否则就成了"文档侧带 idf、查询侧不带"的错配，点积被系统性压低。
   *
   * @param {Array<{id:string,title:string,content:string,category:string}>} docs
   */
  async _rebuildSparseStats(docs) {
    if (!this._sparseStatsSupported) return null;

    const chunkTexts = [];
    for (const doc of docs) {
      const { childChunks } = this._chunkDocument(doc.id, doc.title, doc.content, doc.category);
      chunkTexts.push(...childChunks);
    }

    const stats = this.embeddingService.buildSparseStats(chunkTexts);
    setSparseStats(stats);
    logEvent('info', 'indexing_sparse_stats_built', {
      docCount: stats.docCount,
      terms: stats.df.size,
      avgLen: Number(stats.avgLen.toFixed(2)),
    });

    try {
      const { redis: store } = require('./memory-store');
      await store.hset(SPARSE_STATS_KEY, { stats: stats.toJSON(), updatedAt: Date.now() });
    } catch (err) {
      logEvent('warn', 'indexing_sparse_stats_persist_failed', { error: err.message });
    }

    return stats;
  }

  /**
   * 确保内存里有语料统计（进程重启后从持久化恢复）。
   * 拿不到就保持 null —— 此时文档侧与查询侧会一致退回纯 tf，不会单侧带 idf。
   */
  async _ensureSparseStatsLoaded() {
    if (!this._sparseStatsSupported || getSparseStats()) return;
    try {
      const { redis: store } = require('./memory-store');
      const raw = await store.hgetall(SPARSE_STATS_KEY);
      if (raw?.stats?.keys) {
        setSparseStats(SparseStats.fromJSON(raw.stats));
        logEvent('info', 'indexing_sparse_stats_loaded', {
          docCount: raw.stats.docCount || 0,
          terms: (raw.stats.keys || []).length,
        });
      }
    } catch (err) {
      logEvent('warn', 'indexing_sparse_stats_load_failed', { error: err.message });
    }
  }

  async removeDocument(docId) {
    await this.vectorStore.deleteByDocId(docId);
    logEvent('info', 'indexing_doc_deleted', { docId });
  }

  /**
   * 增量重索引：删除前先取回旧向量，文本未变的 chunk 复用 embedding
   */
  async reindexDocument(docId, title, content, category = 'general') {
    const oldVectors = await this._buildReuseMap(docId);
    await this.removeDocument(docId);
    return await this.indexDocument(docId, title, content, category, { oldVectors });
  }

  /**
   * 重建所有文档的索引
   * @param {Array} docs - 文档列表
   * @param {Object} [options]
   * @param {string} [options.mode='rebuild'] - rebuild: reset collection 后全量重建（修复/策略变更用）
   *                                            incremental: 逐文档 hash diff，未变 chunk 复用向量
   */
  async reindexAll(docs, { mode = 'rebuild' } = {}) {
    if (mode === 'incremental') {
      // 增量模式**不重建**统计：idf 一变，未变块复用的旧向量就与新查询向量错配。
      // 这里只确保统计就绪（进程重启后从持久化恢复），复用才是安全的。
      await this._ensureSparseStatsLoaded();
      logEvent('info', 'indexing_incremental_start', { docCount: docs.length });
      let totalChunks = 0;
      for (const doc of docs) {
        totalChunks += await this.reindexDocument(doc.id, doc.title, doc.content, doc.category);
      }
      const { reused, embedded } = this.lastReuseStats;
      logEvent('info', 'indexing_incremental_done', { totalChunks, reused, embedded });
      return totalChunks;
    }

    logEvent('info', 'indexing_full_rebuild_start', { docCount: docs.length });

    // 先统计、再编码：df 必须覆盖整个语料。边统计边编码的话，靠前的文档用的是
    // "只见过一部分语料"的 idf，同一个词在不同文档里权重不同，稀疏分数失去可比性。
    await this._rebuildSparseStats(docs);

    await this.vectorStore.resetCollection();

    let totalChunks = 0;
    for (const doc of docs) {
      const count = await this.indexDocument(doc.id, doc.title, doc.content, doc.category);
      totalChunks += count;
    }
    logEvent('info', 'indexing_full_rebuild_done', { totalChunks });
    return totalChunks;
  }
}

module.exports = { IndexingService };
