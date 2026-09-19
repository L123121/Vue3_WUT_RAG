"use strict";

const { AiService } = require('./ai.service');
const { DocumentService } = require('./document.service');
const { EmbeddingService } = require('./embedding.service');
const { vectorStore: vectorStoreSingleton } = require('./vector-store-qdrant.service');
const { RerankerService } = require('./reranker.service');
const config = require('../config');
const { metrics } = require('./metrics.service');
const { RagTracer } = require('./rag-tracer.service');
const {
  classifyQuestion,
  getTypeConfig,
  inferDocCategory,
  adaptiveTruncate,
  charBigrams,
  jaccardBigrams,
  mmrDedupe,
} = require('./rag-ranking.service');
const ragPrompt = require('./rag-prompt.service');
const resultMapper = require('./rag-result-mapper.service');
const { checkGrounding } = require('./grounding.service');
const queryRewrite = require('./rag-query-rewrite.service');
const contextBuilder = require('./rag-context-builder.service');
const ragRetrieval = require('./rag-retrieval.service');
const { buildFollowups } = require('./rag-followups.service');
const ragPipeline = require('./rag-pipeline.service');
const ragGeneration = require('./rag-generation.service');
const { logEvent } = require('./observability.service');

class RagService {
  constructor(aiService = null) {
    const ragConfig = config.rag || {};

    this.aiService = aiService || new AiService();
    this.documentService = new DocumentService();
    this.embeddingService = new EmbeddingService();
    // 使用全局单例，避免创建新实例导致向量为空
    this.vectorStore = vectorStoreSingleton;
    this.maxContextLength = ragConfig.maxContextLength || 6000;
    this.parentChildEnabled = ragConfig.parentChildEnabled !== false;
    this.rerankEnabled = ragConfig.rerankEnabled !== false;
    this.rerankTopK = ragConfig.rerankTopK || 10;
    this.searchTopK = ragConfig.searchTopK || 50;
    this.hybridSearchEnabled = ragConfig.hybridSearchEnabled !== false;
    this.rrfK = ragConfig.rrfK || 60;
    this.minSourceScore = ragConfig.minSourceScore ?? 0.03;
    this.mmrEnabled = ragConfig.mmrEnabled !== false;
    this.mmrLambda = ragConfig.mmrLambda ?? 0.7;
    this.mmrMaxSim = ragConfig.mmrMaxSim ?? 0.85;
    this.autoCategoryFilter = ragConfig.autoCategoryFilter !== false;
    // 运行时引用校验（防幻觉兜底）：生成后逐句对照上下文，低溯源标注 level=low
    this.groundingEnabled = ragConfig.groundingEnabled !== false;
    this.groundingMinSupport = Number.isFinite(ragConfig.groundingMinSupport) ? ragConfig.groundingMinSupport : 0.35;
    // 跨文档问题分解：对比/列举类问题拆子查询扩大召回池（reranker 仍按原问题打分，精度不受影响）
    this.queryDecomposeEnabled = ragConfig.queryDecomposeEnabled !== false;
    this.queryDecomposeMax = Math.min(Math.max(parseInt(ragConfig.queryDecomposeMaxSubQueries, 10) || 3, 1), 5);
    // 查询翻译（默认关闭，灰度开启）：HyDE 假设文档 / Step-Back 上位问题作为额外召回变体
    this.hydeEnabled = ragConfig.hydeEnabled === true;
    this.stepBackEnabled = ragConfig.stepBackEnabled === true;
    this.rerankerService = new RerankerService();
  }

  _createTracer(message, options = {}) {
    return options.tracer || new RagTracer({
      traceId: options.traceId,
      userId: options.userId,
      conversationId: options.conversationId,
      message,
      category: options.category || null,
    });
  }

  _recordTraceStage(tracer, name, startedAt, success = true, details = {}, err = null) {
    const durationMs = Date.now() - startedAt;
    tracer?.recordStage(name, durationMs, success, details, err);
    if (typeof metrics.recordStage === 'function') {
      metrics.recordStage(name, durationMs, success, err ? this._errorType(err) : null);
    }
    return durationMs;
  }

