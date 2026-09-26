'use strict';

const crypto = require('crypto');
const appConfig = require('../../config');
const { logEvent } = require('../observability/observability.service');
const { operationalMetrics } = require('../observability/operational-metrics.service');

const ROUTE_DEFINITIONS = Object.freeze({
  chat: '普通对话、写作、翻译或不需要校园资料的通用问题',
  rag: '需要武汉理工校园知识、课程资料、文档或知识库证据的问题',
  agent: '需要多步规划、综合比较或工具协作的复杂任务',
});

const ROUTE_TO_INTENT = Object.freeze({
  chat: 'general_chat',
  rag: 'knowledge_query',
  agent: 'complex_task',
});

const ALLOWED_ROUTES = new Set(Object.keys(ROUTE_DEFINITIONS));
const RETRYABLE_STATUS_CODES = new Set([429, 529]);
const DEFAULT_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';

class JevDecisionError extends Error {
  constructor(message, code = 'JEV_DECISION_FAILED', details = {}) {
    super(message);
    this.name = 'JevDecisionError';
    this.code = code;
    Object.assign(this, details);
  }
}

function clamp(value, min, max, fallback = min) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(number, min), max);
}

function normalizeMode(value, enabled = false) {
  const mode = String(value || '').trim().toLowerCase();
  if (['off', 'shadow', 'canary', 'enforce'].includes(mode)) return mode;
  return enabled ? 'shadow' : 'off';
}

function stableBucket(value) {
  const digest = crypto.createHash('sha256').update(String(value || 'anonymous')).digest();
  return digest.readUInt16BE(0) % 10000 / 100;
}

