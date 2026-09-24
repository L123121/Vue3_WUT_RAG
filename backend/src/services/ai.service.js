"use strict";

const { StringDecoder } = require('string_decoder');
const crypto = require('crypto');
const config = require('../config');
const { request, requestStream } = require('../utils/httpClient');
const { metrics } = require('./metrics.service');
const { operationalMetrics } = require('./operational-metrics.service');
const { withActiveSpan, startLlmSpan, setLlmUsage, endLlmSpan } = require('./otel-tracing.service');

// ==================== 请求队列（API 并发限流） ====================
// 防止 LLM API 限流（429 Too Many Requests），控制同时发往 API 的请求数量。
// 多余的请求排队等待，而非直接报错。

const LLM_CONCURRENCY = Math.max(1, parseInt(process.env.LLM_CONCURRENCY || '3', 10));
const LLM_MAX_PENDING = Math.max(0, parseInt(process.env.LLM_MAX_PENDING || '20', 10));
const LLM_QUEUE_TIMEOUT_MS = Math.max(1000, parseInt(process.env.LLM_QUEUE_TIMEOUT_MS || '15000', 10));
const { QueryCache } = require('../utils/query-cache');
const { logEvent } = require('./observability.service');

class IncompleteStreamError extends Error {
  constructor(provider = 'upstream') {
    super(`${provider} 流在收到终态前提前结束`);
    this.name = 'IncompleteStreamError';
    this.code = 'INCOMPLETE_STREAM';
    this.retryable = true;
  }
}

// history compaction 缓存（模块级单例）
const compactCache = new QueryCache(
  config?.rag?.compactCacheMaxEntries || 200,
  config?.rag?.compactCacheTtlMs || 1800000,
);

class QueueOverflowError extends Error {
  constructor() {
    super('LLM 请求排队已满，请稍后重试');
    this.name = 'QueueOverflowError';
    this.code = 'LLM_QUEUE_FULL';
    this.statusCode = 503;
    this.expose = true;
    this.retryable = true;
  }
}

class QueueWaitTimeoutError extends Error {
  constructor() {
    super('LLM 请求排队超时，请稍后重试');
    this.name = 'QueueWaitTimeoutError';
    this.code = 'LLM_QUEUE_TIMEOUT';
    this.statusCode = 503;
    this.expose = true;
    this.retryable = true;
  }
}

const createAbortError = () => {
  const error = new Error('客户端已断开');
  error.name = 'AbortError';
  error.code = 'CLIENT_ABORTED';
  return error;
};

class RequestQueue {
  constructor(maxConcurrent, { maxPending = LLM_MAX_PENDING, waitTimeoutMs = LLM_QUEUE_TIMEOUT_MS } = {}) {
    this._max = Math.max(1, Number(maxConcurrent) || 1);
    this._maxPending = Math.max(0, Number(maxPending) || 0);
    this._waitTimeoutMs = Math.max(0, Number(waitTimeoutMs) || 0);
    this._running = 0;
    this._waiters = [];
  }

  /**
   * 获取一个执行槽位。排队等待支持 AbortSignal、数量上限和超时。
   * 用法：
   *   const release = await queue.acquire(signal);
   *   try { /* ... 调用 API ... *\/ } finally { release(); }
   */
  acquire(signal) {
    if (signal?.aborted) return Promise.reject(createAbortError());
    if (this._running < this._max) {
      this._running += 1;
      return Promise.resolve(this._release());
    }
    if (this._waiters.length >= this._maxPending) return Promise.reject(new QueueOverflowError());

    return new Promise((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        timer: null,
        settled: false,
        signal,
        onAbort: null,
      };
      const cleanup = () => {
        if (waiter.timer) clearTimeout(waiter.timer);
        if (signal && waiter.onAbort) signal.removeEventListener('abort', waiter.onAbort);
      };
      const remove = () => {
        const index = this._waiters.indexOf(waiter);
        if (index >= 0) this._waiters.splice(index, 1);
      };
      const rejectWaiter = (error) => {
        if (waiter.settled) return;
        waiter.settled = true;
        remove();
        cleanup();
        reject(error);
      };
      waiter.onAbort = () => rejectWaiter(createAbortError());
      if (signal) signal.addEventListener('abort', waiter.onAbort, { once: true });
      if (this._waitTimeoutMs > 0) {
        waiter.timer = setTimeout(() => rejectWaiter(new QueueWaitTimeoutError()), this._waitTimeoutMs);
        waiter.timer.unref?.();
      }
      this._waiters.push(waiter);
    });
  }

  _release() {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this._running -= 1;
      while (this._waiters.length > 0) {
        const next = this._waiters.shift();
        if (!next || next.settled) continue;
        next.settled = true;
        if (next.timer) clearTimeout(next.timer);
        if (next.onAbort) next.signal?.removeEventListener('abort', next.onAbort);
        this._running += 1;
        next.resolve(this._release());
        return;
      }
    };
  }

  get pending() { return this._waiters.length; }
  get running() { return this._running; }
  get maxPending() { return this._maxPending; }
}

