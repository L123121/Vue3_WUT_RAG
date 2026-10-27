'use strict';

/**
 * JEV 结构化决策模型客户端（NeoHorse-Jev-4B @ tokenrhythm.studio）。
 *
 * JEV 不是聊天模型：调用方给出 state（背景/待判断内容）+ questions（问题集合），
 * 模型返回每个问题的结构化答案。当前支持文档化的两类问题：
 *   - noul：返回 0~1 的成立概率，业务阈值由调用方决定
 *   - choice：返回单选结果（兼容旧 System One 协议）
 *
 * 本服务提供两种用法：
 *   1. decideRoute()：内部意图路由（chat / rag / agent），三个 noul 问题取 argmax
 *   2. decide()：通用结构化决策，供 /api/decision 直连使用（文档最小示例即可跑）
 *
 * 灰度与降级：模型可能仅对灰度账号开放（HTTP 403 MODEL_ACCESS_DENIED）。
 * 命中后进入冷却期（默认 5 分钟），期间 shouldEvaluate() 直接返回 false，
 * 编排层静默走基线路由，不再逐条请求。冷却结束自动重试，账号被放量后无需重启。
 */

const crypto = require('crypto');
const appConfig = require('../../config');
const { logEvent } = require('../observability/observability.service');
const { operationalMetrics } = require('../observability/operational-metrics.service');
const { intentOfRoute, isAllowedRoute, ALLOWED_ROUTES, ROUTE_NAMES } = require('./route-registry');

const ROUTE_DEFINITIONS = Object.freeze({
  chat: '普通对话、写作、翻译或不需要校园资料的通用问题',
  rag: '需要武汉理工校园知识、课程资料、文档或知识库证据的问题',
  agent: '需要多步规划、综合比较或工具协作的复杂任务',
});

// 路由问题指令：单选，要求只判断不解释（与旧 System One choice 协议一致）
const ROUTE_INSTRUCTIONS = '选择最适合处理这条用户消息的单一业务链路。只根据输入状态判断，不要生成解释。';

// 官方推荐端点；System One 兼容格式为同域 /v1/systemone（请求体一致）
const DEFAULT_ENDPOINT = 'https://tokenrhythm.studio/v1/decision';
const DEFAULT_MODEL = 'NeoHorse-Jev-4B';

// 只解析文档化的两类问题：noul（0~1 成立概率）与 choice（单选）
const SUPPORTED_QUESTION_TYPES = Object.freeze(['noul', 'choice']);
const QUESTION_ID_PATTERN = /^[A-Za-z0-9_.-]{1,40}$/;
const QUESTION_KEYS = Object.freeze(['type', 'instructions', 'criteria']);

// noul 答案字段名：实测 /v1/decision 返回 { type:'noul', noul:0.97, probabilities:{true,false} }，
// 同时兼容 probability / prob / p 等常见命名（历史 System One 实现）
const PROBABILITY_KEYS = Object.freeze(['noul', 'probability', 'prob', 'p', 'score', 'value', 'likelihood', 'confidence']);

const RETRYABLE_STATUS_CODES = new Set([429, 529]);
const MODEL_ACCESS_DENIED_CODE = 'MODEL_ACCESS_DENIED';

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

function toProbability(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return clamp(number, 0, 1, 0);
}

