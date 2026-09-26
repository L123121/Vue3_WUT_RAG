"use strict";

const path = require('path');
const { RagService } = require('../services/rag/rag.service');
const { aiService } = require('../services/llm/ai.service');
const { DocumentService } = require('../services/knowledge/document.service');
const { redis: store } = require('../services/memory/memory-store.service');
const { MemoryService } = require('../services/memory/memory.service');
const { successResponse, errorResponse } = require('../utils/response');
const {
  createStreamContext,
  writeRunCompleted,
  writeRunFailed,
  writeRunStarted,
  writeStreamEvent,
} = require('../utils/sse-events');
const { upload, parseFile, cleanupFile } = require('../services/knowledge/file-upload.service');
const { recordAudit } = require('../services/agent/quality-governance.service');
const { vectorStore: vectorStoreSingleton } = require('../services/knowledge/vector-store-qdrant.service');
const { logEvent } = require('../services/observability/observability.service');

const ragService = new RagService(aiService);
const memoryService = new MemoryService();
const documentService = new DocumentService();
const FEEDBACK_RATINGS = new Set(['like', 'dislike']);
const FEEDBACK_TEXT_LIMIT = 4000;
const FEEDBACK_EVENT_LIMIT = 500;
const FEEDBACK_ALL_KEY = 'rag_feedback:all';
const FEEDBACK_ALL_EVENTS_KEY = 'rag_feedback_events:all';
// 反馈 → 评测集数据飞轮状态：queued = 已加入待导出队列（UI 一键操作）；
// exported = export-badcases.cjs 已写入评测数据集
const FEEDBACK_EVAL_STATUSES = new Set(['queued', 'exported']);

function saveChatMemory(userId, message, reply) {
  Promise.resolve(memoryService.saveChatMemory(userId, message, reply)).catch((error) => {
    logEvent('error', 'rag_memory_save_failed', { error: error.message });
  });
}

