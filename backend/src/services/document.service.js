"use strict";

const { logEvent } = require('./observability.service');

const crypto = require('crypto');
const { redis: store } = require('./memory-store');
const config = require('../config');
const { sanitizeDocument } = require('./doc-sanitizer.service');
const { cleanHeaderFooter } = require('./header-footer-cleaner.service');
const { normalizeCharacters, mergeHardLineBreaks } = require('./text-normalizer.service');
const { deriveDocId } = require('../utils/doc-id');

const VECTOR_STATUS = Object.freeze({
  LOCAL_ONLY: 'local_only',
  INDEXING: 'indexing',
  READY: 'ready',
  FAILED: 'failed',
});

class DocumentService {
  constructor(options = {}) {
    this.store = options.store || store;
    // 延迟初始化：避免模块加载时的循环依赖
    this._indexing = options.indexingService || null;
    this._providerRegistered = false;
  }

  // 延迟获取 IndexingService（首次用时才 require）
  get indexingService() {
    if (!this._indexing) {
      const { IndexingService } = require('./indexing.service');
      // 传入全局向量库单例，保证索引写入同一个实例
      const { vectorStore } = require('./vector-store-qdrant.service');
      this._indexing = new IndexingService(vectorStore);
      if (!this._providerRegistered) {
        const { registerDocumentProvider } = require('./vector-store-qdrant.service');
        registerDocumentProvider(() => this._allDocs());
        this._providerRegistered = true;
      }
    }
    return this._indexing;
  }

  /**
   * 返回所有文档的索引信息（供向量库重建用）
   */
  async _allDocs() {
    const docIds = await this.store.smembers('documents:all');
    const pipeline = this.store.pipeline();
    docIds.forEach(id => pipeline.hgetall(`document:${id}`));
    const results = await pipeline.exec();
    return results
      .map(([, data]) => data)
      .filter(d => d && d.id)
      .map(d => ({ id: d.id, title: d.title, content: d.content, category: d.category }));
  }

  /**
   * 内容归一化 sha256：trim + 空白折叠后哈希（格式微调不产生重复向量）
   */
  _contentHash(content) {
    const normalized = String(content || '').replace(/\s+/g, ' ').trim();
    return crypto.createHash('sha256').update(normalized).digest('hex');
  }

  /** 哈希索引 key：set 成员为使用该内容的 docId */
  _hashKey(contentHash) {
    return `documents:hash:${contentHash}`;
  }