  _finishTrace(tracer, result = {}, outcome = {}) {
    const trace = tracer.finish(outcome);
    return {
      ...result,
      traceId: trace.traceId,
      trace: tracer.toSummary(),
    };
  }

  _errorType(err) {
    const message = String(err?.message || err || '').toLowerCase();
    if (/timeout|timed out|abort/.test(message)) return 'timeout';
    if (/rate|429|quota|limit/.test(message)) return 'rate_limit';
    if (/qdrant|向量库|vector|collection/.test(message)) return 'vector_store';
    if (/embedding|transformer|model/.test(message)) return 'embedding';
    if (/network|econn|enotfound|socket|fetch/.test(message)) return 'network';
    return 'unknown';
  }

  /**
   * 统一 RAG 管道编排:文档检查 → 检索 → rerank → 父段处理 → 上下文组装。
   * 实现已拆至 rag-pipeline.service（经 svc 派发,测试 mock 与运行时覆盖行为不变）
   *
   * @returns {Promise<Object>} { context, sources, topChunks, retrieval, questionType, rewrittenQuery, hasReliableCandidates }
   */
  async _runRAGPipeline(message, history = [], options = {}) {
    return ragPipeline.runRAGPipeline(this, message, history, options);
  }

  /**
   * 本地混合检索管道 (流式)
   */
  /**
   * 本地混合检索管道 (非流式,兼容 Agent 工具)
   */
  async localSearchChat(message, history = [], options = {}) {
    const tracer = this._createTracer(message, options);
    const ownsTracer = !options.tracer;
    const totalStart = Date.now();

    const pipeline = await this._runRAGPipeline(message, history, { ...options, tracer });

    if (!pipeline.hasReliableCandidates) {
      return ownsTracer ? this._finishTrace(tracer, {
        reply: pipeline.fallbackReason === 'no_documents' ? null : this._buildNoReliableSourcesReply(),
        isMock: false,
        sources: [],
        context: '',
        topChunks: [],
        model: 'local-hybrid-search+no-source',
        questionType: pipeline.questionType,
        rewrittenQuery: pipeline.rewrittenQuery,
        retrieval: pipeline.retrieval,
      }) : null;
    }

    // retrieveOnly:仅检索不生成(Agent 工具专用)
    if (options.retrieveOnly) {
      const result = {
        reply: '',
        isMock: false,
        sources: pipeline.sources,
        context: pipeline.context,
        model: 'local-hybrid-search+retrieve-only',
        questionType: pipeline.questionType,
        rewrittenQuery: pipeline.rewrittenQuery,
        retrieval: pipeline.retrieval,
      };
      return ownsTracer ? this._finishTrace(tracer, result) : { ...result, traceId: tracer.traceId, trace: tracer.toSummary() };
    }

    // 生成回答:prompt 组装 / LLM 调用 / grounding 校验拆至 rag-generation.service
    const {
      reply, aiLatency, llmUsage, llmModel, processCard, grounding,
    } = await ragGeneration.generateAnswer(this, { message, history, pipeline, tracer });

    const totalLatency = Date.now() - totalStart;
    metrics.recordLatency('total', totalLatency);

    metrics.recordRagQuery({
      usedRag: true,
      usedParentChild: !!pipeline.context,
      matchedDocs: pipeline.sources.length,
      retrievedChunks: pipeline.topChunks.length,
      hasSources: pipeline.sources.length > 0,
    });

    tracer.setRetrieval(pipeline.retrieval);
    tracer.setOutcome({
      usedRag: true,
      usedParentChild: !!pipeline.context,
      matchedDocs: pipeline.sources.length,
      retrievedChunks: pipeline.topChunks.length,
      questionType: pipeline.questionType,
      rewrittenQuery: pipeline.rewrittenQuery,
    });
    this._recordTraceStage(tracer, 'total', totalStart, true, {
      usedRag: true,
      matchedDocs: pipeline.sources.length,
      retrievedChunks: pipeline.topChunks.length,
    });

    const result = {
      reply,
      isMock: false,
      sources: pipeline.sources,
      context: pipeline.context,
      topChunks: pipeline.topChunks,
      model: llmModel,
      usage: llmUsage,
      questionType: pipeline.questionType,
      rewrittenQuery: pipeline.rewrittenQuery,
      retrieval: pipeline.retrieval,
      grounding: grounding || null,
      processCard: processCard || null,
      followups: buildFollowups({
        sources: pipeline.sources,
        chunks: pipeline.topChunks,
        question: message,
      }),
      _metrics: {
        totalLatency,
        aiLatency,
        matchedDocs: pipeline.sources.length,
        retrievedChunks: pipeline.topChunks.length,
        questionType: pipeline.questionType,
        rewrittenQuery: pipeline.rewrittenQuery,
        retrieval: pipeline.retrieval,
      },
    };
    return ownsTracer ? this._finishTrace(tracer, result) : { ...result, traceId: tracer.traceId, trace: tracer.toSummary() };
  }