function truncateFeedbackText(value, limit = FEEDBACK_TEXT_LIMIT) {
  const text = String(value || '').trim();
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

function normalizeFeedbackSources(sources = []) {
  if (!Array.isArray(sources)) return [];
  return sources.slice(0, 8).map((source) => ({
    id: source.id ? String(source.id) : '',
    title: truncateFeedbackText(source.title, 160),
    category: source.category ? String(source.category) : '',
    score: Number.isFinite(Number(source.score)) ? Number(source.score) : null,
  }));
}

async function getAllFeedback() {
  const all = await store.hgetall(FEEDBACK_ALL_KEY);
  return Object.values(all || {}).map(parseFeedbackItem).filter(Boolean);
}

async function getFeedbackSummary() {
  const feedbackList = await getAllFeedback();
  const summary = feedbackList.reduce((acc, item) => {
    acc.total += 1;
    if (item.rating === 'like') acc.like += 1;
    if (item.rating === 'dislike') acc.dislike += 1;
    if (Array.isArray(item.sources) && item.sources.length > 0) acc.withSources += 1;
    return acc;
  }, { total: 0, like: 0, dislike: 0, withSources: 0 });
  return {
    ...summary,
    satisfactionRate: summary.total > 0 ? Math.round((summary.like / summary.total) * 1000) / 10 : null,
  };
}
async function trimFeedbackEvents(eventsKey) {
  if (typeof store.llen !== 'function' || typeof store.ltrim !== 'function') return;
  const length = await store.llen(eventsKey);
  if (length > FEEDBACK_EVENT_LIMIT) {
    await store.ltrim(eventsKey, length - FEEDBACK_EVENT_LIMIT, -1);
  }
}

function parseFeedbackItem(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function isAdminRequest(req) {
  return req.userId === 'admin';
}

function getTraceOptions(req, extra = {}) {
  return {
    ...extra,
    traceId: req.traceId,
    userId: req.userId,
    conversationId: req.body?.conversationId || req.get('x-conversation-id') || null,
  };
}

/**
 * 提取请求级阈值覆盖参数（A/B 评测用，正常用户请求不带这些字段不受影响）
 * 经 getTraceOptions 透传给 rag.service，由 _evalOverrides 校验后生效
 */
function getRerankOverrides(req) {
  const b = req.body || {};
  const overrides = {};
  for (const key of ['rerankMinScore', 'rerankDropoff', 'rerankTopK', 'maxContextLength']) {
    if (b[key] !== undefined && b[key] !== null && b[key] !== '') overrides[key] = b[key];
  }
  return overrides;
}

/**
 * RAG 增强聊天接口
 */
const ragChat = async (req, res, next) => {
  const abortController = new AbortController();
  const onClientClose = () => abortController.abort();
  res.once('close', onClientClose);
  try {
    const { message, history, category } = req.body;

    if (!message) {
      return errorResponse(res, '消息内容不能为空', 400);
    }

    const result = await ragService.chat(message, history || [], getTraceOptions(req, {
      category,
      ...getRerankOverrides(req),
      signal: abortController.signal,
    }));
    res.setHeader('X-Trace-Id', result.traceId || req.traceId);
    void recordAudit({
      question: message,
      answer: result.reply,
      sources: result.sources,
      traceId: result.traceId || req.traceId,
      userId: req.userId,
      route: 'rag-direct',
    }).catch((error) => logEvent('warn', 'quality_audit_record_failed', { scope: 'rag_non_stream', error: error.message }));
    successResponse(res, result, 'RAG 处理完成');
    saveChatMemory(req.userId, message, result.reply);
  } catch (error) {
    if (abortController.signal.aborted && error.name === 'AbortError') return;
    logEvent('error', 'rag_controller_error', { error: error.message, stack: error.stack });
    next(error);
  } finally {
    res.removeListener('close', onClientClose);
  }
};

/**
 * RAG 增强流式聊天接口
 */
const ragChatStream = async (req, res, next) => {
  let abortController = null;
  let onClientClose = null;
  let streamContext = null;
  const cleanupClientClose = () => {
    if (onClientClose) res.removeListener('close', onClientClose);
  };

  try {
    const body = req.body || {};
    const { message, history, category } = body;

    if (!message) {
      return res.status(400).json({ error: '消息内容不能为空' });
    }

    let fullReply = '';
    const audit = { sources: [], traceId: req.traceId };
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    streamContext = createStreamContext({
      streamVersion: body.streamVersion,
      runId: body.runId,
      attempt: body.attempt,
      traceId: req.traceId,
    });
    // 客户端断开 → 中止上游 LLM 流（注意监听 res 的 close，req 的 close 读完请求体即触发）
    abortController = new AbortController();
    onClientClose = () => abortController.abort();
    res.on('close', onClientClose);
    const streamOptions = getTraceOptions(req, {
      category,
      ...getRerankOverrides(req),
      signal: abortController.signal,
    });
    writeRunStarted(res, streamContext, { conversationId: streamOptions.conversationId });

    for await (const chunk of ragService.chatStream(message, history || [], streamOptions)) {
      // 评测审计副作用：在统一写出口之外就地采集（SSE 事件映射本身在 utils/sse-events.js）
      if (chunk.type === 'sources') {
        audit.sources = chunk.sources || [];
      } else if (chunk.type === 'trace' && chunk.trace?.traceId) {
        audit.traceId = chunk.trace.traceId;
      }
      if (chunk.type === 'content' && !chunk.done) fullReply += chunk.content || '';

      writeStreamEvent(res, chunk, streamContext);
    }

    writeRunCompleted(res, streamContext);
    cleanupClientClose();
    res.end();

    void recordAudit({
      question: message,
      answer: fullReply,
      sources: audit.sources,
      traceId: audit.traceId,
      userId: req.userId,
      route: 'rag-direct-stream',
    }).catch((error) => logEvent('warn', 'quality_audit_record_failed', { scope: 'rag_stream', error: error.message }));

    saveChatMemory(req.userId, message, fullReply);
  } catch (error) {
    cleanupClientClose();
    // 客户端已断开：不再向其写入错误事件
    if (abortController?.signal.aborted) return;
    logEvent('error', 'rag_stream_error', { error: error.message, stack: error.stack });
    if (!res.headersSent) return next(error);
    try {
      if (streamContext?.streamVersion === 1) writeRunFailed(res, streamContext, error);
      else res.write(`data: ${JSON.stringify({ traceId: req.traceId, error: error.message })}\n\n`);
      res.end();
    } catch {
      // 连接已关闭，忽略
    }
  }
};

/**
 * 提交 RAG 回答评价
 */
const submitFeedback = async (req, res, next) => {
  try {
    const {
      rating,
      messageId,
      conversationId,
      questionMessageId,
      question,
      answer,
      traceId,
      sources,
    } = req.body || {};

    if (!FEEDBACK_RATINGS.has(rating)) {
      return errorResponse(res, '评价类型无效', 400);
    }
    if (!messageId || !conversationId) {
      return errorResponse(res, '缺少消息或会话标识', 400);
    }

    const userId = req.userId || 'anonymous';
    const feedback = {
      id: `${conversationId}:${messageId}`,
      userId,
      conversationId: String(conversationId),
      messageId: String(messageId),
      questionMessageId: questionMessageId ? String(questionMessageId) : '',
      rating,
      question: truncateFeedbackText(question),
      answer: truncateFeedbackText(answer),
      traceId: traceId ? String(traceId) : '',
      sources: normalizeFeedbackSources(sources),
      createdAt: new Date().toISOString(),
    };

    const feedbackKey = `rag_feedback:${userId}`;
    const eventsKey = `rag_feedback_events:${userId}`;
    const feedbackEvent = {
      ...feedback,
      eventId: `feedback_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    };

    await store.hset(feedbackKey, feedback.id, feedback);
    await store.hset(FEEDBACK_ALL_KEY, `${userId}:${feedback.id}`, feedback);
    await store.rpush(eventsKey, JSON.stringify(feedbackEvent));
    await store.rpush(FEEDBACK_ALL_EVENTS_KEY, JSON.stringify(feedbackEvent));
    await trimFeedbackEvents(eventsKey);
    await trimFeedbackEvents(FEEDBACK_ALL_EVENTS_KEY);

    successResponse(res, { feedbackId: feedback.id, rating: feedback.rating }, '评价已记录');
  } catch (error) {
    logEvent('error', 'rag_feedback_submit_failed', { error: error.message, stack: error.stack });
    next(error);
  }
};

/**
 * 管理员查询 RAG 回答评价
 */
const listFeedback = async (req, res, next) => {
  try {
    if (!isAdminRequest(req)) {
      return errorResponse(res, '仅管理员可查看反馈', 403);
    }

    const {
      rating,
      q = '',
      page = 1,
      limit = 20,
    } = req.query || {};
    const pageNumber = Math.max(parseInt(page, 10) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 200);
    const keyword = String(q || '').trim().toLowerCase();

    // 注意括号位置：必须先 await 取到数组再链式 filter（此前误将 .filter 链在 Promise 上导致 500）
    const feedbackList = (await getAllFeedback())
      .filter((item) => !rating || item.rating === rating)
      .filter((item) => {
        if (!keyword) return true;
        const haystack = [
          item.userId,
          item.question,
          item.answer,
          item.traceId,
          item.conversationId,
          ...(item.sources || []).map((source) => source.title || source.category || ''),
        ].join(' ').toLowerCase();
        return haystack.includes(keyword);
      })
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    const total = feedbackList.length;
    const start = (pageNumber - 1) * pageSize;
    const items = feedbackList.slice(start, start + pageSize);
    const summary = feedbackList.reduce((acc, item) => {
      acc.total += 1;
      if (item.rating === 'like') acc.like += 1;
      if (item.rating === 'dislike') acc.dislike += 1;
      if (item.evalStatus === 'queued') acc.evalQueued += 1;
      if (item.evalStatus === 'exported') acc.evalExported += 1;
      return acc;
    }, { total: 0, like: 0, dislike: 0, evalQueued: 0, evalExported: 0 });

    successResponse(res, {
      items,
      summary,
      pagination: {
        page: pageNumber,
        limit: pageSize,
        total,
        totalPages: Math.max(Math.ceil(total / pageSize), 1),
      },
    }, '获取反馈成功');
  } catch (error) {
    logEvent('error', 'rag_feedback_query_failed', { error: error.message, stack: error.stack });
    next(error);
  }
};

/**
 * 管理员更新反馈的评测集状态（反馈 → 评测集数据飞轮）：
 * 点踩反馈一键入队，导出脚本回写 exported，线上坏例形成回归覆盖闭环
 */
const updateFeedbackEvalStatus = async (req, res, next) => {
  try {
    if (!isAdminRequest(req)) {
      return errorResponse(res, '仅管理员可更新评测状态', 403);
    }

    const { userId, feedbackId, status } = req.body || {};
    if (!userId || !feedbackId) {
      return errorResponse(res, '缺少用户或反馈标识', 400);
    }
    if (!FEEDBACK_EVAL_STATUSES.has(status)) {
      return errorResponse(res, '评测状态无效', 400);
    }

    const userFeedback = await store.hgetall(`rag_feedback:${userId}`);
    const existing = userFeedback ? userFeedback[feedbackId] : null;
    if (!existing) {
      return errorResponse(res, '反馈不存在', 404);
    }

    const updated = {
      ...existing,
      evalStatus: status,
      evalStatusAt: new Date().toISOString(),
    };
    await store.hset(`rag_feedback:${userId}`, feedbackId, updated);
    await store.hset(FEEDBACK_ALL_KEY, `${userId}:${feedbackId}`, updated);

    successResponse(res, { feedbackId, evalStatus: status }, status === 'queued' ? '已加入评测集候选' : '已标记为已导出');
  } catch (error) {
    logEvent('error', 'rag_feedback_status_update_failed', { error: error.message, stack: error.stack });
    next(error);
  }
};

/**
 * RAG 离线评估检索接口：只返回 TopN 子句聚合后的父段候选，不调用 LLM 生成
 */
const retrieveParentCandidates = async (req, res, next) => {
  try {
    const { message, query, category, childTopK = 25, parentTopK = 0, includeChildren = true } = req.body;
    const searchQuery = message || query;

    if (!searchQuery) {
      return errorResponse(res, '检索 Query 不能为空', 400);
    }

    const result = await ragService.retrieveParentCandidates(searchQuery, getTraceOptions(req, {
      category,
      childTopK,
      parentTopK,
      includeChildren,
    }));
    res.setHeader('X-Trace-Id', result.traceId || req.traceId);

    successResponse(res, result, '检索候选获取完成');
  } catch (error) {
    logEvent('error', 'rag_retrieval_eval_failed', { error: error.message, stack: error.stack });
    next(error);
  }
};

/**
 * 添加文档
 */
const addDocument = async (req, res, next) => {
  try {
    const { title, content, category, metadata } = req.body;

    if (!content) {
      return errorResponse(res, '文档内容不能为空', 400);
    }

    const result = await documentService.addDocument({
      title: title || '未命名文档',
      content,
      category: category || 'general',
      metadata
    });

    successResponse(res, result, '文档添加成功');
  } catch (error) {
    logEvent('error', 'document_add_failed', { error: error.message, stack: error.stack });
    next(error);
  }
};

/**
 * 删除文档
 */
const deleteDocument = async (req, res, next) => {
  try {
    const { id } = req.params;
    const result = await documentService.deleteDocument(id);
    successResponse(res, result, '文档删除成功');
  } catch (error) {
    logEvent('error', 'document_delete_failed', { error: error.message, stack: error.stack });
    next(error);
  }
};

/**
 * 获取文档列表
 */
const listDocuments = async (req, res, next) => {
  try {
    const { category, page, limit } = req.query;
    const result = await documentService.listDocuments({
      category,
      page: parseInt(page) || 1,
      limit: parseInt(limit) || 20
    });
    successResponse(res, result, '获取成功');
  } catch (error) {
    logEvent('error', 'document_list_failed', { error: error.message, stack: error.stack });
    next(error);
  }
};

/**
 * 获取文档详情
 */
const getDocument = async (req, res, next) => {
  try {
    const { id } = req.params;
    const result = await documentService.getDocument(id);

    if (!result) {
      return errorResponse(res, '文档不存在', 404);
    }

    successResponse(res, result, '获取成功');
  } catch (error) {
    logEvent('error', 'document_detail_failed', { error: error.message, stack: error.stack });
    next(error);
  }
};

/**
 * 获取知识库统计
 */
const getStats = async (req, res, _next) => {
  try {
    const docCount = await store.scard('documents:all');
    // 向量条数反映向量库实际状态（而非文档元数据），供前端诚实展示检索可用性
    let vectorCount = 0;
    try {
      vectorCount = (await vectorStoreSingleton.count()) || 0;
    } catch {
      vectorCount = 0;
    }

    successResponse(res, {
      documents: {
        count: docCount
      },
      vectors: {
        count: vectorCount
      }
    }, '获取成功');
  } catch (error) {
    logEvent('error', 'rag_stats_failed', { error: error.message, stack: error.stack });
    successResponse(res, {
      documents: { count: 0 },
      vectors: { count: 0 }
    }, '获取成功');
  }
};

/**
 * 上传文件并添加到知识库
 */
const uploadDocument = async (req, res, next) => {
  let filePath = null;

  try {
    if (!req.file) {
      return errorResponse(res, '请上传文件', 400);
    }

    filePath = req.file.path;
    const originalName = req.file.originalname;
    const category = req.body.category || 'general';

    logEvent('info', 'file_upload_parse_start', { file: originalName });

    // 解析文件内容
    const content = await parseFile(filePath, originalName);

    if (!content || content.trim().length === 0) {
      return errorResponse(res, '文件内容为空或无法解析', 400);
    }

    const title = req.body.title || path.basename(originalName, path.extname(originalName));

    const result = await documentService.addDocument({
      title,
      content: content.trim(),
      category,
      metadata: {
        sourceFile: originalName,
        fileType: path.extname(originalName).toLowerCase()
      }
    });

    logEvent('info', 'file_upload_parse_done', { file: originalName, chunkCount: result.chunkCount });

    successResponse(res, {
      ...result,
      sourceFile: originalName,
      contentLength: content.length
    }, result.message || '文件上传成功');
  } catch (error) {
    logEvent('error', 'file_upload_failed', { error: error.message, stack: error.stack });
    next(error);
  } finally {
    if (filePath) {
      cleanupFile(filePath);
    }
  }
};

const uploadMiddleware = upload.single('file');
let reindexPromise = null;

const reindexDocuments = async (req, res, next) => {
  if (reindexPromise) return errorResponse(res, '已有重索引任务正在运行，请稍后再试', 409);
  const mode = req.body?.mode === 'incremental' ? 'incremental' : 'rebuild';
  reindexPromise = (async () => {
    const docs = await documentService._allDocs();
    documentService._markCorpusChanged('reindex_start', 'all');
    const totalChunks = await documentService.indexingService.reindexAll(docs, { mode });
    return { mode, documents: docs.length, totalChunks };
  })();
  try {
    const result = await reindexPromise;
    successResponse(res, result, '重索引完成');
  } catch (error) {
    logEvent('error', 'document_reindex_failed', { mode, error: error.message, stack: error.stack });
    next(error);
  } finally {
    reindexPromise = null;
  }
};

module.exports = {
  ragChat,
  ragChatStream,
  submitFeedback,
  listFeedback,
  updateFeedbackEvalStatus,
  getFeedbackSummary,
  retrieveParentCandidates,
  addDocument,
  deleteDocument,
  listDocuments,
  getDocument,
  getStats,
  uploadDocument,
  uploadMiddleware,
  reindexDocuments,
};



