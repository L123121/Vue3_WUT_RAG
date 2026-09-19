"use strict";

const config = require('../config');
const { metrics } = require('./metrics.service');
const { logEvent } = require('./observability.service');
const { decomposeQuery } = require('./query-decompose.service');
const resultMapper = require('./rag-result-mapper.service');
const queryRewrite = require('./rag-query-rewrite.service');
const { QueryCache } = require('../utils/query-cache');
const { SemanticCache } = require('./rag-semantic-cache.service');

// 检索结果缓存（模块级单例）：tracer/noCache/category 存在时不缓存
const retrievalCache = new QueryCache(
  config.rag.cacheMaxEntries || 500,
  config.rag.cacheTtlMs || 300000,
);

// 语义缓存（模块级单例）：按查询向量余弦相似度复用近义问题的检索候选池
const semanticCache = new SemanticCache({
  maxEntries: config.rag.semanticCacheMaxEntries || 200,
  ttlMs: config.rag.cacheTtlMs || 300000,
  threshold: config.rag.semanticCacheThreshold || 0.95,
});

/**
 * 检索管道：向量召回（Qdrant 混合检索）→ 父段聚合 → 多路检索合并。
 * 从 rag.service 拆出；函数第一个参数为 RagService 实例（svc），
 * 内部仍通过 svc 派发（如 svc.retrieveCandidates），保证测试 mock 与运行时覆盖行为不变。
 */

/**
 * 单路向量检索（Qdrant hybrid）：embedding → search → 类别过滤回退 → 缓存
 * （历史上曾有独立关键词通道，语义 rerank 上线后按评测结论移除，融合在 vector-store 内完成）
 *
 * @returns {Promise<{ candidates: Array, trace: object, vectorResults: Array }>}
 */
