"use strict";

const { metrics } = require('../observability/metrics.service');
const { logEvent } = require('../observability/observability.service');
const ragRetrieval = require('./rag-retrieval.service');
const contextBuilder = require('./rag-context-builder.service');

/**
 * RAG 检索管道编排：文档检查 → 多变体检索 → 子句选择 → 父段处理 → 上下文组装。
 * 从 rag.service 拆出；函数第一个参数为 RagService 实例（svc），
 * 内部仍通过 svc 派发（如 svc.selectTopChunks），保证测试 mock 与运行时覆盖行为不变。
 */

/**
 * 父段处理：子块按父段聚合 → cross-encoder rerank → 自适应截断 → MMR 去重
 * → (docId, parentIdx) 二级排序 → 上下文组装
 *
 * @returns {Promise<{ context: string, sources: Array }>}
 */
async function buildParentContext(svc, message, topChunks, options, tracer) {
  // 1. 子句按父段落聚合
  const paraMap = contextBuilder.groupChunksByParent(topChunks);
  let parentCandidates = [...paraMap.values()];

  // 2. cross-encoder rerank 父段落
  if (svc.rerankEnabled && parentCandidates.length > 1) {
    const RERANK_MAX_INPUT = 20;
    parentCandidates.sort((a, b) => (b.bestChunk?.score || 0) - (a.bestChunk?.score || 0));
    const rerankCandidates = parentCandidates.slice(0, RERANK_MAX_INPUT);
    const rerankInput = rerankCandidates.map(m => ({
      text: m.parentText || m.bestChunk?.text || '',
      score: m.bestChunk?.score || 0,
      _match: m,
    }));
    const parentRerankStart = Date.now();
    const allRanked = await svc.rerankerService.rerank(message, rerankInput, parentCandidates.length);
    svc._recordTraceStage(tracer, 'rerank', parentRerankStart, true, {
      inputCount: rerankInput.length,
      outputCount: allRanked.length,
      model: allRanked[0]?._rerankModel || 'bge-reranker-base',
    });
    parentCandidates = allRanked.map(r => ({ ...r._match, _rerankScore: r._rerankScore, _rerankModel: r._rerankModel }));
  }

  // 3. 自适应截断
  const truncateOverrides = svc._evalOverrides(options);
  parentCandidates = svc._adaptiveTruncate(parentCandidates, svc.rerankTopK, message, truncateOverrides);

  // 3.5 MMR 去重
  const mmrStart = Date.now();
  const beforeDedup = parentCandidates.length;
  parentCandidates = svc._mmrDedupe(parentCandidates, svc.rerankTopK);
  if (parentCandidates.length < beforeDedup) {
    logEvent('info', 'rag_mmr_dedupe', { before: beforeDedup, after: parentCandidates.length });
  }
  svc._recordTraceStage(tracer, 'parent_dedup', mmrStart, true, {
    before: beforeDedup,
    after: parentCandidates.length,
    method: 'mmr',
  });

  // 4. 按 (docId, parentIdx) 二级排序
  parentCandidates.sort((a, b) => {
    const docCmp = (a.docId || '').localeCompare(b.docId || '');
    if (docCmp !== 0) return docCmp;
    return (a.parentIdx ?? 0) - (b.parentIdx ?? 0);
  });

  // 5. 组装上下文（由 maxContextLength 控制长度）
  const { context, sources } = await svc._buildContextFromParents(parentCandidates, truncateOverrides);

  return { context, sources };
}

/**
 * 统一 RAG 管道编排:文档检查 → 检索 → rerank → 父段处理 → 上下文组装
 *
 * @param {RagService} svc - RagService 实例
 * @param {string} message - 用户消息
 * @param {Array} history - 历史消息
 * @param {Object} options - 选项
 * @param {RagTracer} options.tracer - tracer 实例
 * @param {Function} [options.onEvent] - 流式回调,收到事件时调用 ({type, ...data})
 * @returns {Promise<Object>} { context, sources, topChunks, retrieval, questionType, rewrittenQuery, hasReliableCandidates }
 */