  async retrieveCandidates(query, options = {}) {
    return ragRetrieval.retrieveCandidates(this, query, options);
  }

  async retrieveParentCandidates(query, options = {}) {
    return ragRetrieval.retrieveParentCandidates(this, query, options);
  }

  fuseRetrievalResults(vectorResults = [], keywordResults = [], limit = this.searchTopK, _query = null) {
    return ragRetrieval.fuseRetrievalResults(this, vectorResults, keywordResults, limit, _query);
  }

  async selectTopChunks(query, candidates) {
    if (!candidates || candidates.length === 0) return [];
    // 现在 rerank 在父段落级别做（见 _runRAGPipeline），子句只需返回足够多的候选用作父段落聚合
    // 取 top 50 子句足够覆盖知识库中所有相关父段落
    const limit = Math.min(candidates.length, 50);
    return candidates.slice(0, limit);
  }

  buildParentChildPrompt(query, context) {
    return ragPrompt.buildParentChildPrompt(query, context);
  }

  /**
   * 流程类问题识别：办理/申请/补办等结构化流程问题
   */
  isProcessQuestion(query) {
    return ragPrompt.isProcessQuestion(query);
  }

  /**
   * 流程类问题的结构化输出 prompt：强制 LLM 输出 JSON 步骤卡片
   */
  buildProcessPrompt(query, context) {
    return ragPrompt.buildProcessPrompt(query, context);
  }

  /**
   * 从 LLM 回复中解析流程卡片 JSON（容忍 markdown 代码块包裹 / 前后杂文本）
   */
  parseProcessCard(reply) {
    return ragPrompt.parseProcessCard(reply);
  }