async function retrieveCandidates(svc, query, options = {}) {
  const searchTopK = parseInt(options.topK || options.childTopK || svc.searchTopK, 10) || svc.searchTopK;
  const tracer = options.tracer || null;
  const queryVariant = options.queryVariant || 'primary';

  // 缓存拦截：noCache（评测隔离）/显式 category（调用方意图过滤）不缓存。
  // tracer 只是观测对象不参与检索语义，此前排除导致生产链路缓存永不命中（每次都全量 embedding+向量库往返）
  const canCache = config.rag.cacheEnabled && !options.noCache && !options.category;
  if (canCache) {
    // 键含 topK：不同 topK 的调用共享条目会拿到截断长度错误的候选池
    const cacheKey = `${String(query || '').trim().toLowerCase()}|k${searchTopK}`;
    const cached = retrievalCache.get(cacheKey);
    if (cached) {
      // 返回 trace 拷贝：dualRetrieve 会向 trace 追加 queryRewrite/queryDecompose 等字段，
      // 直接返回缓存对象会把本次请求的观测信息写进缓存、泄漏给后续请求
      return {
        candidates: cached.candidates,
        trace: { ...cached.trace, cacheHit: true, queryVariant },
        vectorResults: cached.candidates,
      };
    }
  }

  // 元数据过滤（Multi-faceted Filtering）：显式 category 优先；
  // 未指定时按问题关键词自动推断（低置信返回 null → 不设过滤，保持全库召回）
  const explicitCategory = options.category || null;
  const autoCategory = !explicitCategory ? svc._inferDocCategory(query) : null;
  const effectiveCategory = explicitCategory || autoCategory || null;

  const trace = {
    mode: 'bge-small-zh-qdrant-hybrid',
    category: effectiveCategory,
    autoCategory,
    topK: {
      hybrid: searchTopK,
      final: searchTopK,
    },
    embedding: { ok: false, dense: false, sparse: false, latency: 0, model: null },
    vector: { count: 0, latency: 0, error: null, backend: 'qdrant_hybrid' },
    fused: { count: 0, topScore: 0, channels: [] },
  };

  const filter = effectiveCategory ? { category: effectiveCategory } : null;
  let candidates = [];
  let currentStage = 'embedding';
  let currentStageStart = Date.now();
  let queryEmbedding = null;
  // 语义缓存开关按次读取（评测/测试可运行时切换）
  const semanticCacheEnabled = config.rag.semanticCacheEnabled === true;

  try {
    const embeddingStart = Date.now();
    currentStage = 'embedding';
    currentStageStart = embeddingStart;
    queryEmbedding = await svc.embeddingService.embedQuery(query);
    trace.embedding = {
      ok: !!queryEmbedding?.dense,
      dense: !!queryEmbedding?.dense,
      sparse: !!queryEmbedding?.sparse && Object.keys(queryEmbedding.sparse).length > 0,
      latency: Date.now() - embeddingStart,
      model: queryEmbedding?.model || null,
      // BGE-zh v1.5 是非对称检索模型：查询侧走 embedQuery（带指令前缀），文档侧不加。
      // 记进 trace，A/B 对比前缀收益时可直接确认该次检索走的是哪条路径。
      queryInstruction: svc.embeddingService.queryInstructionEnabled === true,
    };
    metrics.recordLatency('embedding', trace.embedding.latency);
    svc._recordTraceStage(tracer, 'embedding', embeddingStart, true, {
      queryVariant,
      model: trace.embedding.model,
      dense: trace.embedding.dense,
      sparse: trace.embedding.sparse,
    });

    // 语义缓存：精确缓存 miss 后按查询向量找近义问题，直接复用其检索候选池。
    // 候选池只是 reranker 的召回池（reranker 仍按原问题打分），共享不影响精度
    if (semanticCacheEnabled && canCache && queryEmbedding?.dense) {
      const hit = semanticCache.lookup(queryEmbedding.dense);
      if (hit) {
        trace.semanticCache = { hit: true, matchedQuery: hit.query, similarity: hit.similarity };
        trace.fused = {
          count: hit.value.candidates.length,
          topScore: hit.value.candidates[0]?.score || 0,
          channels: [...new Set(hit.value.candidates.flatMap(item => item._retrievalChannels || []))],
        };
        logEvent('info', 'rag_semantic_cache_hit', { similarity: hit.similarity, query: hit.query, reusedCandidates: hit.value.candidates.length });
        return { candidates: hit.value.candidates, trace, vectorResults: hit.value.candidates };
      }
    }

    if (queryEmbedding?.dense) {
      const searchStart = Date.now();
      currentStage = 'vector_search';
      currentStageStart = searchStart;
      // RRF 融合在 vector-store 内完成（稠密/稀疏独立排名，无需动态权重路由）
      candidates = await svc.vectorStore.search(queryEmbedding, searchTopK, filter);

      // 空结果回退：自动推断的类别过滤无命中 → 回退全库检索，避免跨文档问题被误过滤
      // （显式 category 是调用方意图，不做回退）
      if (autoCategory && candidates.length === 0) {
        const fallbackStart = Date.now();
        candidates = await svc.vectorStore.search(queryEmbedding, searchTopK, null);
        trace.filterFallback = {
          inferredCategory: autoCategory,
          recovered: candidates.length,
          latency: Date.now() - fallbackStart,
        };
        svc._recordTraceStage(tracer, 'category_filter_fallback', fallbackStart, true, {
          inferredCategory: autoCategory,
          recovered: candidates.length,
        });
      }

      trace.vector = {
        count: candidates.length,
        latency: Date.now() - searchStart,
        error: null,
        backend: 'qdrant_hybrid',
      };
      metrics.recordLatency('vectorSearch', trace.vector.latency);
      svc._recordTraceStage(tracer, 'vector_search', searchStart, true, {
        queryVariant,
        topK: searchTopK,
        count: candidates.length,
        category: effectiveCategory || null,
        autoCategory,
        backend: trace.vector.backend,
      });
    } else {
      svc._recordTraceStage(tracer, 'vector_search', Date.now(), false, {
        queryVariant,
        reason: 'missing_dense_embedding',
      });
    }
  } catch (err) {
    if (currentStage === 'embedding') {
      trace.embedding.ok = false;
    } else {
      trace.vector.error = err.message;
    }
    svc._recordTraceStage(tracer, currentStage, currentStageStart, false, { queryVariant }, err);
    logEvent('warn', 'rag_vector_search_failed', { error: err.message });
  }

  trace.fused = {
    count: candidates.length,
    topScore: candidates[0]?.score || 0,
    channels: [...new Set(candidates.flatMap(item => item._retrievalChannels || []))],
  };

  svc._recordTraceStage(tracer, 'fusion', Date.now(), true, {
    queryVariant,
    count: trace.fused.count,
    topScore: trace.fused.topScore,
    channels: trace.fused.channels,
  });

  // 缓存写入。空候选池不写：向量库瞬时故障被上方 catch 吞掉后 candidates 为 []，
  // 若写入会让同一查询在 TTL 内全部命中空缓存、即便故障已恢复也答"无可靠来源"
  //（语义缓存本来就有 candidates.length > 0 闸门，精确缓存此前漏了）
  if (canCache && candidates.length > 0) {
    const cacheKey = `${String(query || '').trim().toLowerCase()}|k${searchTopK}`;
    retrievalCache.set(cacheKey, {
      candidates,
      // trace 快照：调用方（dualRetrieve）会向返回的 trace 追加字段，不能让它们写进缓存
      trace: { ...trace },
      rewrittenQuery: trace?.rewrittenQuery || null,
    });
    // 语义缓存写入：同一份候选池供近义问题复用
    if (semanticCacheEnabled && queryEmbedding?.dense) {
      semanticCache.store(query, queryEmbedding.dense, { candidates });
    }
  }

  return { candidates, trace, vectorResults: candidates };
}