function safeHost(endpoint) {
  try {
    return new URL(endpoint).host;
  } catch {
    return '';
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
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

/**
 * 路由问题：单选（choice）+ criteria 描述三条链路。
 *
 * 实测（2026-10-27，NeoHorse-Jev-4B）单选显著优于"每路由一个 noul 取 argmax"：
 * 单选 6/6 命中且分布分明（chat 0.99 / rag 0.63~0.98 / agent 0.54），
 * 三问 noul 会把"推免保研需要什么材料"判成 chat 0.97。
 * 三问 noul 仍保留为解析兼容路径，供其它部署按 noul 提问时使用。
 */
function buildRouteQuestions() {
  return {
    route: {
      type: 'choice',
      instructions: ROUTE_INSTRUCTIONS,
      criteria: { ...ROUTE_DEFINITIONS },
    },
  };
}

/** 归一化 state：字符串按长度截断拒绝，结构化 JSON 按序列化长度校验 */
function normalizeState(state, maxChars = 8000) {
  if (state === null || state === undefined) {
    throw new JevDecisionError('state 不能为空', 'JEV_INVALID_REQUEST', { httpStatus: 400 });
  }
  if (typeof state === 'string') {
    const text = state.trim();
    if (!text) throw new JevDecisionError('state 不能为空字符串', 'JEV_INVALID_REQUEST', { httpStatus: 400 });
    if (text.length > maxChars) {
      throw new JevDecisionError(`state 超过长度上限（${maxChars} 字符）`, 'JEV_INVALID_REQUEST', { httpStatus: 400 });
    }
    return text;
  }
  if (isPlainObject(state)) {
    let serialized;
    try {
      serialized = JSON.stringify(state);
    } catch {
      throw new JevDecisionError('state 不是可序列化的 JSON 对象', 'JEV_INVALID_REQUEST', { httpStatus: 400 });
    }
    if (serialized.length > maxChars) {
      throw new JevDecisionError(`state 超过长度上限（${maxChars} 字符）`, 'JEV_INVALID_REQUEST', { httpStatus: 400 });
    }
    return state;
  }
  throw new JevDecisionError('state 必须是字符串或 JSON 对象', 'JEV_INVALID_REQUEST', { httpStatus: 400 });
}

/** 校验并瘦身 questions：id 可自定义，但只放行文档化字段，避免上游因未知字段报错 */
function normalizeQuestions(questions, options = {}) {
  const maxQuestions = clamp(options.maxQuestions, 1, 20, 8);
  const maxInstructionsChars = clamp(options.maxInstructionsChars, 20, 5000, 2000);

  if (!isPlainObject(questions)) {
    throw new JevDecisionError('questions 必须是对象（键为问题 ID）', 'JEV_INVALID_REQUEST', { httpStatus: 400 });
  }
  const ids = Object.keys(questions);
  if (ids.length === 0) {
    throw new JevDecisionError('questions 至少需要一个问题', 'JEV_INVALID_REQUEST', { httpStatus: 400 });
  }
  if (ids.length > maxQuestions) {
    throw new JevDecisionError(`questions 最多 ${maxQuestions} 个问题`, 'JEV_INVALID_REQUEST', { httpStatus: 400 });
  }

  const result = {};
  for (const id of ids) {
    if (!QUESTION_ID_PATTERN.test(id)) {
      throw new JevDecisionError(
        `问题 ID「${truncate(id, 40)}」不合法（限字母、数字、下划线、点、连字符，1-40 字符）`,
        'JEV_INVALID_REQUEST',
        { httpStatus: 400 },
      );
    }
    const question = questions[id];
    if (!isPlainObject(question)) {
      throw new JevDecisionError(`问题「${id}」必须是对象`, 'JEV_INVALID_REQUEST', { httpStatus: 400 });
    }
    const unknownKey = Object.keys(question).find((key) => !QUESTION_KEYS.includes(key));
    if (unknownKey) {
      throw new JevDecisionError(`问题「${id}」包含未知字段「${unknownKey}」`, 'JEV_INVALID_REQUEST', { httpStatus: 400 });
    }
    const type = String(question.type || '').trim().toLowerCase();
    if (!SUPPORTED_QUESTION_TYPES.includes(type)) {
      throw new JevDecisionError(
        `问题「${id}」的 type 必须是 ${SUPPORTED_QUESTION_TYPES.join(' / ')}`,
        'JEV_INVALID_REQUEST',
        { httpStatus: 400 },
      );
    }
    const instructions = typeof question.instructions === 'string' ? question.instructions.trim() : '';
    if (!instructions) {
      throw new JevDecisionError(`问题「${id}」缺少 instructions`, 'JEV_INVALID_REQUEST', { httpStatus: 400 });
    }
    if (instructions.length > maxInstructionsChars) {
      throw new JevDecisionError(
        `问题「${id}」的 instructions 超过 ${maxInstructionsChars} 字符`,
        'JEV_INVALID_REQUEST',
        { httpStatus: 400 },
      );
    }

    // choice 题的候选项说明（可选）：键为选项名，值为口径描述
    let criteria;
    if (question.criteria !== undefined) {
      if (!isPlainObject(question.criteria)) {
        throw new JevDecisionError(`问题「${id}」的 criteria 必须是对象`, 'JEV_INVALID_REQUEST', { httpStatus: 400 });
      }
      const entries = Object.entries(question.criteria);
      if (entries.length === 0 || entries.length > 20) {
        throw new JevDecisionError(`问题「${id}」的 criteria 需为 1-20 个选项`, 'JEV_INVALID_REQUEST', { httpStatus: 400 });
      }
      criteria = {};
      for (const [key, value] of entries) {
        if (!QUESTION_ID_PATTERN.test(key)) {
          throw new JevDecisionError(`问题「${id}」的 criteria 键「${truncate(key, 40)}」不合法`, 'JEV_INVALID_REQUEST', { httpStatus: 400 });
        }
        const text = typeof value === 'string' ? value.trim() : '';
        if (!text) {
          throw new JevDecisionError(`问题「${id}」的 criteria「${key}」必须是非空字符串`, 'JEV_INVALID_REQUEST', { httpStatus: 400 });
        }
        criteria[key] = truncate(text, 200);
      }
    }

    result[id] = { type, instructions, ...(criteria ? { criteria } : {}) };
  }
  return result;
}

/** 文档口径：/v1/decision 优先 input_tokens，缺失时回退 expanded_tokens，两者不相加 */
function normalizeUsage(usage) {
  if (!isPlainObject(usage)) {
    return { inputTokens: null, outputTokens: null, totalTokens: null, source: 'unknown', raw: null };
  }
  const packagedInput = toInteger(usage.input_tokens ?? usage.prompt_tokens);
  const expandedInput = toInteger(usage.input_details?.expanded_tokens);
  const outputTokens = toInteger(usage.output_tokens ?? usage.completion_tokens);

  let inputTokens = null;
  let source = 'unknown';
  if (packagedInput !== null) {
    inputTokens = packagedInput;
    source = 'input_tokens';
  } else if (expandedInput !== null) {
    inputTokens = expandedInput;
    source = 'expanded_tokens';
  }

  const declaredTotal = toInteger(usage.total_tokens);
  const totalTokens = declaredTotal !== null
    ? declaredTotal
    : (inputTokens !== null || outputTokens !== null ? (inputTokens || 0) + (outputTokens || 0) : null);

  return {
    inputTokens,
    outputTokens,
    totalTokens,
    source,
    raw: {
      input_tokens: packagedInput,
      expanded_tokens: expandedInput,
      output_tokens: outputTokens,
    },
  };
}

function toInteger(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : null;
}

/**
 * 用量字段位置因端点而异：
 *   /v1/decision  → 顶层 input_tokens + input_details（无 usage 包裹）
 *   /v1/systemone → usage.input_tokens / usage.output_tokens
 * 两边都兼容；两边都没有时返回 unknown，不臆造 0。
 */
function extractUsage(payload) {
  if (isPlainObject(payload?.usage) && Object.keys(payload.usage).length > 0) {
    return normalizeUsage(payload.usage);
  }
  return normalizeUsage(payload);
}

function toSeconds(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function pickProbability(answer) {
  if (typeof answer === 'number') return toProbability(answer);
  if (!isPlainObject(answer)) return null;
  for (const key of PROBABILITY_KEYS) {
    const value = toProbability(answer[key]);
    if (value !== null) return value;
  }
  // noul 是二值题：只有 noul 字段缺失时才回退到 probabilities.true
  const trueProbability = toProbability(answer.probabilities?.true);
  if (trueProbability !== null) return trueProbability;
  return null;
}

function toProbabilityMap(input) {
  if (!isPlainObject(input)) return {};
  const result = {};
  for (const [key, value] of Object.entries(input)) {
    const probability = toProbability(value);
    if (probability !== null) result[String(key).slice(0, 40)] = probability;
  }
  return result;
}

function parseAnswer(answer, type, id) {
  if (answer === null || answer === undefined) {
    throw new JevDecisionError(`Jev 响应缺少问题「${id}」的答案`, 'JEV_INVALID_RESPONSE', { httpStatus: 502 });
  }
  if (type === 'choice') {
    const choice = typeof answer === 'string' ? answer : answer?.choice;
    if (!choice || typeof choice !== 'string') {
      throw new JevDecisionError(`Jev 响应的问题「${id}」缺少 choice`, 'JEV_INVALID_RESPONSE', { httpStatus: 502 });
    }
    return {
      type,
      choice: truncate(choice.trim(), 80),
      confidence: toProbability(answer?.confidence),
      probabilities: toProbabilityMap(answer?.probabilities),
    };
  }
  const probability = pickProbability(answer);
  if (probability === null) {
    throw new JevDecisionError(`Jev 响应的问题「${id}」缺少可解析的概率值`, 'JEV_INVALID_RESPONSE', { httpStatus: 502 });
  }
  return { type, probability };
}

/** 按请求里的问题 ID 逐个读取答案；缺答案视为协议错误，不静默补默认值 */
function normalizeAnswers(answers, questions) {
  if (!isPlainObject(answers)) {
    throw new JevDecisionError('Jev 响应缺少 answers', 'JEV_INVALID_RESPONSE', { httpStatus: 502 });
  }
  const result = {};
  const missing = [];
  for (const [id, question] of Object.entries(questions)) {
    if (!(id in answers)) {
      missing.push(id);
      continue;
    }
    result[id] = parseAnswer(answers[id], question.type, id);
  }
  if (missing.length > 0) {
    throw new JevDecisionError(`Jev 响应缺少问题答案：${missing.join(', ')}`, 'JEV_INVALID_RESPONSE', {
      httpStatus: 502,
      missing,
    });
  }
  return result;
}

/**
 * 从 answers 解析路由（两种返回形态都认）：
 *   主路径：answers.route = { choice, probabilities, confidence }（单选协议）
 *   兼容路径：按路由拆成多个 noul 问题（answers.chat / rag / agent），按概率取最大
 */
function normalizeRouteAnswer(payload) {
  const answers = payload?.answers;
  if (!isPlainObject(answers)) {
    throw new JevDecisionError('Jev 响应缺少 answers', 'JEV_INVALID_RESPONSE', { httpStatus: 502 });
  }

  const routeAnswer = answers.route;
  if (isPlainObject(routeAnswer) && typeof routeAnswer.choice === 'string' && routeAnswer.choice.trim()) {
    const route = routeAnswer.choice.trim().toLowerCase();
    if (!isAllowedRoute(route)) {
      throw new JevDecisionError(`Jev 返回了不允许的路由：${route}`, 'JEV_INVALID_ROUTE', { httpStatus: 502 });
    }
    const probabilities = {};
    for (const name of ROUTE_NAMES) {
      const probability = toProbability(routeAnswer.probabilities?.[name]);
      if (probability !== null) probabilities[name] = probability;
    }
    const confidence = toProbability(routeAnswer.confidence)
      ?? probabilities[route]
      ?? maxProbability(probabilities);
    return { route, probabilities, confidence };
  }

  const probabilities = {};
  for (const route of ROUTE_NAMES) {
    const probability = pickProbability(answers[route]);
    if (probability !== null) probabilities[route] = probability;
  }
  if (Object.keys(probabilities).length === 0) {
    throw new JevDecisionError('Jev 响应既没有 answers.route，也没有各路由的概率答案', 'JEV_INVALID_RESPONSE', {
      httpStatus: 502,
      answerKeys: Object.keys(answers).slice(0, 10),
    });
  }
  const [route, confidence] = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0];
  return { route, probabilities, confidence };
}

function maxProbability(probabilities) {
  return Object.values(probabilities).reduce((max, value) => Math.max(max, value), 0);
}

class JevDecisionService {
  constructor(options = {}) {
    this.config = options.config || appConfig.jev || {};
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    this.now = options.now || Date.now;
    this.sleep = options.sleep || ((milliseconds, signal) => new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new JevDecisionError('Jev 请求已取消', 'JEV_ABORTED', { httpStatus: 499 }));
        return;
      }
      let timer;
      const onAbort = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        reject(new JevDecisionError('Jev 请求已取消', 'JEV_ABORTED', { httpStatus: 499 }));
      };
      timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, milliseconds);
      signal?.addEventListener('abort', onAbort, { once: true });
    }));

    // 灰度未放量时的熔断：命中 MODEL_ACCESS_DENIED 后冷却，期间不再发请求
    this._unavailableUntil = 0;
    this._lastFailure = null;
  }

  get mode() {
    return normalizeMode(this.config.mode, this.config.enabled === true);
  }

  get endpoint() {
    return String(this.config.endpoint || DEFAULT_ENDPOINT).trim();
  }

  get model() {
    return String(this.config.model || DEFAULT_MODEL).trim() || DEFAULT_MODEL;
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

  /** 启用且不在灰度冷却期 */
  get available() {
    return this.enabled && this.now() >= this._unavailableUntil;
  }

  get retryAfterMs() {
    return Math.max(0, this._unavailableUntil - this.now());
  }

  get unavailableCooldownMs() {
    return clamp(this.config.unavailableCooldownMs, 0, 3600000, 300000);
  }

  get maxStateChars() {
    return clamp(this.config.maxStateChars, 100, 50000, 8000);
  }

  get maxQuestions() {
    return clamp(this.config.maxQuestions, 1, 20, 8);
  }

  get maxInstructionsChars() {
    return clamp(this.config.maxInstructionsChars, 20, 5000, 2000);
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

  /** 给 /api/decision/status 与 /api/health 用的无密钥快照 */
  getAvailability() {
    const available = this.available;
    return {
      provider: 'jev',
      model: this.model,
      endpointHost: safeHost(this.endpoint),
      mode: this.mode,
      enabled: this.enabled,
      available,
      status: !this.enabled ? 'disabled' : (available ? 'available' : 'unavailable'),
      retryAfterMs: this.retryAfterMs,
      lastFailure: this._lastFailure,
      questionTypes: [...SUPPORTED_QUESTION_TYPES],
    };
  }

  shouldEvaluate({ runId, traceId, key } = {}) {
    if (!this.available) return false;
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
      model: this.model,
      state,
      questions: buildRouteQuestions(),
    };
  }

  /**
   * 通用结构化决策：调用方自定义 state 与 questions。
   * 返回逐问题的结构化答案 + Token 用量（口径见 normalizeUsage）。
   */
  async decide({ state, questions, signal, traceId = null } = {}) {
    const normalizedState = normalizeState(state, this.maxStateChars);
    const normalizedQuestions = normalizeQuestions(questions, {
      maxQuestions: this.maxQuestions,
      maxInstructionsChars: this.maxInstructionsChars,
    });

    const { payload, result, latencyMs } = await this._execute(
      { model: this.model, state: normalizedState, questions: normalizedQuestions },
      {
        signal,
        traceId,
        mode: 'direct',
        parse: (response) => ({
          answers: normalizeAnswers(response.answers, normalizedQuestions),
          usage: extractUsage(response),
        }),
      },
    );

    const output = {
      provider: 'jev',
      model: truncate(payload.model || this.model, 80),
      upstreamTraceId: payload.traceId ? truncate(payload.traceId, 80) : null,
      answers: result.answers,
      usage: result.usage,
      decisionSeconds: toSeconds(payload.decision_seconds),
      latencyMs,
      decisionId: this._newDecisionId(),
      traceId: traceId || null,
    };

    logEvent('info', 'jev_decision_api_completed', {
      decisionId: output.decisionId,
      model: output.model,
      latencyMs,
      questions: Object.keys(normalizedQuestions),
      inputTokens: result.usage.inputTokens,
      inputTokenSource: result.usage.source,
      traceId: output.traceId,
    });

    return output;
  }

  async decideRoute({ message, history = [], signal, traceId = null, enforceConfidence = true } = {}) {
    const { payload, result, latencyMs } = await this._execute(
      this.buildRequest({ message, history }),
      {
        signal,
        traceId,
        mode: this.mode,
        parse: (response) => {
          const derived = normalizeRouteAnswer(response);
          if (enforceConfidence && derived.confidence < this.minConfidence) {
            throw new JevDecisionError(`Jev 置信度过低：${derived.confidence}`, 'JEV_LOW_CONFIDENCE', {
              httpStatus: 502,
              confidence: derived.confidence,
            });
          }
          return derived;
        },
      },
    );

    const decision = {
      provider: 'jev',
      model: truncate(payload.model || this.model, 80),
      policyVersion: this.policyVersion,
      decisionId: this._newDecisionId(),
      mode: this.mode,
      confidence: result.confidence,
      probabilities: result.probabilities,
      latencyMs,
      usage: extractUsage(payload),
      decisionSeconds: toSeconds(payload.decision_seconds),
      status: 'success',
      applied: false,
    };

    logEvent('info', 'jev_decision_completed', {
      decisionId: decision.decisionId,
      mode: this.mode,
      route: result.route,
      confidence: result.confidence,
      latencyMs,
      traceId,
    });

    return {
      intent: intentOfRoute(result.route),
      confidence: result.confidence,
      params: {},
      route: result.route,
      tool: null,
      reason: `Jev 结构化决策：${result.route}`,
      probabilities: result.probabilities,
      decision,
    };
  }

  _newDecisionId() {
    return `jev_${crypto.randomUUID?.() || crypto.randomBytes(16).toString('hex')}`;
  }

  _assertCallable() {
    if (!this.enabled) {
      throw new JevDecisionError('Jev 决策服务未启用或缺少 API Key', 'JEV_DISABLED', { httpStatus: 503 });
    }
    if (!this.available) {
      throw new JevDecisionError('Jev 模型暂无访问权限（账号未在灰度名单内），已进入冷却', 'JEV_UNAVAILABLE', {
        httpStatus: 503,
        unavailable: true,
        retryAfterMs: this.retryAfterMs,
      });
    }
  }

  /** 统一执行：超时/重试/协议解析/指标/日志，解析失败同样计入失败指标 */
  async _execute(body, { signal, traceId, mode, parse }) {
    this._assertCallable();
    const startedAt = this.now();
    try {
      const payload = await this._request(body, signal);
      const result = parse(payload);
      const latencyMs = Math.max(0, this.now() - startedAt);
      this._lastFailure = null;
      operationalMetrics.recordDecision?.({ status: 'success', mode, latencyMs, traceId });
      return { payload, result, latencyMs };
    } catch (error) {
      const latencyMs = Math.max(0, this.now() - startedAt);
      operationalMetrics.recordDecision?.({
        status: error.code === 'JEV_TIMEOUT' ? 'timeout' : 'error',
        mode,
        latencyMs,
        fallback: mode !== 'direct',
        traceId,
      });
      logEvent('warn', 'jev_decision_failed', {
        code: error.code || 'JEV_DECISION_FAILED',
        mode,
        latencyMs,
        status: error.status,
        error: error.message,
        traceId,
      });
      if (error.code === 'JEV_MODEL_ACCESS_DENIED') this._tripBreaker(error);
      throw error;
    }
  }

  /** 403 灰度限制：进入冷却，期间 shouldEvaluate=false，不逐条打上游 */
  _tripBreaker(error) {
    const wasAvailable = this.available;
    this._unavailableUntil = this.now() + this.unavailableCooldownMs;
    this._lastFailure = {
      code: error.code,
      message: truncate(error.message, 200),
      status: error.status ?? null,
      at: new Date(this.now()).toISOString(),
    };
    if (wasAvailable) {
      logEvent('warn', 'jev_model_access_denied', {
        message: 'JEV 模型仅对灰度用户开放，已进入冷却期并回退基线路由',
        model: this.model,
        endpointHost: safeHost(this.endpoint),
        cooldownMs: this.unavailableCooldownMs,
      });
    }
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

        throw this._httpError(status, payload);
      } catch (error) {
        if (error instanceof JevDecisionError && error.code === 'JEV_ABORTED') throw error;
        if (error instanceof JevDecisionError && error.status && RETRYABLE_STATUS_CODES.has(error.status) && attempt < maxRetries) {
          await this.sleep(Math.min(2000, 250 * (2 ** attempt)), signal);
          attempt += 1;
          continue;
        }
        if (error instanceof JevDecisionError) throw error;
        throw new JevDecisionError(error.message || 'Jev 网络请求失败', 'JEV_NETWORK_ERROR', {
          cause: error,
          httpStatus: 502,
        });
      }
    }
  }

  /** 上游错误码 → 本地错误；403 灰度限制单独识别，供熔断使用 */
  _httpError(status, payload) {
    const upstreamCode = typeof payload?.code === 'string' ? payload.code : '';
    const upstreamMessage = typeof payload?.message === 'string' ? payload.message : '';
    const detail = {
      status,
      httpStatus: status === 403 ? 503 : 502,
      upstreamCode: upstreamCode || null,
      upstreamMessage: upstreamMessage || null,
    };

    if (status === 403 && upstreamCode === MODEL_ACCESS_DENIED_CODE) {
      return new JevDecisionError(
        upstreamMessage || '当前模型仅对灰度用户开放',
        'JEV_MODEL_ACCESS_DENIED',
        { ...detail, unavailable: true },
      );
    }
    if (status === 401) {
      return new JevDecisionError(upstreamMessage || 'Jev API Key 无效或已失效', 'JEV_UNAUTHORIZED', detail);
    }
    if (status === 403) {
      return new JevDecisionError(upstreamMessage || 'Jev 请求被拒绝（无该模型权限）', 'JEV_FORBIDDEN', detail);
    }
    return new JevDecisionError(
      upstreamMessage || `Jev API 请求失败（HTTP ${status || 'unknown'}）`,
      'JEV_API_ERROR',
      { ...detail, response: payload },
    );
  }

  async _fetchWithTimeout(body, parentSignal) {
    if (parentSignal?.aborted) throw new JevDecisionError('Jev 请求已取消', 'JEV_ABORTED', { httpStatus: 499 });
    const controller = new AbortController();
    const timeoutMs = Math.floor(clamp(this.config.timeoutMs, 100, 15000, 1500));
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
      if (parentAborted) throw new JevDecisionError('Jev 请求已取消', 'JEV_ABORTED', { cause: error, httpStatus: 499 });
      if (timedOut) throw new JevDecisionError(`Jev 请求超时（${timeoutMs}ms）`, 'JEV_TIMEOUT', { cause: error, httpStatus: 504 });
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
      throw new JevDecisionError('无法读取 Jev 响应', 'JEV_INVALID_RESPONSE', { cause: error, httpStatus: 502 });
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
  DEFAULT_MODEL,
  JevDecisionError,
  JevDecisionService,
  ROUTE_DEFINITIONS,
  ROUTE_INSTRUCTIONS,
  SUPPORTED_QUESTION_TYPES,
  buildRouteQuestions,
  extractUsage,
  normalizeAnswers,
  normalizeHistory,
  normalizeMode,
  normalizeQuestions,
  normalizeRouteAnswer,
  normalizeState,
  normalizeUsage,
  safeHost,
  stableBucket,
};