  /**
   * 非流式 RAG 问答：统一 drain chatStream()（单一管线驱动，消除两套循环的 drift 风险，
   * 与 agent.service.chat 的收口方式一致）。
   *
   * 返回形状与原实现对齐：context/topChunks/questionType/rewrittenQuery/retrieval 随
   * chatStream 的 done 事件回传（includePipeline 仅此处使用，公开流式端点不受影响）。
   * 检索管线本身崩溃时（chatStream 内部已含生成失败降级）降级纯 LLM，与旧行为一致。
   */
  async chat(message, history = [], options = {}) {
    const totalStart = Date.now();
    let reply = '';
    let sources = [];
    let usage = null;
    let processCard = null;
    let grounding = null;
    let followups = [];
    let trace = null;
    let pipelineMeta = null;

    try {
      for await (const event of this.chatStream(message, history, { ...options, includePipeline: true })) {
        if (event.type === 'content') {
          if (event.done) pipelineMeta = event.pipeline || pipelineMeta;
          else reply += event.content || '';
        } else if (event.type === 'sources') {
          sources = event.sources || [];
        } else if (event.type === 'usage') {
          usage = event.usage || null;
        } else if (event.type === 'process') {
          processCard = event.processCard || null;
        } else if (event.type === 'grounding') {
          grounding = event.grounding || null;
        } else if (event.type === 'followups') {
          followups = event.items || [];
        } else if (event.type === 'trace') {
          trace = event.trace || trace;
        }
      }
    } catch (err) {
      const tracer = this._createTracer(message, options);
      tracer.markFallback('rag_pipeline_error');
      this._recordTraceStage(tracer, 'rag_pipeline', Date.now(), false, {}, err);
      logEvent('warn', 'rag_pipeline_fallback', { error: err.message });

      const aiStart = Date.now();
      try {
        const result = await this.aiService.getCompletion(message, history);
        const aiLatency = Date.now() - aiStart;
        metrics.recordLatency('ai', aiLatency);
        this._recordTraceStage(tracer, 'llm', aiStart, true, {
          model: config.ai.model || 'step-3.7-flash',
          isMock: !!result.isMock,
          outputChars: (result.content || '').length,
          usage: result.usage || null,
        });
        metrics.recordLatency('total', Date.now() - totalStart);
        metrics.recordRagQuery({ usedRag: false, usedParentChild: false });
        this._recordTraceStage(tracer, 'total', totalStart, true, { usedRag: false });

        return this._finishTrace(tracer, {
          reply: result.content,
          isMock: result.isMock,
          sources: [],
          context: '',
          model: config.ai.model || 'step-3.7-flash',
          usage: result.usage || null,
        }, { usedRag: false, usedParentChild: false });
      } catch (llmErr) {
        this._recordTraceStage(tracer, 'llm', aiStart, false, { model: config.ai.model || 'step-3.7-flash' }, llmErr);
        this._recordTraceStage(tracer, 'total', totalStart, false, { usedRag: false }, llmErr);
        tracer.markError(llmErr);
        tracer.finish({ usedRag: false, usedParentChild: false });
        throw llmErr;
      }
    }

    const context = pipelineMeta?.context || '';
    const topChunks = Array.isArray(pipelineMeta?.topChunks) ? pipelineMeta.topChunks : [];
    const fallbackReason = pipelineMeta?.fallbackReason || null;
    const questionType = pipelineMeta?.questionType ?? null;
    const rewrittenQuery = pipelineMeta?.rewrittenQuery ?? null;
    const retrieval = pipelineMeta?.retrieval ?? null;
    const totalLatency = Date.now() - totalStart;
    const aiLatency = trace?.timings?.find((stage) => stage.name === 'llm')?.durationMs ?? 0;

    return {
      // 知识库为空时保持旧契约（reply=null）；其余路径 drain 到的即最终回复
      reply: fallbackReason === 'no_documents' ? null : reply,
      isMock: false,
      sources,
      context,
      topChunks,
      model: config.ai.model || 'step-3.7-flash',
      usage,
      questionType,
      rewrittenQuery,
      retrieval,
      grounding: grounding || null,
      processCard: processCard || null,
      followups,
      traceId: trace?.traceId || null,
      trace: trace || null,
      _metrics: {
        totalLatency,
        aiLatency,
        matchedDocs: sources.length,
        retrievedChunks: topChunks.length,
        questionType,
        rewrittenQuery,
        retrieval,
      },
    };
  }