/**
 * 子片段检索 + 父段聚合（对外 REST 接口 /retrieval/parents 的实现）
 */
async function retrieveParentCandidates(svc, query, options = {}) {
  const tracer = svc._createTracer(query, options);
  const ownsTracer = !options.tracer;
  const childTopK = parseInt(options.childTopK || options.topK || 25, 10) || 25;
  const parentTopK = parseInt(options.parentTopK || 0, 10) || 0;
  const includeChildren = options.includeChildren !== false;
  const { candidates, trace, vectorResults } = await svc.retrieveCandidates(query, {
    ...options,
    tracer,
    topK: childTopK,
  });
  const parentAggregateStart = Date.now();
  const parents = await aggregateParentCandidates(svc, candidates, {
    limit: parentTopK,
    includeChildren,
  });
  svc._recordTraceStage(tracer, 'parent_aggregate', parentAggregateStart, true, {
    childCount: candidates.length,
    parentCount: parents.length,
  });

  const retrievalSummary = svc._summarizeRetrievalTrace(trace);
  tracer.setRetrieval(retrievalSummary);
  const result = {
    query,
    category: options.category || null,
    childTopK,
    parentTopK: parentTopK || parents.length,
    children: candidates.map((chunk, index) => resultMapper.chunkToCandidate(chunk, index + 1)),
    parents,
    retrieval: retrievalSummary,
    trace,
    vectorResults,
  };

  return ownsTracer
    ? svc._finishTrace(tracer, result, { usedRag: true, retrievedChunks: candidates.length, matchedDocs: parents.length })
    : { ...result, traceId: tracer.traceId, trace: tracer.toSummary() };
}

/**
 * 将子片段候选按父段聚合为父段候选列表
 */
async function aggregateParentCandidates(svc, chunks, options = {}) {
  if (!chunks || chunks.length === 0) return [];

  const limit = parseInt(options.limit || 0, 10) || 0;
  const includeChildren = options.includeChildren !== false;
  const paraMap = new Map();

  chunks.forEach((chunk, index) => {
    const childRank = index + 1;
    const parentId = chunk.parentId || (chunk.docId + '_para_' + (chunk.parentIdx ?? 0));
    if (!parentId) return;

    const current = paraMap.get(parentId) || {
      parentId,
      bestChunk: chunk,
      chunks: [],
      parentText: chunk.parentText || '',
      docId: chunk.docId,
      parentIdx: chunk.parentIdx,
      firstChildRank: childRank,
    };

    current.chunks.push({ ...chunk, _childRank: childRank });
    current.firstChildRank = Math.min(current.firstChildRank, childRank);
    if ((chunk.score || 0) > (current.bestChunk.score || 0)) current.bestChunk = chunk;
    if ((chunk.parentText || '').length > current.parentText.length) {
      current.parentText = chunk.parentText;
    }
    paraMap.set(parentId, current);
  });

  const docCache = new Map();
  const sortedMatches = [...paraMap.values()]
    .sort((a, b) => {
      const scoreDiff = (b.bestChunk.score || 0) - (a.bestChunk.score || 0);
      return scoreDiff || a.firstChildRank - b.firstChildRank;
    });
  const limitedMatches = limit > 0 ? sortedMatches.slice(0, limit) : sortedMatches;
  const parents = [];

  for (const match of limitedMatches) {
    let doc = docCache.has(match.docId) ? docCache.get(match.docId) : null;
    if (!docCache.has(match.docId) && match.docId) {
      doc = await svc.documentService.getDocument(match.docId);
      docCache.set(match.docId, doc || null);
    }

    parents.push(resultMapper.parentMatchToCandidate(match, doc, parents.length + 1, { includeChildren }));
  }

  return parents;
}

/**
 * RRF 融合：score = Σ 1/(k + rank)，只看通道内排名，免去跨通道权重校准
 */
