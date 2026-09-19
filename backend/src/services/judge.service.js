"use strict";

/**
 * Judge Service — LLM-as-judge 评测专用
 *
 * 使用独立 API Key 和模型（默认 step-3.5-flash），
 * 与生产流量（step-3.7-flash）完全隔离，互不抢配额。
 *
 * 用法：
 *   const judge = new JudgeService();
 *   const score = await judge.evaluate({ question, answer, context, ground_truth });
 */

const config = require('../config');
const { request } = require('../utils/httpClient');
const { operationalMetrics } = require('./operational-metrics.service');
const { logEvent } = require('./observability.service');

class JudgeService {
  constructor() {
    const cfg = config.judge || {};
    this.apiKey = cfg.apiKey;
    this.baseUrl = cfg.baseUrl;
    this.model = cfg.model;
    this.maxTokens = cfg.maxTokens;
    this.temperature = cfg.temperature;
    this.timeout = cfg.timeout;
  }

  _buildHeaders() {
    return {
      'Content-Type': 'application/json; charset=utf-8',
      'Authorization': `Bearer ${this.apiKey}`,
    };
  }

  _buildUrl() {
    const base = this.baseUrl.replace(/\/+$/, '');
    const hasVersion = /\/v\d+$/.test(base);
    return `${base}${hasVersion ? '' : '/v1'}/chat/completions`;
  }

  /**
   * 单次评测：一次请求算所有指标，减少 API 调用次数
   */
  async evaluate({ question, answer, context, ground_truth }) {
    if (!this.apiKey) {
      return this._fallbackEvaluation(answer, ground_truth);
    }

    const systemPrompt = `你是一个严格的 RAG 评测员。请评估以下回答的质量，只输出 JSON：

{
  "faithfulness": 0-1,        // 回答是否忠实于上下文，无幻觉
  "answer_relevancy": 0-1,    // 回答是否切题
  "context_precision": 0-1,   // 上下文是否包含回答问题所需信息
  "context_recall": 0-1,      // 上下文是否覆盖了 ground_truth 的关键信息
  "reason": "简短原因，一句话说明扣分点"
}`;

    const userPrompt = `## 问题
${question}

## 上下文（检索到的资料）
${context || '无'}

## 标准答案
${ground_truth || '无'}

## 模型回答
${answer}`;

    const url = this._buildUrl();
    const body = JSON.stringify({
      model: this.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: this.maxTokens,
      temperature: this.temperature,
    });

    const options = {
      hostname: new URL(url).hostname,
      path: new URL(url).pathname,
      method: 'POST',
      headers: { ...this._buildHeaders(), 'Content-Length': Buffer.byteLength(body, 'utf8') },
      timeout: this.timeout,
      retries: 2,
    };

    try {
      const start = Date.now();
      const res = await request(options, body);
      const latency = Date.now() - start;

      const content = res.data?.choices?.[0]?.message?.content || '';
      const usage = res.data?.usage || null;
      operationalMetrics.recordLlmUsage({ model: this.model, usage, latencyMs: latency });
      let metrics;
      try {
        metrics = JSON.parse(content);
      } catch {
        // 尝试从文本中提取 JSON 对象
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          metrics = JSON.parse(jsonMatch[0]);
        } else {
          throw new Error('无法解析 judge 输出: ' + content.substring(0, 100));
        }
      }
      logEvent('info', 'judge_evaluated', { latencyMs: latency, faithfulness: metrics.faithfulness, relevancy: metrics.answer_relevancy });

      return {
        ...metrics,
        latency,
        model: this.model,
        usage,
      };
    } catch (err) {
      logEvent('warn', 'judge_api_failed_keyword_fallback', { error: err.message });
      return {
        ...this._fallbackEvaluation(answer, ground_truth),
        latency: 0,
        model: 'fallback',
        error: err.message,
      };
    }
  }

  /**
   * 对话摘要压缩：将早期历史消息压缩成一段摘要（供滚动摘要使用）
   * 复用独立评测 Key/小模型，不抢占生产 LLM 配额。
   * @param {Array<{role:string, content:string}>} messages 被裁掉的早期消息
   * @returns {Promise<string|null>} 摘要文本；无 Key 或失败时返回 null
   */
  async summarize(messages) {
    if (!this.apiKey || !Array.isArray(messages) || messages.length === 0) return null;

    const text = messages
      .map(m => `${m.role === 'user' ? '用户' : '助手'}: ${String(m.content || '').slice(0, 500)}`)
      .join('\n');
    if (!text.trim()) return null;

    const systemPrompt = '你是对话摘要助手。请将以下多轮对话压缩成 100 字以内的中文摘要，保留关键事实（用户身份、专业、年级、偏好、已办事项、重要结论）。只输出摘要文本，不要解释。';
    const url = this._buildUrl();
    const body = JSON.stringify({
      model: this.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: text },
      ],
      max_tokens: this.maxTokens,
      temperature: 0,
    });

    const options = {
      hostname: new URL(url).hostname,
      path: new URL(url).pathname,
      method: 'POST',
      headers: { ...this._buildHeaders(), 'Content-Length': Buffer.byteLength(body, 'utf8') },
      timeout: this.timeout,
      retries: 2,
    };

    try {
      const start = Date.now();
      const res = await request(options, body);
      const latency = Date.now() - start;
      const content = res.data?.choices?.[0]?.message?.content || '';
      const summary = String(content || '').trim().slice(0, 300);
      if (summary) {
        logEvent('info', 'judge_summary_done', { messages: messages.length, summaryChars: summary.length, latencyMs: latency });
        return summary;
      }
      return null;
    } catch (err) {
      logEvent('warn', 'judge_summary_failed_truncate_fallback', { error: err.message });
      return null;
    }
  }

  /**
   * 关键词匹配降级
   */
  _fallbackEvaluation(answer, ground_truth) {
    if (!answer || !ground_truth) {
      return { faithfulness: 0, answer_relevancy: 0, context_precision: 0, context_recall: 0, reason: '缺少 ground_truth' };
    }
    const keywords = (ground_truth.match(/[a-zA-Z]{2,}|[一-鿿]{1,4}|\d+/g) || []).map(k => k.toLowerCase());
    const answerLower = answer.toLowerCase();
    const matched = keywords.filter(k => answerLower.includes(k));
    const recall = keywords.length > 0 ? matched.length / keywords.length : 0;

    return {
      faithfulness: recall,
      answer_relevancy: recall,
      // 降级路径没有检索上下文，无法计算真正的 precision，用 recall 近似
      context_precision: recall,
      context_recall: recall,
      reason: `关键词匹配: ${matched.length}/${keywords.length}`,
    };
  }
}

module.exports = { JudgeService };