  async *chatStream(message, history = [], options = {}) {
    const tracer = this._createTracer(message, options);
    const totalStart = Date.now();

    // 事件收集器,用于在管道内 yield
    const events = [];
    const onEvent = (event) => events.push(event);

    // chat() drain 时提取管线信息。includePipeline 仅 chat 内部传入，
    // 公开流式端点不带该标志 → done 事件不携带管线负载，SSE 契约不变
    const pipelineMeta = () => options.includePipeline ? {
      context: pipeline.context,
      topChunks: pipeline.topChunks,
      questionType: pipeline.questionType,
      rewrittenQuery: pipeline.rewrittenQuery,
      retrieval: pipeline.retrieval,
      fallbackReason: pipeline.fallbackReason || null,
    } : null;

    const pipeline = await this._runRAGPipeline(message, history, { ...options, tracer, onEvent });

    // 先 yield 管道中收集的事件
    for (const event of events) {
      if (event.type === 'retrieval') {
        yield { type: 'retrieval', ...event, traceId: tracer.traceId, trace: tracer.toSummary() };
      } else if (event.type === 'no_reliable_sources') {
        tracer.markFallback('no_reliable_sources');
        tracer.finish({ usedRag: true, usedParentChild: false, matchedDocs: 0, retrievedChunks: 0 });
        yield { type: 'trace', trace: tracer.toSummary() };
        yield { type: 'content', content: event.reply, done: false };
        yield { type: 'content', content: '', done: true, pipeline: pipelineMeta() };
        return;
      } else if (event.type === 'sources') {
        metrics.recordRagQuery({
          usedRag: true,
          usedParentChild: !!pipeline.context,
          matchedDocs: pipeline.sources.length,
          retrievedChunks: pipeline.topChunks.length,
        });
        yield event;
      }
    }

    // 没有可靠来源或上下文为空,返回兜底回复
    if (!pipeline.hasReliableCandidates || !pipeline.context) {
      const fallbackReason = !pipeline.hasReliableCandidates ? 'no_reliable_sources' : 'empty_enhanced_context';
      tracer?.markFallback(fallbackReason);
      this._recordTraceStage(tracer, 'total', totalStart, true, {
        usedRag: true,
        matchedDocs: pipeline.sources.length,
        retrievedChunks: pipeline.topChunks.length,
      });
      tracer?.finish({
        usedRag: true,
        usedParentChild: !!pipeline.context,
        matchedDocs: pipeline.sources.length,
        retrievedChunks: pipeline.topChunks.length,
        questionType: pipeline.questionType,
        rewrittenQuery: pipeline.rewrittenQuery,
      });
      yield { type: 'trace', trace: tracer.toSummary() };
      yield { type: 'content', content: this._buildNoReliableSourcesReply(), done: false };
      yield { type: 'content', content: '', done: true, pipeline: pipelineMeta() };
      return;
    }

    // 流式生成:prompt 组装 / 流式 LLM / 失败守卫与纯 LLM 降级拆至 rag-generation.service
    yield* ragGeneration.streamAnswer(this, {
      message,
      history,
      options,
      pipeline,
      tracer,
      totalStart,
      pipelineMeta,
    });
  }
  _hasReliableCandidates(candidates) {
    return resultMapper.hasReliableCandidates(candidates, this.minSourceScore);
  }

  _chunkToSource(chunk) {
    return resultMapper.chunkToSource(chunk);
  }

  _summarizeRetrievalTrace(trace) {
    return resultMapper.summarizeRetrievalTrace(trace, { enabled: this.rerankEnabled, topK: this.rerankTopK });
  }

  /**
   * 将子句列表按父段落分组（保留原始数据供 reranker 使用）
   */

  // ──────────────────────────────────────────────
  // 问题类型分类 + 差异化阈值
  // 按问题类型调整 minScore / rerankTopK，不用额外 LLM 调用，零延迟
  // ──────────────────────────────────────────────

  /**
   * 根据问题文本分类
   * @param {string} query
   * @returns {string} 类型 key
   */
  classifyQuestion(query) {
    return classifyQuestion(query);
  }

  /**
   * 获取问题类型对应的阈值配置
   * @param {string} query
   * @returns {{ minScore: number, rerankTopK: number, needSource: boolean, clamp: [number, number] }}
   */
  getTypeConfig(query) {
    return getTypeConfig(query);
  }

  /**
   * 自动推断问题所属文档类别（Multi-faceted Filtering）。
   *
   * 规则：命中 ≥ 2 个类别关键词（或问题中直接出现类别名）才返回类别；
   * 低置信度返回 null（不设过滤，保持全库召回，避免误伤跨文档问题）。
   * 纯正则/子串实现，零 LLM、零额外耗时。
   *
   * @param {string} query
   * @returns {string|null} 推断出的文档类别，低置信返回 null
   */
  _inferDocCategory(query) {
    return inferDocCategory(query, this.autoCategoryFilter);
  }

  // ──────────────────────────────────────────────
  // Query 改写：解决多轮对话中指代/省略问题
  // 改写后双路检索（改写+原文），合并去重，reranker 统一排序
  // ──────────────────────────────────────────────

  /** 检测是否需要改写：有历史 + 含代词/省略 */
  shouldRewriteQuery(query, history) {
    return queryRewrite.shouldRewriteQuery(query, history);
  }

