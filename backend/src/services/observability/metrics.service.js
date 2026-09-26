"use strict";

/**
 * 系统指标采集服务
 *
 * 采集三类指标：
 *   1. 响应延迟 — AI/LLM、ChatDoc、向量检索各阶段耗时
 *   2. RAG 召回率 — 基于 ground_truth 的上下文召回评估
 *   3. 父子召回覆盖率 — ChatDoc 检索后本地增强的比例
 */

class MetricsService {
  constructor() {
    this.reset();
  }

  reset() {
    // 延迟记录（毫秒）
    this.latencies = {
      embedding: [],     // Embedding 生成
      ai: [],            // LLM 直接调用
      vectorSearch: [],  // Qdrant 向量检索
      parentChild: [],   // 父子召回增强阶段
      total: [],         // 端到端总延迟
      rerank: []         // Rerank 精排延迟
    };

    // RAG 检索指标
    this.rag = {
      totalQueries: 0,        // 总查询数
      ragQueries: 0,          // 启用 RAG 的查询数
      parentChildQueries: 0,  // 使用父子召回的查询数
      matchedDocCount: 0,     // 匹配到的父文档总数
      totalRetrievedChunks: 0, // 检索到的总切片数
      queriesWithSources: 0 // 返回至少一个引用来源的查询数
    };

    // 延迟分段（用于计算 p50/p95/p99）
    this.latencyBuckets = {
      embedding: { total: 0, count: 0 },
      ai: { total: 0, count: 0 },
      vectorSearch: { total: 0, count: 0 },
      parentChild: { total: 0, count: 0 },
      total: { total: 0, count: 0 },
      rerank: { total: 0, count: 0 }
    };

    this.stageStats = {};
    this.latestEvaluation = null;

    this.startTime = Date.now();
  }

  // ==================== 延迟记录 ====================

  /**
   * 记录单次延迟
   * @param {'ai'|'vectorSearch'|'parentChild'|'total'|'rerank'} type
   * @param {number} ms - 毫秒
   */
  recordLatency(type, ms) {
    if (!this.latencies[type]) return;
    this.latencies[type].push(ms);
    // 限制样本数：防止长期运行内存无限增长（getSummary 每次对全量数组排序）
    const MAX_SAMPLES = 1000;
    if (this.latencies[type].length > MAX_SAMPLES) {
      this.latencies[type].splice(0, this.latencies[type].length - MAX_SAMPLES);
    }
    this.latencyBuckets[type].total += ms;
    this.latencyBuckets[type].count++;
  }

  recordStage(type, durationMs = 0, success = true, errorType = null) {
    const key = type || 'unknown';
    if (!this.stageStats[key]) {
      this.stageStats[key] = { success: 0, failure: 0, totalDuration: 0, errors: {} };
    }

    const stats = this.stageStats[key];
    if (success) stats.success++;
    else stats.failure++;

    const parsedDuration = Number(durationMs);
    if (Number.isFinite(parsedDuration) && parsedDuration >= 0) {
      stats.totalDuration += parsedDuration;
    }

    if (!success && errorType) {
      stats.errors[errorType] = (stats.errors[errorType] || 0) + 1;
    }
  }

  /**
   * 创建计时器
   * @returns {Function} 调用时返回毫秒数
   */
  startTimer() {
    const start = Date.now();
    return () => Date.now() - start;
  }

  // ==================== RAG 指标 ====================

  recordRagQuery(options = {}) {
    this.rag.totalQueries++;
    if (options.usedRag) this.rag.ragQueries++;
    if (options.usedParentChild) this.rag.parentChildQueries++;
    if (options.matchedDocs) this.rag.matchedDocCount += options.matchedDocs;
    if (options.retrievedChunks) this.rag.totalRetrievedChunks += options.retrievedChunks;
    if (options.hasSources) this.rag.queriesWithSources += 1;
  }

  recordEvaluation({ metrics: evaluationMetrics, avgLatency = 0, sampleCount = 0, evaluatedAt = new Date().toISOString() } = {}) {
    if (!evaluationMetrics) return;
    this.latestEvaluation = {
      ...evaluationMetrics,
      avgLatency: Number(avgLatency) || 0,
      sampleCount: Number(sampleCount) || 0,
      evaluatedAt,
    };
  }

  // ==================== 聚合输出 ====================