const llmQueue = new RequestQueue(LLM_CONCURRENCY);

// ==================== AI 服务 ====================

/**
 * AI 服务（主备双 provider）
 *
 * 主 provider（StepFun 等）失败时自动切换到备用 provider（如 LongCat）。
 *
 * 两种模式：
 *   1. OpenAI 兼容模式（默认）— /v2/chat/completions + Bearer 认证
 *   2. Anthropic 代理模式 — baseUrl 含 "/anthropic" 时，x-api-key + /v1/messages
 *
 * 请求队列：所有 LLM API 调用（含流式）经过 llmQueue，控制并发，
 * 避免触发 API 提供商的速率限制（429）。
 */
class AiService {
  constructor() {
    this.primary = this._normalizeProvider(config.ai);
    // 备用 provider：有 apiKey 时才启用
    this.fallback = config.ai.fallback?.apiKey
      ? this._normalizeProvider(config.ai.fallback)
      : null;
    // 摘要压缩复用独立评测 Key/小模型，不抢占生产配额
    const { JudgeService } = require('./judge.service');
    this.judgeService = new JudgeService();
  }

  _normalizeProvider(cfg) {
    const baseUrl = cfg.baseUrl || 'https://api.stepfun.com/v1';
    return {
      apiKey: cfg.apiKey || '',
      baseUrl,
      model: cfg.model || 'step-3.7-flash',
      maxTokens: cfg.maxTokens || 4000,
      temperature: cfg.temperature || 0.7,
      timeout: cfg.timeout || 60000,
      anthropicMode: baseUrl.includes('/anthropic'),
      // 推理模型思考链开关（默认关闭，思考 token 会挤占 max_tokens 预算导致正文为空）
      enableThinking: !!cfg.enableThinking,
    };
  }

  _hasKey() {
    return !!(this.primary.apiKey || (this.fallback && this.fallback.apiKey));
  }

  _buildHeaders(path, provider) {
    if (provider.anthropicMode) {
      return {
        'Content-Type': 'application/json; charset=utf-8',
        'x-api-key': provider.apiKey,
        ...(path.includes('/messages') ? { 'anthropic-version': '2023-06-01' } : {}),
      };
    }
    return {
      'Content-Type': 'application/json; charset=utf-8',
      'Authorization': `Bearer ${provider.apiKey}`,
    };
  }

  _buildOptions(path, provider) {
    // 如果 baseUrl 已包含版本前缀（如 /v1），从请求路径中剥离版本号
    // StepFun: baseUrl=https://api.stepfun.com/v1, path=/v2/chat/completions → /chat/completions
    // LongCat: baseUrl=https://api.longcat.chat/openai, path=/v2/chat/completions → /v2/chat/completions
    let finalPath = path;
    const baseHasVersion = provider.baseUrl.match(/\/v\d+$/);
    if (baseHasVersion) {
      finalPath = path.replace(/^\/v\d+/, '');
    }
    const fullUrl = provider.baseUrl + finalPath;
    const urlObj = new URL(fullUrl);
    return {
      hostname: urlObj.hostname,
      port: urlObj.port || 443,
      path: urlObj.pathname + urlObj.search,
      method: 'POST',
      headers: this._buildHeaders(path, provider),
      timeout: provider.timeout,
    };
  }