function fuseRetrievalResults(svc, vectorResults = [], keywordResults = [], limit = null, _query = null) {
  const effectiveLimit = limit ?? svc.searchTopK;
  const merged = new Map();
  const addResult = (item, channel, rank) => {
    const key = item.id || `${item.docId}:${item.chunkIndex}`;
    const existing = merged.get(key) || {
      ...item,
      score: 0,
      _vectorScore: 0,
      _keywordScore: 0,
      _rrfScore: 0,
      _retrievalChannels: [],
    };

    if (channel === 'vector') {
      existing._vectorScore = Math.max(existing._vectorScore || 0, resultMapper.normalizeScore(item.score));
      existing._vectorRank = rank;
    } else if (channel === 'keyword') {
      existing._keywordScore = Math.max(existing._keywordScore || 0, resultMapper.normalizeScore(item._keywordScore ?? item.score));
      existing._keywordRank = rank;
    }

    existing._rrfScore += 1 / (svc.rrfK + rank);
    if (!existing._retrievalChannels.includes(channel)) existing._retrievalChannels.push(channel);
    merged.set(key, { ...existing, ...resultMapper.preferFilledFields(existing, item) });
  };

  vectorResults.forEach((item, index) => addResult(item, 'vector', index + 1));
  keywordResults.forEach((item, index) => addResult(item, 'keyword', index + 1));

  return [...merged.values()]
    .map(item => ({ ...item, score: item._rrfScore || 0 }))
    .sort((a, b) => b.score - a.score)
    .slice(0, effectiveLimit);
}

/**
 * 多路检索：原问题必选，叠加改写 query（指代消解）与分解子查询（跨文档多实体），
 * 并行检索、按 chunk id 合并去重保留高分。
 *
 * 关键设计：改写/子查询只用于**扩大召回池**，后续 reranker 仍按用户原始问题打分，
 * 因此子查询的语义偏移不会影响精度。
 *
 * @returns {Promise<{ candidates: Array, trace: object, rewrittenQuery: string|null }>}
 */