  /**
   * 添加文档到知识库（清洗 → 去重检查 → 切片 → 向量化 → Qdrant 存储）
   * @param {Object} doc
   * @param {Object} [options]
   * @param {boolean} [options.force=false] - 跳过内容去重强制入库
   */
  async addDocument(doc, options = {}) {
    let { title, content, category = 'general', metadata = {} } = doc;

    if (!content || content.trim().length === 0) {
      throw new Error('文档内容不能为空');
    }

    // ===== 入库清洗管线（顺序固定）=====
    // ① 字符级去脏（全角数字转半角后，页眉页脚规则法的 \d 才匹配"第３页"）
    // ② 注入过滤 + 乱码闸门：必须在断行合并之前——注入行若被并入正文行，
    //    整行替换会连正文一起误伤
    // ③ 页眉页脚删除（结构消歧；断行合并前做，否则页眉行被拼进正文后位置法失效）
    // ④ 断行合并。清洗只在这里做一遍，之后 embedding 与上下文用的都是同一份文本
    const normalizeEnabled = config.docNormalize?.enabled !== false;
    let normalizeReport = null;
    if (normalizeEnabled) {
      const norm = normalizeCharacters(content);
      if (norm.report.totalReplaced > 0) {
        logEvent('info', 'document_sanitize_normalized', { replaced: norm.report.totalReplaced, garbage: norm.report.garbageReplaced + norm.report.mojibakeReplaced });
        normalizeReport = {
          fullwidth: norm.report.fullwidth,
          whitespace: norm.report.whitespace,
          bom: norm.report.bom,
          control: norm.report.control,
          garbageReplaced: norm.report.garbageReplaced + norm.report.mojibakeReplaced,
        };
      }
      content = norm.content;
    }

    // 注入过滤 + 乱码占比检查
    const { content: sanitizedContent, report } = sanitizeDocument(content);
    if (report.enabled && report.qualityLevel === 'reject') {
      const rejectRatio = config.docSanitize?.rejectUnkRatio ?? 0.15;
      throw new Error(
        `文档质量检查未通过：乱码/坏字符占比 ${(report.garbageRatio * 100).toFixed(1)}%` +
        ` 超过阈值 ${(rejectRatio * 100).toFixed(0)}%，已拒绝入库`,
      );
    }
    if (report.injectionLines > 0) {
      logEvent('warn', 'document_injection_filtered', { lines: report.injectionLines, hits: report.injectionHits.slice(0, 5) });
    }
    if (report.qualityLevel === 'warn') {
      logEvent('warn', 'document_garbage_ratio_high', { ratioPercent: (report.garbageRatio * 100).toFixed(2), message: '文档乱码占比偏高（已入库，建议人工复核）' });
    }
    if (report.injectionLines > 0 || report.garbageRatio > 0) {
      metadata = { ...metadata, sanitizeReport: { injectionLines: report.injectionLines, garbageRatio: report.garbageRatio, qualityLevel: report.qualityLevel } };
    }
    if (normalizeReport) {
      metadata = { ...metadata, normalizeReport };
    }
    content = sanitizedContent;

    // 页眉页脚删除（结构消歧），顺带让"仅页码不同"的两份文档哈希一致、去重生效
    const cleanEnabled = config.docClean?.enabled !== false;
    if (cleanEnabled) {
      const cleaned = cleanHeaderFooter(content);
      if (cleaned.report.removedRuleLines + cleaned.report.removedPositionLines > 0) {
        logEvent('info', 'document_header_footer_cleaned', {
          removedRuleLines: cleaned.report.removedRuleLines,
          removedPositionLines: cleaned.report.removedPositionLines,
          pages: cleaned.report.pages,
        });
        metadata = {
          ...metadata,
          cleanReport: {
            pages: cleaned.report.pages,
            removedRuleLines: cleaned.report.removedRuleLines,
            removedPositionLines: cleaned.report.removedPositionLines,
            headerSamples: cleaned.report.headerSamples,
            footerSamples: cleaned.report.footerSamples,
          },
        };
      }
      content = cleaned.content;
    }

    // 断行合并（最后一步）：此时页眉页脚已删、注入行已替换，合并不会再污染正文
    if (normalizeEnabled) {
      const merged = mergeHardLineBreaks(content);
      if (merged.report.merged > 0) {
        logEvent('info', 'document_lines_merged', { merged: merged.report.merged });
        // merge 步骤本身可能产生第一份 normalizeReport（无可替换字符但有断行），
        // 赋值后必然非空，直接落库
        normalizeReport = { ...normalizeReport, mergedLines: merged.report.merged };
        metadata = { ...metadata, normalizeReport };
      }
      content = merged.content;
    }

    // ===== 内容去重：同内容文档直接返回已有记录，不再产生重复向量 =====
    const dedupEnabled = config.document?.dedupEnabled !== false && !options.force;
    const contentHash = this._contentHash(content);
    if (dedupEnabled) {
      const duplicate = await this._findDuplicate(contentHash);
      if (duplicate) {
        logEvent('info', 'document_duplicate_skipped', { id: duplicate.id, title: duplicate.title });
        return {
          id: duplicate.id,
          title: duplicate.title,
          chunkCount: parseInt(duplicate.chunkCount) || 0,
          indexedChunkCount: parseInt(duplicate.indexedChunkCount) || 0,
          vectorStatus: duplicate.vectorStatus || VECTOR_STATUS.READY,
          vectorMessage: duplicate.vectorMessage || '',
          message: `检测到内容重复：知识库已有《${duplicate.title}》(${duplicate.id})，本次未重复入库`,
          duplicate: true,
          existingDocId: duplicate.id,
        };
      }
    }

    // 确定性 docId：由 (标题, 类别) 派生，同一文档重新入库得到同一 ID，
    // 评测数据集里硬编码的 relevant_doc_ids 才有可复现的可能（见 utils/doc-id.js）
    const docId = deriveDocId(title, category);
    const now = Date.now();

    const docMetadata = {
      id: docId,
      title,
      category,
      content,
      contentLength: content.length,
      // 占位 0，索引完成后由 indexDocument 返回的真实切片数覆盖
      chunkCount: 0,
      contentHash,
      createdAt: now,
      vectorStatus: VECTOR_STATUS.INDEXING,
      vectorMessage: '正在建立向量索引',
      vectorUpdatedAt: now,
      metadata: JSON.stringify(metadata),
    };

    await this.store.hset(`document:${docId}`, docMetadata);
    await this.store.sadd('documents:all', docId);
    if (dedupEnabled) {
      await this.store.sadd(this._hashKey(contentHash), docId);
    }

    // 覆盖语义：同一 (标题, 类别) 会派生出同一 docId，重建前必须清掉旧向量，
    // 否则内容变短时旧的 `docId_sent_N` 会残留并继续被检索命中。
    // 清理失败只告警不阻塞索引（首个入库场景本就没有旧点）。
    try {
      await this.indexingService.removeDocument(docId);
    } catch (err) {
      logEvent('warn', 'document_stale_vectors_cleanup_failed', { docId, error: err.message });
    }

    const indexPromise = this.indexingService.indexDocument(docId, title, content, category)
      .then(async indexedChunkCount => {
        if (!Number.isFinite(indexedChunkCount) || indexedChunkCount <= 0) {
          throw new Error('未生成可用向量');
        }

        const vectorMessage = `已生成 ${indexedChunkCount} 个向量`;
        await this.store.hset(`document:${docId}`, {
          vectorStatus: VECTOR_STATUS.READY,
          vectorMessage,
          vectorUpdatedAt: Date.now(),
          indexedChunkCount,
          chunkCount: indexedChunkCount,
        });
        logEvent('info', 'document_vector_index_done', { docId, chunks: indexedChunkCount });
        return {
          vectorStatus: VECTOR_STATUS.READY,
          vectorMessage,
          indexedChunkCount,
        };
      })
      .catch(async err => {
        const vectorMessage = err.message || '向量索引失败';
        await this.store.hset(`document:${docId}`, {
          vectorStatus: VECTOR_STATUS.FAILED,
          vectorMessage,
          vectorUpdatedAt: Date.now(),
        });
        logEvent('error', 'document_vector_index_failed', { docId, message: vectorMessage });
        return {
          vectorStatus: VECTOR_STATUS.FAILED,
          vectorMessage,
          indexedChunkCount: 0,
        };
      });

    // 最多等待 30 秒；超时后索引仍在后台继续，并会最终更新文档状态
    let timeoutId;
    const outcome = await Promise.race([
      indexPromise,
      new Promise(resolve => {
        timeoutId = setTimeout(() => resolve({
          vectorStatus: VECTOR_STATUS.INDEXING,
          vectorMessage: '索引仍在后台处理中，请稍后刷新确认',
          indexedChunkCount: 0,
        }), 30000);
      }),
    ]);
    if (timeoutId) clearTimeout(timeoutId);

    return {
      id: docId,
      title,
      chunkCount: outcome.indexedChunkCount || 0,
      indexedChunkCount: outcome.indexedChunkCount,
      vectorStatus: outcome.vectorStatus,
      vectorMessage: outcome.vectorMessage,
      message: outcome.vectorStatus === VECTOR_STATUS.READY
        ? '文档添加成功，向量索引已完成'
        : '文档已保存，但向量索引尚未完成',
    };
  }