  _buildMessages(message, history = []) {
    // 防御：调用方可能传 null/非数组
    if (!Array.isArray(history)) history = [];
    // C 方案：token 预算分配（history / RAG 资料 / 当前问题+输出 互不挤占）
    // - history 总预算：6000 字符（≈3000-4000 token，中文 1 字 ≈ 0.6-1 token）
    // - RAG 资料预算：由 rag.service 的 maxContextLength=6000 字符独立控制
    // - 输出预算：max_tokens=4000
    // 预算按"从最近消息往回取"累积，超预算即停，保证最近的对话优先保留
    const MAX_HISTORY_MESSAGES = 12;
    const MAX_MESSAGE_CHARS = 2000;
    const MAX_TOTAL_HISTORY_CHARS = 6000;

    const recent = [];
    let total = 0;
    for (let i = history.length - 1; i >= 0 && recent.length < MAX_HISTORY_MESSAGES; i--) {
      const h = history[i];
      const content = String(h?.content || '').slice(0, MAX_MESSAGE_CHARS);
      if (!content) continue;
      // 至少保留 1 条；之后超总预算则停止（最近的对话优先）
      if (recent.length > 0 && total + content.length > MAX_TOTAL_HISTORY_CHARS) break;
      const role = h.role === 'assistant' ? 'assistant' : h.role === 'system' ? 'system' : 'user';
      recent.unshift({ role, content });
      total += content.length;
    }
    return [
      ...recent,
      { role: 'user', content: String(message || '').slice(0, 4000) },
    ];
  }

  /**
   * 对显式 opts.messages 也执行上下文边界控制。
   * Agent 的工具调用历史必须在 provider 入口统一限额，不能因为绕过 history 参数而失去预算保护。
   */
  _boundMessages(messages = []) {
    if (!Array.isArray(messages)) return [];
    const maxChars = config.ai?.contextMaxChars || 12000;
    const maxMessageChars = config.ai?.contextMessageMaxChars || 4000;
    const normalized = messages.map((message) => {
      const role = ['system', 'user', 'assistant', 'tool'].includes(message?.role) ? message.role : 'user';
      const content = message?.content == null ? null : String(message.content).slice(0, maxMessageChars);
      const next = { ...message, role, content };
      if (role === 'tool') {
        next.tool_call_id = String(message.tool_call_id || '').slice(0, 160);
      }
      if (Array.isArray(message?.tool_calls)) {
        next.tool_calls = message.tool_calls.slice(0, 8).map((call) => ({
          id: String(call?.id || '').slice(0, 160),
          type: call?.type || 'function',
          function: {
            name: String(call?.function?.name || '').slice(0, 120),
            arguments: String(call?.function?.arguments || '{}').slice(0, 2000),
          },
        }));
      }
      return next;
    });

    const system = normalized.filter((message) => message.role === 'system');
    const body = normalized.filter((message) => message.role !== 'system');
    const systemBudget = Math.min(Math.floor(maxChars * 0.35), 5000);
    let used = 0;
    const boundedSystem = [];
    for (const message of system) {
      if (used >= systemBudget) break;
      const remaining = Math.max(systemBudget - used, 0);
      const content = String(message.content || '').slice(0, remaining);
      if (!content) continue;
      boundedSystem.push({ ...message, content });
      used += content.length;
    }

    const blocks = [];
    for (let i = 0; i < body.length; i += 1) {
      const message = body[i];
      if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
        const group = [message];
        let j = i + 1;
        while (j < body.length && body[j].role === 'tool') group.push(body[j++]);
        blocks.push(group);
        i = j - 1;
      } else {
        blocks.push([message]);
      }
    }