function truncate(value, maxLength) {
  const text = String(value ?? '');
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function normalizeHistory(history, options = {}) {
  if (!Array.isArray(history)) return [];
  const maxItems = clamp(options.maxItems, 0, 20, 4);
  const maxChars = clamp(options.maxChars, 100, 4000, 1200);
  return history
    .slice(-maxItems)
    .map((item) => ({
      role: ['user', 'assistant', 'system'].includes(item?.role) ? item.role : 'user',
      content: truncate(item?.content, maxChars),
    }))
    .filter((item) => item.content.trim());
}

function normalizeProbabilities(probabilities) {
  if (!probabilities || typeof probabilities !== 'object' || Array.isArray(probabilities)) return {};
  const result = {};
  for (const route of ALLOWED_ROUTES) {
    const value = Number(probabilities[route]);
    if (Number.isFinite(value)) result[route] = clamp(value, 0, 1, 0);
  }
  return result;
}

function maxProbability(probabilities) {
  return Object.values(probabilities).reduce((max, value) => Math.max(max, value), 0);
}

function buildRouteQuestions() {
  return {
    route: {
      type: 'choice',
      instructions: '选择最适合处理这条用户消息的单一业务链路。只根据输入状态判断，不要生成解释。',
      criteria: ROUTE_DEFINITIONS,
    },
  };
}

class JevDecisionService {
  constructor(options = {}) {
    this.config = options.config || appConfig.jev || {};
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    this.now = options.now || Date.now;
    this.sleep = options.sleep || ((milliseconds, signal) => new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new JevDecisionError('Jev 请求已取消', 'JEV_ABORTED'));
        return;
      }
      let timer;
      const onAbort = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        reject(new JevDecisionError('Jev 请求已取消', 'JEV_ABORTED'));
      };
      timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, milliseconds);
      signal?.addEventListener('abort', onAbort, { once: true });
    }));
  }

  get mode() {
    return normalizeMode(this.config.mode, this.config.enabled === true);
  }

  get endpoint() {
    return String(this.config.endpoint || DEFAULT_ENDPOINT).trim();
  }

  get model() {
    return String(this.config.model || 'jev-latest').trim() || 'jev-latest';
  }

  get apiKey() {
    return String(this.config.apiKey || '').trim();
  }

  get enabled() {
    return this.config.enabled !== false
      && this.mode !== 'off'
      && Boolean(this.apiKey)
      && Boolean(this.endpoint)
      && typeof this.fetchImpl === 'function';
  }

  get rolloutPercent() {
    const fallback = this.mode === 'canary' ? 0 : 100;
    return clamp(this.config.rolloutPercent, 0, 100, fallback);
  }

  get minConfidence() {
    return clamp(this.config.minConfidence, 0, 1, 0.55);
  }

  get policyVersion() {
    return truncate(this.config.policyVersion || 'route-v1', 80);
  }

  shouldEvaluate({ runId, traceId, key } = {}) {
    if (!this.enabled) return false;
    if (this.mode === 'shadow') return true;
    if (this.rolloutPercent <= 0) return false;
    if (this.rolloutPercent >= 100) return true;
    return stableBucket(key || runId || traceId) < this.rolloutPercent;
  }

  buildRequest({ message, history = [] } = {}) {
    const state = {
      message: truncate(message, clamp(this.config.maxMessageChars, 100, 12000, 4000)),
    };
    if (this.config.includeHistory === true) {
      state.history = normalizeHistory(history, {
        maxItems: this.config.maxHistoryItems,
        maxChars: this.config.maxHistoryChars,
      });
    }
    return {
      state,
      model: this.model,
      questions: buildRouteQuestions(),
    };
  }

  async decideRoute({ message, history = [], signal, traceId = null, enforceConfidence = true } = {}) {
    if (!this.enabled) throw new JevDecisionError('Jev 决策服务未启用或缺少 API Key', 'JEV_DISABLED');
    const startedAt = this.now();
    try {
      const payload = await this._request(this.buildRequest({ message, history }), signal);
      const normalized = this._normalizeResponse(payload, { enforceConfidence });
      const latencyMs = Math.max(0, this.now() - startedAt);
      const decision = {
        provider: 'jev',
        model: truncate(payload.model || this.model, 80),
        policyVersion: this.policyVersion,
        decisionId: `jev_${crypto.randomUUID?.() || crypto.randomBytes(16).toString('hex')}`,
        mode: this.mode,
        confidence: normalized.confidence,
        probabilities: normalized.probabilities,
        latencyMs,
        status: 'success',
        applied: false,
      };
      operationalMetrics.recordDecision?.({
        status: 'success',
        mode: this.mode,
        latencyMs,
        traceId,
      });
      logEvent('info', 'jev_decision_completed', {
        decisionId: decision.decisionId,
        mode: this.mode,
        route: normalized.route,
        confidence: normalized.confidence,
        latencyMs,
        traceId,
      });
      return { ...normalized, decision };
    } catch (error) {
      const latencyMs = Math.max(0, this.now() - startedAt);
      operationalMetrics.recordDecision?.({
        status: error.code === 'JEV_TIMEOUT' ? 'timeout' : 'error',
        mode: this.mode,
        latencyMs,
        fallback: true,
        traceId,
      });
      logEvent('warn', 'jev_decision_failed', {
        code: error.code || 'JEV_DECISION_FAILED',
        mode: this.mode,
        latencyMs,
        status: error.status,
        error: error.message,
        traceId,
      });
      throw error;
    }
  }

  _normalizeResponse(payload, { enforceConfidence }) {
    const answer = payload?.answers?.route;
    if (!answer || typeof answer !== 'object') {
      throw new JevDecisionError('Jev 响应缺少 answers.route', 'JEV_INVALID_RESPONSE');
    }
    const route = String(answer.choice || '').trim().toLowerCase();
    if (!ALLOWED_ROUTES.has(route)) {
      throw new JevDecisionError(`Jev 返回了不允许的路由：${route || 'empty'}`, 'JEV_INVALID_ROUTE');
    }
    const probabilities = normalizeProbabilities(answer.probabilities);
    const confidence = clamp(answer.confidence, 0, 1, probabilities[route] ?? maxProbability(probabilities));
    if (enforceConfidence && confidence < this.minConfidence) {
      throw new JevDecisionError(`Jev 置信度过低：${confidence}`, 'JEV_LOW_CONFIDENCE', { confidence });
    }
    return {
      intent: ROUTE_TO_INTENT[route],
      confidence,
      params: {},
      route,
      tool: null,
      reason: `Jev 结构化决策：${route}`,
      probabilities,
    };
  }

  async _request(body, signal) {
    const maxRetries = Math.floor(clamp(this.config.maxRetries, 0, 2, 1));
    let attempt = 0;
    while (true) {
      try {
        const response = await this._fetchWithTimeout(body, signal);
        const payload = await this._readResponse(response);
        const status = Number(response.status || 0);
        const ok = response.ok !== undefined ? response.ok : status >= 200 && status < 300;
        if (ok) return payload;
        if (RETRYABLE_STATUS_CODES.has(status) && attempt < maxRetries) {
          await this.sleep(Math.min(2000, 250 * (2 ** attempt)), signal);
          attempt += 1;
          continue;
        }
        throw new JevDecisionError(
          `Jev API 请求失败（HTTP ${status || 'unknown'}）`,
          'JEV_API_ERROR',
          { status, response: payload },
        );
      } catch (error) {
        if (error instanceof JevDecisionError && error.code === 'JEV_ABORTED') throw error;
        if (error instanceof JevDecisionError && error.status && RETRYABLE_STATUS_CODES.has(error.status) && attempt < maxRetries) {
          await this.sleep(Math.min(2000, 250 * (2 ** attempt)), signal);
          attempt += 1;
          continue;
        }
        if (error instanceof JevDecisionError) throw error;
        throw new JevDecisionError(error.message || 'Jev 网络请求失败', 'JEV_NETWORK_ERROR', { cause: error });
      }
    }
  }

  async _fetchWithTimeout(body, parentSignal) {
    if (parentSignal?.aborted) throw new JevDecisionError('Jev 请求已取消', 'JEV_ABORTED');
    const controller = new AbortController();
    const timeoutMs = Math.floor(clamp(this.config.timeoutMs, 100, 15000, 1200));
    let timedOut = false;
    let parentAborted = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const onParentAbort = () => {
      parentAborted = true;
      controller.abort(parentSignal.reason);
    };
    parentSignal?.addEventListener('abort', onParentAbort, { once: true });
    try {
      return await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      if (parentAborted) throw new JevDecisionError('Jev 请求已取消', 'JEV_ABORTED', { cause: error });
      if (timedOut) throw new JevDecisionError(`Jev 请求超时（${timeoutMs}ms）`, 'JEV_TIMEOUT', { cause: error });
      throw error;
    } finally {
      clearTimeout(timer);
      parentSignal?.removeEventListener('abort', onParentAbort);
    }
  }

  async _readResponse(response) {
    let text = '';
    try {
      if (typeof response?.text === 'function') text = await response.text();
      else if (typeof response?.json === 'function') return await response.json();
    } catch (error) {
      throw new JevDecisionError('无法读取 Jev 响应', 'JEV_INVALID_RESPONSE', { cause: error });
    }
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      return { raw: truncate(text, 500) };
    }
  }
}

module.exports = {
  ALLOWED_ROUTES,
  DEFAULT_ENDPOINT,
  JevDecisionError,
  JevDecisionService,
  ROUTE_DEFINITIONS,
  normalizeHistory,
  normalizeMode,
  stableBucket,
};