  /**
   * 按内容哈希查找仍存活（未删除）的重复文档
   */
  async _findDuplicate(contentHash) {
    try {
      const ids = await this.store.smembers(this._hashKey(contentHash));
      for (const id of ids || []) {
        const meta = await this.store.hgetall(`document:${id}`);
        if (meta && meta.id) return meta;
      }
    } catch (err) {
      logEvent('warn', 'document_dedup_check_failed_ignored', { error: err.message });
    }
    return null;
  }

  async deleteDocument(docId) {
    const docMeta = await this.store.hgetall(`document:${docId}`);
    if (!docMeta || !docMeta.id) {
      throw new Error('文档不存在');
    }

    // 异步删除向量索引（不阻塞响应）
    this.indexingService.removeDocument(docId).catch(err => {
      logEvent('warn', 'document_vector_index_delete_failed', { docId, error: err.message });
    });

    // 清理内容哈希索引，避免删除后同内容文档被误判为重复
    if (docMeta.contentHash) {
      await this.store.srem(this._hashKey(docMeta.contentHash), docId).catch(() => {});
    }

    await this.store.del(`document:${docId}`);
    await this.store.srem('documents:all', docId);

    return { message: '文档删除成功', docId };
  }

  /**
   * 轻量判断文档库是否为空（无分类时用 scard，避免 listDocuments 的全量读取）
   */
  async hasDocuments(category) {
    if (!category) {
      return (await this.store.scard('documents:all')) > 0;
    }
    const docs = await this.listDocuments({ category, limit: 1 });
    return docs.documents.length > 0;
  }