    const selected = [];
    for (let i = blocks.length - 1; i >= 0; i -= 1) {
      const block = blocks[i];
      const blockChars = block.reduce((sum, item) => sum + String(item.content || '').length, 0);
      if (selected.length > 0 && used + blockChars > maxChars) continue;
      if (selected.length === 0 && used + blockChars > maxChars) {
        const last = block[block.length - 1];
        const remaining = Math.max(maxChars - used, 1);
        selected.unshift([{ ...last, content: String(last.content || '').slice(-remaining) }]);
        used = maxChars;
        break;
      }
      selected.unshift(block);
      used += blockChars;
      if (used >= maxChars) break;
    }
    return [...boundedSystem, ...selected.flat()];
  }

  /**
   * 滚动摘要压缩（B 方案）：history 超过窗口时，把被裁掉的早期消息
   * 用独立小模型压缩成摘要，摘要作为一条 system 消息置于对话前，
   * 保留早期关键背景（专业/偏好/已办事项），同时 token 可控。
   * 压缩失败时降级为直接截断（不阻塞主流程）。
   * @param {Array} history 原始历史消息
   * @returns {Promise<Array>} 压缩后的 history（异步）
   */
  async _compactHistory(history = []) {
    const MAX_HISTORY_MESSAGES = 12;
    if (!Array.isArray(history)) return [];
    if (history.length === 0) return history;
    const systemMessages = history.filter(message => message?.role === 'system');
    const conversation = history.filter(message => message?.role !== 'system');
    if (conversation.length <= MAX_HISTORY_MESSAGES) return [...systemMessages, ...conversation];

    // 被裁掉的早期消息（超出窗口的部分）
    const early = conversation.slice(0, conversation.length - MAX_HISTORY_MESSAGES);
    const recent = conversation.slice(-MAX_HISTORY_MESSAGES);

    // 缓存拦截：相同的早期消息窗口可直接返回缓存的摘要
    if (config?.rag?.cacheEnabled) {
      const hash = this._compactHash(early);
      const cached = compactCache.get(hash);
      if (cached !== undefined) {
        return [
          ...systemMessages,
          { role: 'system', content: `（此前对话摘要）${cached}` },
          ...recent,
        ];
      }
    }

    try {
      const summary = await this.judgeService.summarize(early);
      if (summary) {
        logEvent('info', 'ai_summary_compacted', { earlyCount: early.length, summaryChars: summary.length });

        // 缓存写入
        if (config?.rag?.cacheEnabled) {
          compactCache.set(this._compactHash(early), summary);
        }

        return [
          ...systemMessages,
          { role: 'system', content: `（此前对话摘要）${summary}` },
          ...recent,
        ];
      }
    } catch (err) {
      logEvent('warn', 'ai_summary_failed_truncate_fallback', { error: err.message });
    }
    return [...systemMessages, ...recent];
  }

  /** 将早期消息列表 hash 为短字符串，用于 compaction 缓存 key */
  _compactHash(messages) {
    if (!messages || !messages.length) return 'empty';
    const normalized = messages.map((message) => ({
      role: message?.role || 'user',
      content: String(message?.content || ''),
    }));
    return crypto.createHash('sha256').update(JSON.stringify(normalized), 'utf8').digest('hex');
  }

  // ========== 非流式（经队列） ==========

  async getCompletion(message, history = [], opts = {}) {
    if (!this._hasKey()) {
      logEvent('warn', 'ai_api_key_missing_mock_mode', { message: 'API Key 缺失，使用模拟模式' });
      return { content: this.getMockResponse(message), isMock: true, model: 'mock', usage: null };
    }

    // 滚动摘要：先压缩 history，再进队列
    const compacted = await this._compactHistory(history);

    const release = await llmQueue.acquire(opts.signal);
    logEvent('info', 'ai_queue_slot_acquired', { pending: llmQueue.pending, running: llmQueue.running });
    try {
      return await this._doGetCompletion(message, compacted, opts);
    } finally {
      release();
    }
  }

  async _doGetCompletion(message, history = [], opts = {}) {
    // 先尝试主 provider
    try {
      return await this._requestProvider(this.primary, message, history, opts);
    } catch (err) {
      if (err.name === 'AbortError' || opts.signal?.aborted || !this.fallback) throw err;
      logEvent('warn', 'ai_primary_provider_failed_switch', { error: err.message });
      return await this._requestProvider(this.fallback, message, history, opts);
    }
  }

  async _requestProvider(provider, message, history, opts) {
    // LLM 调用 span：OTel 启用时记录 gen_ai 语义属性（模型/token 用量/时延），关闭时 Noop 直通
    return withActiveSpan(`LLM chat ${provider.model}`, {
      'gen_ai.system': 'stepfun',
      'gen_ai.operation.name': 'chat',
      'gen_ai.request.model': provider.model,
    }, async (llmSpan) => {
      const path = provider.anthropicMode ? '/v1/messages' : '/v2/chat/completions';
      const payload = {
        model: provider.model,
        messages: this._boundMessages(opts.messages || this._buildMessages(message, history)),
        max_tokens: provider.maxTokens,
        temperature: provider.temperature,
        stream: false,
      };
      // 推理模型（如 step-3.7-flash）默认关闭思考链，避免思考 token 耗尽预算导致 content 为空
      if (!provider.anthropicMode && !provider.enableThinking) {
        payload.enable_thinking = false;
      }
      // 原生 function calling（OpenAI 兼容）：调用方传 opts.tools 时携带工具描述
      if (!provider.anthropicMode && Array.isArray(opts.tools) && opts.tools.length > 0) {
        payload.tools = opts.tools;
      }
      const body = JSON.stringify(payload);
      const options = this._buildOptions(path, provider);
      options.headers['Content-Length'] = Buffer.byteLength(body, 'utf8');
      // 支持调用方覆盖超时时间和重试次数
      if (opts.timeout) options.timeout = opts.timeout;
      if (opts.retries !== undefined) options.retries = opts.retries;

      logEvent('info', 'ai_request', { host: options.hostname, path: options.path, model: provider.model, bodyLen: body.length, tools: payload.tools?.length || 0 });

      const startTime = Date.now();
      const result = await request(options, body, opts.signal);
      const latency = Date.now() - startTime;
      metrics.recordLatency('ai', latency);

      let content = '';
      let toolCalls = null;
      if (provider.anthropicMode) {
        content = result.data?.content?.[0]?.text || '';
      } else {
        const msg = result.data?.choices?.[0]?.message || {};
        content = msg.content || '';
        toolCalls = Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0 ? msg.tool_calls : null;
      }

      if (content || toolCalls) {
        logEvent('info', 'ai_response', { outputChars: content.length, toolCalls: toolCalls?.length || 0 });
        const usage = result.data?.usage || null;
        operationalMetrics.recordLlmUsage({ model: result.data?.model || provider.model, usage, traceId: opts.traceId, latencyMs: latency });
        setLlmUsage(llmSpan, usage);
        llmSpan.setAttribute('ai.latency_ms', latency);
        return {
          content,
          isMock: false,
          model: result.data?.model || provider.model,
          usage,
          toolCalls,
        };
      } else {
        const msg = `AI 服务返回空响应: ${JSON.stringify(result.data).substring(0, 200)}`;
        logEvent('warn', 'ai_empty_response', { message: msg });
        // 空响应视为可恢复错误，抛出后触发 fallback
        throw new Error(msg);
      }
    });
  }

  // ========== 流式（经队列） ==========

  async *getCompletionStream(message, history = [], opts = {}) {
    if (!this._hasKey()) {
      const mock = this.getMockResponse(message);
      for (const c of mock) yield { content: c, done: false };
      yield { content: '', done: true };
      return;
    }

    // 滚动摘要：先压缩 history，再排队（async generator 内 await 后仍保留 yield 语义）
    const compacted = await this._compactHistory(history);
    // 客户端已断开：不再占用队列槽位，直接结束
    if (opts.signal?.aborted) {
      const err = new Error('客户端已断开');
      err.name = 'AbortError';
      throw err;
    }

    // 排队等待 LLM 槽位，整个流式过程占用一个槽位
    const release = await llmQueue.acquire(opts.signal);
    logEvent('info', 'ai_stream_queue_slot_acquired', { pending: llmQueue.pending, running: llmQueue.running });

    try {
      yield* this._doGetCompletionStream(message, compacted, opts);
    } finally {
      release();
    }
  }

  async *_doGetCompletionStream(message, history = [], opts = {}) {
    // 主 provider 连接建立前失败时，可切换到备用 provider
    if (this.fallback) {
      const streamed = { any: false };
      try {
        for await (const chunk of this._streamProvider(this.primary, message, history, opts)) {
          if (chunk.content) streamed.any = true;
          yield chunk;
        }
        return; // 主 provider 成功完成
      } catch (err) {
        // 客户端已断开：不切备用 provider，直接结束（避免白烧备用额度）
        if (err.name === 'AbortError' || opts.signal?.aborted) throw err;
        if (streamed.any) {
          // 中途失败：已向调用方输出部分内容，备用 provider 重发整段会造成
          // "半截回答 + 完整回答" 拼接重复，只能如实向上抛（上层有收尾/降级逻辑）
          logEvent('warn', 'ai_stream_midway_failure_no_fallback', { error: err.message });
          throw err;
        }
        logEvent('warn', 'ai_stream_primary_failed_switch', { error: err.message });
      }
      // 主 provider 失败，尝试备用
      yield* this._streamProvider(this.fallback, message, history, opts);
    } else {
      yield* this._streamProvider(this.primary, message, history, opts);
    }
  }

  _buildStreamPayload(provider, message, history, opts = {}) {
    const payload = {
      model: provider.model,
      messages: this._boundMessages(opts.messages || this._buildMessages(message, history)),
      max_tokens: provider.maxTokens,
      temperature: provider.temperature,
      stream: true,
    };
    // 推理模型（如 step-3.7-flash）默认关闭思考链，避免思考 token 耗尽预算导致 content 为空
    if (!provider.anthropicMode && !provider.enableThinking) {
      payload.enable_thinking = false;
    }
    const supportsStreamUsage = /api\.(stepfun|openai)\.com/i.test(provider.baseUrl || '');
    if (!provider.anthropicMode && supportsStreamUsage) {
      payload.stream_options = { include_usage: true };
    }
    // 原生 function calling（OpenAI 兼容）：调用方传 opts.tools 时携带工具描述
    if (!provider.anthropicMode && Array.isArray(opts.tools) && opts.tools.length > 0) {
      payload.tools = opts.tools;
    }
    return payload;
  }

  async *_streamProvider(provider, message, history, opts = {}) {
    const path = provider.anthropicMode ? '/v1/messages' : '/v2/chat/completions';
    const payload = this._buildStreamPayload(provider, message, history, opts);
    const body = JSON.stringify(payload);
    const options = this._buildOptions(path, provider);
    options.headers['Content-Length'] = Buffer.byteLength(body, 'utf8');

    const streamStart = Date.now();
    logEvent('info', 'ai_stream_request', { host: options.hostname, path: options.path, model: provider.model, bodyLen: body.length, tools: payload.tools?.length || 0 });

    // LLM 流式 span：生成器无法 startActiveSpan，手动起/收（父取活跃上下文），usage 由 _parseStream 补
    const llmSpan = startLlmSpan(provider, { stream: true });
    let res;
    try {
      res = await requestStream(options, body, opts.signal);
    } catch (err) {
      endLlmSpan(llmSpan, err);
      // 客户端主动取消：向上抛出，不再尝试 fallback
      if (err.name === 'AbortError' || opts.signal?.aborted) {
        const abortErr = new Error('客户端已断开');
        abortErr.name = 'AbortError';
        throw abortErr;
      }
      // 连接建立前失败 → 抛出，让外层决定是否 fallback
      throw new Error(`连接失败: ${err.message}`);
    }

    if (res.statusCode !== 200) {
      let err = '';
      for await (const c of res) err += c;
      endLlmSpan(llmSpan, new Error(`HTTP ${res.statusCode}`));
      throw new Error(`HTTP ${res.statusCode}: ${err.substring(0, 200)}`);
    }

    try {
      yield* this._parseStream(res, provider, opts, llmSpan);
      metrics.recordLatency('ai', Date.now() - streamStart);
      endLlmSpan(llmSpan);
    } catch (err) {
      endLlmSpan(llmSpan, err);
      throw err;
    }
  }

  async *_parseStream(res, provider, opts = {}, llmSpan = null) {
    let buf = '';
    let streamUsage = null;
    let usageRecorded = false;
    let terminalSeen = false;
    const decoder = new StringDecoder('utf8');
    // tool_calls 增量拼接（OpenAI 兼容流式：delta.tool_calls 按 index 分片）
    const toolCallMap = new Map();
    let hasToolCalls = false;
    const needsTools = Array.isArray(opts.tools) && opts.tools.length > 0;
    const recordUsage = () => {
      if (usageRecorded || !streamUsage) return;
      usageRecorded = true;
      operationalMetrics.recordLlmUsage({ model: provider.model, usage: streamUsage, traceId: opts.traceId });
      setLlmUsage(llmSpan, streamUsage);
    };

    for await (const chunk of res) {
      buf += decoder.write(chunk);
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        const t = line.trim();
        if (!t || t.startsWith('event:')) continue;
        if (!t.startsWith('data:')) continue;
        const d = t.slice(5).trim();
        if (d === '[DONE]') {
          terminalSeen = true;
          recordUsage();
          yield { content: '', done: true, usage: streamUsage || null, tool_calls: this._assembleToolCalls(toolCallMap, hasToolCalls, needsTools) };
          return;
        }
        try {
          const j = JSON.parse(d);
          if (j.usage) streamUsage = j.usage;
          let content = '';
          let done = false;
          if (provider.anthropicMode) {
            if (j.type === 'content_block_delta' && j.delta?.text) content = j.delta.text;
            if (j.type === 'message_stop' || j.type === 'message_delta') {
              done = true;
              terminalSeen = true;
            }
          } else {
            const choice = j.choices?.[0];
            content = choice?.delta?.content || '';
            // tool_calls 增量：{index, id?, function:{name?, arguments?}}
            if (choice?.delta?.tool_calls) {
              hasToolCalls = true;
              for (const tc of choice.delta.tool_calls) {
                const idx = tc.index ?? 0;
                let entry = toolCallMap.get(idx);
                if (!entry) {
                  entry = { id: tc.id || '', name: tc.function?.name || '', arguments: '' };
                  toolCallMap.set(idx, entry);
                }
                if (tc.id) entry.id = tc.id;
                if (tc.function?.name) entry.name = tc.function.name;
                if (tc.function?.arguments) entry.arguments += tc.function.arguments;
              }
            }
          }
          if (content) yield { content, done: false };
          if (done) {
            recordUsage();
            yield { content: '', done: true, usage: streamUsage || null, tool_calls: this._assembleToolCalls(toolCallMap, hasToolCalls, needsTools) };
            return;
          }
        } catch (err) {
          logEvent('warn', 'ai_stream_sse_parse_failed', { error: err.message });
        }
      }
    }
    // 冲刷 decoder 中残留的不完整多字节序列；最后一行可能没有换行符。
    buf += decoder.end();
    if (buf.trim()) {
      const t = buf.trim();
      if (t.startsWith('data:')) {
        const data = t.slice(5).trim();
        if (data === '[DONE]') {
          terminalSeen = true;
        } else {
          try {
            const j = JSON.parse(data);
            if (j.usage) streamUsage = j.usage;
            const content = provider.anthropicMode
              ? (j.type === 'content_block_delta' ? (j.delta?.text || '') : (j.delta?.text || ''))
              : (j.choices?.[0]?.delta?.content || '');
            if (content) yield { content, done: false };
            if (provider.anthropicMode && (j.type === 'message_stop' || j.type === 'message_delta')) {
              terminalSeen = true;
            }
          } catch (err) {
            logEvent('warn', 'ai_stream_trailing_sse_parse_failed', { error: err.message });
          }
        }
      }
    }
    if (!terminalSeen) {
      recordUsage();
      throw new IncompleteStreamError(provider.anthropicMode ? 'Anthropic' : 'OpenAI');
    }
    recordUsage();
    yield { content: '', done: true, usage: streamUsage || null, tool_calls: this._assembleToolCalls(toolCallMap, hasToolCalls, needsTools) };
  }

  /**
   * 把流式累积的 tool_calls 分片组装为完整数组（供 _parseStream 收尾）
   * - 按 index 升序
   * - name 为空的分片丢弃（首片丢失无法执行，避免"未知工具"）
   * - arguments 残缺（流中断）降级为 {}，不静默用残缺 JSON
   */
  _assembleToolCalls(toolCallMap, hasToolCalls, needsTools) {
    if (!needsTools || !hasToolCalls || toolCallMap.size === 0) return null;
    const toolCalls = Array.from(toolCallMap.entries())
      .sort(([a], [b]) => a - b)
      .map(([_, tc]) => ({
        id: tc.id || `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        type: 'function',
        function: { name: tc.name, arguments: tc.arguments || '{}' },
      }))
      .filter((tc) => {
        if (!tc.function.name) {
          logEvent('warn', 'ai_stream_tool_call_empty_name_dropped', { id: tc.id });
          return false;
        }
        if (tc.function.arguments && tc.function.arguments !== '{}') {
          try {
            JSON.parse(tc.function.arguments);
          } catch {
            logEvent('warn', 'ai_stream_tool_call_args_incomplete', { tool: tc.function.name });
            tc.function.arguments = '{}';
          }
        }
        return true;
      });
    return toolCalls.length > 0 ? toolCalls : null;
  }

  getMockResponse(message) {
    return `收到您的问题："${message}"。AI 服务暂时不可用，请稍后再试。`;
  }
}

// 单例实例：全项目共享一个 AiService，复用配置和连接
const aiService = new AiService();

module.exports = {
  AiService,
  IncompleteStreamError,
  QueueOverflowError,
  QueueWaitTimeoutError,
  RequestQueue,
  aiService,
  llmQueue,
  metrics,
};