async function dualRetrieve(svc, message, history, options = {}) {
  const tracer = options.tracer || null;

  // 1) Query 改写：解决多轮对话中指代/省略问题
  let rewrittenQuery = null;
  if (queryRewrite.shouldRewriteQuery(message, history)) {
    const rewriteStart = Date.now();
    try {
      rewrittenQuery = await queryRewrite.rewriteQuery(message, history, svc.aiService);
      svc._recordTraceStage(tracer, 'query_rewrite', rewriteStart, true, {
        changed: !!rewrittenQuery,
      });
    } catch (err) {
      svc._recordTraceStage(tracer, 'query_rewrite', rewriteStart, false, {}, err);
    }
  }

  // 2) 跨文档问题分解：对比/列举类问题拆实体级子查询（零 LLM 成本）
  let decompose = { subQueries: [], type: null };
  if (svc.queryDecomposeEnabled && !options.disableDecompose) {
    decompose = decomposeQuery(message, svc.queryDecomposeMax);
  }

  // 2.5) 查询翻译（默认关闭，灰度开启）：HyDE 假设文档 / Step-Back 上位问题。
  // 与改写/分解同一设计——只扩大召回池，reranker 仍按用户原始问题打分，
  // 因此假设文档内容不准确/上位问题偏移都不会影响精度
  let hydeDocument = null;
  let stepBackQuery = null;
  const translateJobs = [];
  if (svc.hydeEnabled && !options.disableHyde) {
    const hydeStart = Date.now();
    translateJobs.push(
      queryRewrite.generateHydeDocument(message, svc.aiService)
        .then(doc => {
          hydeDocument = doc;
          svc._recordTraceStage(tracer, 'hyde', hydeStart, true, { generated: !!doc });
        })
        .catch(err => svc._recordTraceStage(tracer, 'hyde', hydeStart, false, {}, err))
    );
  }
  if (svc.stepBackEnabled && !options.disableStepBack) {
    const stepBackStart = Date.now();
    translateJobs.push(
      queryRewrite.generateStepBackQuery(message, svc.aiService)
        .then(q => {
          stepBackQuery = q;
          svc._recordTraceStage(tracer, 'step_back', stepBackStart, true, { changed: !!q });
        })
        .catch(err => svc._recordTraceStage(tracer, 'step_back', stepBackStart, false, {}, err))
    );
  }
  if (translateJobs.length > 0) await Promise.all(translateJobs);

  // 3) 组装检索变体并去重（规范化文本相同视为同一变体）
  const seenVariants = new Set([String(message).trim().toLowerCase()]);
  const variants = [{ query: message, queryVariant: 'original' }];
  if (rewrittenQuery) {
    const key = String(rewrittenQuery).trim().toLowerCase();
    if (!seenVariants.has(key)) {
      seenVariants.add(key);
      variants.push({ query: rewrittenQuery, queryVariant: 'rewritten' });
    }
  }
  if (hydeDocument) {
    const key = String(hydeDocument).trim().toLowerCase();
    if (!seenVariants.has(key)) {
      seenVariants.add(key);
      variants.push({ query: hydeDocument, queryVariant: 'hyde' });
    }
  }
  if (stepBackQuery) {
    const key = String(stepBackQuery).trim().toLowerCase();
    if (!seenVariants.has(key)) {
      seenVariants.add(key);
      variants.push({ query: stepBackQuery, queryVariant: 'step_back' });
    }
  }
  for (let i = 0; i < decompose.subQueries.length; i++) {
    const sub = decompose.subQueries[i];
    const key = String(sub).trim().toLowerCase();
    if (seenVariants.has(key)) continue;
    seenVariants.add(key);
    variants.push({ query: sub, queryVariant: `sub:${i}:${decompose.type}` });
  }

  const chunkKey = (c) => c.id || `${c.docId}:${c.chunkIndex}`;

  // 单变体：不需要改写也无子查询，保持原单路路径零额外开销
  if (variants.length === 1) {
    const { candidates, trace } = await svc.retrieveCandidates(message, { ...options, queryVariant: 'original' });
    return { candidates, trace, rewrittenQuery: null };
  }

  // 多变体并行检索（embedding 有缓存，子查询短文本开销小）
  const results = await Promise.all(
    variants.map(v => svc.retrieveCandidates(v.query, { ...options, queryVariant: v.queryVariant })),
  );
  const originalResult = results[0];
  const extraResults = results.slice(1);
  const rewrittenResult = extraResults.find(r => r.trace?.queryVariant === 'rewritten') ||
    extraResults.find((_, i) => variants[i + 1].queryVariant === 'rewritten') || null;

  // 改写结果异常检测：如果改写后的检索结果显著少于原文（比例 < 0.3），
  // 说明改写可能偏了，此时以原文结果为主，仅补充改写结果中不重叠的高分项
  if (rewrittenResult) {
    const rewriteRatio = rewrittenResult.candidates.length / Math.max(originalResult.candidates.length, 1);
    if (rewriteRatio < 0.3 && originalResult.candidates.length > 3) {
      logEvent('info', 'rag_query_rewrite_anomalous_fallback', { rewrittenCount: rewrittenResult.candidates.length, originalCount: originalResult.candidates.length });
    }
  }

  // 合并去重：按 chunk id 去重，保留高分（原问题结果优先占位）
  const merged = new Map();
  for (const c of originalResult.candidates) {
    merged.set(chunkKey(c), c);
  }
  for (const result of extraResults) {
    for (const c of result.candidates) {
      const key = chunkKey(c);
      const existing = merged.get(key);
      if (!existing || (c.score || 0) > (existing.score || 0)) {
        merged.set(key, c);
      }
    }
  }

  const mergedCandidates = [...merged.values()]
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .slice(0, svc.searchTopK);

  // 合并 trace（取原始 query 的 trace，附加各变体标记）
  const trace = originalResult.trace;
  if (rewrittenQuery) {
    trace.queryRewrite = {
      original: message,
      rewritten: rewrittenQuery,
      originalCount: originalResult.candidates.length,
      rewrittenCount: rewrittenResult ? rewrittenResult.candidates.length : 0,
      mergedCount: mergedCandidates.length,
    };
    logEvent('info', 'rag_multi_query_merged', { originalCount: originalResult.candidates.length, rewrittenCount: rewrittenResult ? rewrittenResult.candidates.length : 0, mergedCount: mergedCandidates.length });
  }
  if (decompose.subQueries.length > 0) {
    trace.queryDecompose = {
      type: decompose.type,
      subQueries: decompose.subQueries,
      originalCount: originalResult.candidates.length,
      mergedCount: mergedCandidates.length,
    };
    logEvent('info', 'rag_query_decompose_retrieval', { type: decompose.type, message, subQueries: decompose.subQueries.join(' | '), originalCount: originalResult.candidates.length, mergedCount: mergedCandidates.length });
  }

  return { candidates: mergedCandidates, trace, rewrittenQuery };
}

module.exports = { retrieveCandidates, retrieveParentCandidates, aggregateParentCandidates, fuseRetrievalResults, dualRetrieve, semanticCache };