  async listDocuments(options = {}) {
    const { category, page = 1, limit = 20 } = options;

    const docIds = await this.store.smembers('documents:all');

    const pipeline = this.store.pipeline();
    docIds.forEach(id => pipeline.hgetall(`document:${id}`));
    const results = await pipeline.exec();

    let documents = results
      .map(([, data]) => data)
      .filter(d => d && d.id)
      .map(d => this._normalizeDocMeta(d, { includeContent: false }));

    if (category) {
      documents = documents.filter(d => d.category === category);
    }

    documents.sort((a, b) => b.createdAt - a.createdAt);

    const total = documents.length;
    const start = (page - 1) * limit;
    const end = start + limit;
    documents = documents.slice(start, end);

    return {
      documents,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  async getDocument(docId) {
    const docMeta = await this.store.hgetall(`document:${docId}`);
    if (!docMeta || !docMeta.id) return null;

    return this._normalizeDocMeta(docMeta, { includeContent: true });
  }

  // ==================== 内部方法 ====================

  _normalizeDocMeta(docMeta, { includeContent = false } = {}) {
    const doc = {
      id: docMeta.id,
      title: docMeta.title,
      category: docMeta.category,
      contentLength: parseInt(docMeta.contentLength) || 0,
      chunkCount: parseInt(docMeta.chunkCount) || 0,
      vectorStatus: docMeta.vectorStatus || VECTOR_STATUS.LOCAL_ONLY,
      vectorMessage: docMeta.vectorMessage || '',
      vectorUpdatedAt: docMeta.vectorUpdatedAt
        ? new Date(parseInt(docMeta.vectorUpdatedAt))
        : null,
      createdAt: new Date(parseInt(docMeta.createdAt)),
      metadata: docMeta.metadata ? this._parseMetadata(docMeta.metadata) : {},
    };

    if (includeContent) {
      doc.content = docMeta.content || '';
    }

    return doc;
  }

  _parseMetadata(raw) {
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }
}

module.exports = { DocumentService, VECTOR_STATUS };