  _percentile(arr, p) {
    if (!arr || arr.length === 0) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const idx = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, idx)];
  }

  _avg(arr) {
    if (!arr || arr.length === 0) return 0;
    return arr.reduce((s, v) => s + v, 0) / arr.length;
  }

  _getStageSummary() {
    const summary = {};
    for (const [name, stats] of Object.entries(this.stageStats)) {
      const total = stats.success + stats.failure;
      summary[name] = {
        success: stats.success,
        failure: stats.failure,
        total,
        successRate: total > 0 ? `${((stats.success / total) * 100).toFixed(1)}%` : '0%',
        avgDurationMs: total > 0 ? Math.round(stats.totalDuration / total) : 0,
        errors: stats.errors,
      };
    }
    return summary;
  }

  getSummary() {
    const uptime = Date.now() - this.startTime;
    const minutes = (uptime / 60000).toFixed(1);

    // 延迟统计
    const latencySummary = {};
    for (const [key, bucket] of Object.entries(this.latencyBuckets)) {
      if (bucket.count === 0) {
        latencySummary[key] = { avg: 0, p50: 0, p95: 0, p99: 0, count: 0 };
        continue;
      }
      latencySummary[key] = {
        avg: Math.round(bucket.total / bucket.count),
        p50: Math.round(this._percentile(this.latencies[key], 50)),
        p95: Math.round(this._percentile(this.latencies[key], 95)),
        p99: Math.round(this._percentile(this.latencies[key], 99)),
        count: bucket.count
      };
    }

    // RAG 指标
    const ragCoverage = this.rag.totalQueries > 0
      ? ((this.rag.parentChildQueries / this.rag.totalQueries) * 100).toFixed(1)
      : 0;
    const sourceCoverage = this.rag.ragQueries > 0
      ? ((this.rag.queriesWithSources / this.rag.ragQueries) * 100).toFixed(1)
      : 0;
    const avgMatchedDocs = this.rag.parentChildQueries > 0
      ? (this.rag.matchedDocCount / this.rag.parentChildQueries).toFixed(1)
      : 0;

    return {
      uptime: `${minutes} min`,
      latency: latencySummary,
      rag: {
        totalQueries: this.rag.totalQueries,
        ragQueries: this.rag.ragQueries,
        parentChildQueries: this.rag.parentChildQueries,
        parentChildCoverage: `${ragCoverage}%`,
        avgMatchedDocs,
        totalRetrievedChunks: this.rag.totalRetrievedChunks,
        sourceCoverage: `${sourceCoverage}%`,
      },
      evaluation: this.latestEvaluation,
      observability: {
        stages: this._getStageSummary(),
        alertThresholds: {
          errorRate: '>5%',
          llmFailureRate: '>10%',
          p95LatencyMs: 5000,
        },
      },
      timestamp: new Date().toISOString()
    };
  }

  /**
   * 获取 RAGAS 风格的真实评估结果
   * 基于实际检索结果与 ground_truth 的比较
   */
  async runRealEvaluation(testCases, ragEnabled = true) {
    const results = [];
    const { RagService } = require('../rag/rag.service');

    const ragService = new RagService();

    for (const tc of testCases) {
      const startTime = Date.now();

      try {
        let answer = '';
        let sources = [];
        let retrievedContext = '';

        if (ragEnabled) {
          // 真实调用 RAG 管道
          const ragResult = await ragService.chat(tc.question, []);
          answer = ragResult.reply || '';
          sources = ragResult.sources || [];
          retrievedContext = ragResult.context || '';
        } else {
const { aiService } = require('../llm/ai.service');

      // 纯 LLM 模式
      const llmResult = await aiService.getCompletion(tc.question, []);
          answer = llmResult.content;
        }

        const latency = Date.now() - startTime;

        // 计算指标
        const metrics = this._computeMetrics(tc, answer, retrievedContext, sources);

        results.push({
          id: tc.id,
          question: tc.question,
          category: tc.category || 'general',
          difficulty: tc.difficulty || 'medium',
          answer,
          ground_truth: tc.ground_truth,
          contexts: sources.map(s => s.title || s.id),
          metrics,
          latency,
          via: ragEnabled ? 'rag' : 'llm'
        });

      } catch (err) {
        results.push({
          id: tc.id,
          question: tc.question,
          category: tc.category || 'general',
          difficulty: tc.difficulty || 'medium',
          answer: `[错误: ${err.message}]`,
          ground_truth: tc.ground_truth,
          contexts: [],
          metrics: { faithfulness: 0, answer_relevancy: 0, context_precision: 0, context_recall: 0, overall: 0 },
          latency: Date.now() - startTime,
          via: ragEnabled ? 'rag' : 'llm',
          error: err.message
        });
      }
    }

    return results;
  }

  /**
   * 基于字符串匹配计算 RAGAS 风格指标（无需额外 LLM 调用）
   */
  _computeMetrics(testCase, answer, context, sources) {
    const gt = testCase.ground_truth || '';

    if (!gt || !answer) {
      return { faithfulness: 0, answer_relevancy: 0, context_precision: 0, context_recall: 0, overall: 0 };
    }

    // 1. Context Recall: ground_truth 中的关键词在 retrieved context 中的覆盖率
    const gtKeywords = this._extractKeywords(gt);
    const contextLower = context.toLowerCase();
    const matchedInContext = gtKeywords.filter(kw => contextLower.includes(kw.toLowerCase()));
    const contextRecall = gtKeywords.length > 0 ? matchedInContext.length / gtKeywords.length : 0;

    // 2. Answer Relevancy: 问题关键词在答案中的覆盖率
    const qKeywords = this._extractKeywords(testCase.question);
    const answerLower = answer.toLowerCase();
    const matchedInAnswer = qKeywords.filter(kw => answerLower.includes(kw.toLowerCase()));
    const answerRelevancy = qKeywords.length > 0 ? matchedInAnswer.length / qKeywords.length : 0;

    // 3. Faithfulness: 答案中的 claim 是否有 context 支撑
    // 简化版：答案中的 ground_truth 关键词覆盖率
    const answerLowerClean = answer.toLowerCase();
    const gtKeywordsInAnswer = gtKeywords.filter(kw => answerLowerClean.includes(kw.toLowerCase()));
    const faithfulness = gtKeywords.length > 0 ? gtKeywordsInAnswer.length / gtKeywords.length : 0;

    // 4. Context Precision: 检索到的文档中相关文档的比例
    // 近似：包含 ground_truth 关键词的检索文档 / 检索文档总数（无检索结果时为 0）
    let relevantSources = 0;
    for (const s of sources || []) {
      const snippet = String(s.snippet || s.content || s.text || '').toLowerCase();
      if (snippet && gtKeywords.some(kw => snippet.includes(kw.toLowerCase()))) {
        relevantSources++;
      }
    }
    const contextPrecision = (sources || []).length > 0 ? relevantSources / sources.length : 0;

    const overall = (contextRecall + answerRelevancy + faithfulness + contextPrecision) / 4;

    return {
      faithfulness: Math.round(faithfulness * 100) / 100,
      answer_relevancy: Math.round(answerRelevancy * 100) / 100,
      context_precision: Math.round(contextPrecision * 100) / 100,
      context_recall: Math.round(contextRecall * 100) / 100,
      overall: Math.round(overall * 100) / 100
    };
  }

  /**
   * 从文本中提取关键词（中文按字/词，英文按词）
   */
  _extractKeywords(text) {
    if (!text) return [];
    const keywords = new Set();

    // 英文单词
    const englishWords = text.match(/[a-zA-Z]{2,}/g) || [];
    englishWords.forEach(w => keywords.add(w.toLowerCase()));

    // 中文：提取 2-4 字组合 + 单字（去除标点）
    const chineseOnly = text.replace(/[^一-鿿]/g, '');
    if (chineseOnly.length > 0) {
      // 单字
      for (const char of chineseOnly) {
        keywords.add(char);
      }
      // 2-gram
      for (let i = 0; i < chineseOnly.length - 1; i++) {
        keywords.add(chineseOnly.substring(i, i + 2));
      }
      // 3-gram（仅前 10 个避免爆炸）
      for (let i = 0; i < Math.min(chineseOnly.length - 2, 10); i++) {
        keywords.add(chineseOnly.substring(i, i + 3));
      }
    }

    // 数字
    const numbers = text.match(/\d+/g) || [];
    numbers.forEach(n => keywords.add(n));

    return [...keywords];
  }
}

module.exports = { MetricsService, metrics: new MetricsService() };