  /**
   * 提取请求级阈值覆盖（A/B 评测/调参用）
   * 仅当请求显式传入有限数值时才覆盖，否则用默认配置（正常用户请求不受影响）
   * @param {Object} options - chat/chatStream 的 options
   * @returns {Object} { rerankMinScore?, rerankDropoff?, rerankTopK?, maxContextLength? }
   */
  _evalOverrides(options = {}) {
    const overrides = {};
    const finite = (v) => Number.isFinite(v);
    const minScore = Number(options.rerankMinScore);
    const dropoff = Number(options.rerankDropoff);
    const topK = Number(options.rerankTopK);
    const maxLen = Number(options.maxContextLength);
    if (finite(minScore) && minScore >= 0 && minScore <= 1) overrides.rerankMinScore = minScore;
    if (finite(dropoff) && dropoff >= 0 && dropoff <= 1) overrides.rerankDropoff = dropoff;
    if (finite(topK) && topK >= 1 && topK <= 100) overrides.rerankTopK = Math.round(topK);
    if (finite(maxLen) && maxLen >= 500 && maxLen <= 20000) overrides.maxContextLength = Math.round(maxLen);
    return overrides;
  }

  /**
   * 自适应截断：保留高置信度父段，剔除低分和断崖段落
   * 策略：基础 Top N → 断崖检测 → 低分过滤 → 硬上限
   * @param {Array} candidates - 父段落候选列表
   * @param {number} maxCount - 硬上限
   * @param {string} [query] - 问题原文，用于获取类型化阈值
   * @param {Object} [overrides] - 请求级覆盖 { rerankMinScore, rerankDropoff, rerankTopK }
   * @returns {Array} 截断后的候选列表
   */
  _adaptiveTruncate(candidates, maxCount, query, overrides = {}) {
    return adaptiveTruncate(candidates, maxCount, query, overrides, (value) => this.getTypeConfig(value));
  }

  /**
   * 字符 bigram 集合：中文文本相似度的轻量特征（零模型调用）
   */
  _charBigrams(text) {
    return charBigrams(text);
  }

  /**
   * 字符 bigram Jaccard 相似度（0~1）
   */
  _jaccardBigrams(setA, setB) {
    return jaccardBigrams(setA, setB);
  }

  /**
   * 父段归并后 MMR 去重：剔除与已选父段高度相似的冗余段落。
   *
   * 思路（对标 RAG_Techniques 的 reranking 多样性）：
   *   1. 按相关性（rerank/检索分数）降序贪心选择第一个父段
   *   2. 后续每次选择使 score = λ·relevance − (1−λ)·maxSim(selected) 最大的父段
   *   3. 与已选父段相似度 ≥ mmrMaxSim 的段落直接视为冗余剔除
   *
   * 相似度用字符 bigram Jaccard 计算，无 embedding / 无模型调用，开销可忽略。
   *
   * @param {Array} parentCandidates 父段候选（需含 parentText 或 bestChunk.text、_rerankScore 或 bestChunk.score）
   * @param {number} [maxCount] 去重后最多保留数量，默认全部候选
   * @returns {Array} 去重后的父段候选
   */
  _mmrDedupe(parentCandidates, maxCount = 0) {
    return mmrDedupe(parentCandidates, maxCount, {
      enabled: this.mmrEnabled,
      lambda: this.mmrLambda,
      maxSimilarity: this.mmrMaxSim,
    });
  }

  /**
   * 从已 rerank 的父段落聚合结果构建上下文
   */
  async _buildContextFromParents(parentCandidates, overrides = {}) {
    return contextBuilder.buildContextFromParents(parentCandidates, {
      maxContextLength: overrides.maxContextLength ?? this.maxContextLength,
      getDocument: (docId) => this.documentService.getDocument(docId),
    });
  }

  _buildNoReliableSourcesReply() {
    return ragPrompt.buildNoReliableSourcesReply();
  }

  /**
   * 运行时引用校验（防幻觉兜底）
   * 对照 LLM 实际看到的上下文逐句检查溯源覆盖率；关闭/无上下文/无有效句子时返回 null
   */
  _groundingCheck(reply, context, options = {}) {
    if (!this.groundingEnabled) return null;
    try {
      return checkGrounding(reply, context, {
        enabled: true,
        minSupport: options.minSupport ?? this.groundingMinSupport,
      });
    } catch (err) {
      // 校验是旁路观测，任何异常都不影响回答返回
      logEvent('warn', 'rag_grounding_check_failed', { error: err.message });
      return null;
    }
  }
}

module.exports = { RagService, metrics };