async function runRAGPipeline(svc, message, history = [], options = {}) {
  const { onEvent, tracer } = options;
  const totalStart = Date.now();
  const questionType = svc.classifyQuestion(message);

  // 文档检查
  const docsStart = Date.now();
  const hasDocs = await svc.documentService.hasDocuments(options.category);
  svc._recordTraceStage(tracer, 'document_check', docsStart, true, {
    docCount: hasDocs ? 1 : 0,
    category: options.category || null,
  });

  if (!hasDocs) {
    tracer?.markFallback('no_documents');
    if (tracer) tracer.finish({ usedRag: false, fallbackReason: 'no_documents' });
    return {
      context: '',
      sources: [],
      topChunks: [],
      retrieval: { channels: [], hasResults: false },
      questionType,
      rewrittenQuery: '',
      hasReliableCandidates: false,
      fallbackReason: 'no_documents',
    };
  }

  // 检索
  const { candidates, trace, rewrittenQuery } = await ragRetrieval.dualRetrieve(svc, message, history, options);

  if (!svc._hasReliableCandidates(candidates)) {
    const retrievalSummary = svc._summarizeRetrievalTrace(trace);
    tracer?.setRetrieval(retrievalSummary);
    tracer?.markFallback('no_reliable_sources');
    svc._recordTraceStage(tracer, 'total', totalStart, true, {
      usedRag: true,
      matchedDocs: 0,
      retrievedChunks: 0,
    });

    if (onEvent) {
      onEvent({ type: 'retrieval', retrieval: retrievalSummary, questionType, rewrittenQuery });
      onEvent({ type: 'no_reliable_sources', reply: svc._buildNoReliableSourcesReply() });
    }

    return {
      context: '',
      sources: [],
      topChunks: [],
      retrieval: retrievalSummary,
      questionType,
      rewrittenQuery,
      hasReliableCandidates: false,
      fallbackReason: 'no_reliable_sources',
    };
  }

  if (onEvent) {
    const retrievalSummary = svc._summarizeRetrievalTrace(trace);
    tracer?.setRetrieval(retrievalSummary);
    onEvent({ type: 'retrieval', retrieval: retrievalSummary, questionType, rewrittenQuery });
  }

  // 子句选择
  const rerankStart = Date.now();
  const topChunks = await svc.selectTopChunks(message, candidates);
  const childSelectLatency = Date.now() - rerankStart;
  metrics.recordLatency('rerank', childSelectLatency);
  svc._recordTraceStage(tracer, 'child_select', rerankStart, true, {
    inputCount: candidates.length,
    outputCount: topChunks.length,
  });

  // 父段处理
  let enhancedContext = '';
  let parentSources = [];
  if (svc.parentChildEnabled && topChunks.length > 0) {
    const pcStart = Date.now();
    try {
      const built = await buildParentContext(svc, message, topChunks, options, tracer);
      enhancedContext = built.context;
      parentSources = built.sources;

      metrics.recordLatency('parentChild', Date.now() - pcStart);
      svc._recordTraceStage(tracer, 'parent_child', pcStart, true, {
        inputChunks: topChunks.length,
        parentCount: parentSources.length,
        contextLength: enhancedContext.length,
      });
    } catch (err) {
      svc._recordTraceStage(tracer, 'parent_child', Date.now(), false, {}, err);
      logEvent('warn', 'rag_parent_child_failed', { error: err.message });
    }
  }

  const retrievalSummary = svc._summarizeRetrievalTrace(trace);
  svc._recordTraceStage(tracer, 'total', totalStart, true, {
    usedRag: true,
    matchedDocs: parentSources.length,
    retrievedChunks: topChunks.length,
  });

  if (onEvent) {
    onEvent({ type: 'sources', sources: parentSources.length > 0 ? parentSources : topChunks.slice(0, svc.rerankTopK).map(c => svc._chunkToSource(c)) });
  }

  return {
    context: enhancedContext,
    sources: parentSources,
    topChunks,
    retrieval: retrievalSummary,
    questionType,
    rewrittenQuery,
    hasReliableCandidates: true,
  };
}

module.exports = { runRAGPipeline };
