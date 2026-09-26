"use strict";

const config = require('../config');
const { request, requestStream } = require('../utils/httpClient');
const { metrics } = require('./metrics.service');
const { operationalMetrics } = require('./operational-metrics.service');
const { withActiveSpan, startLlmSpan, setLlmUsage, endLlmSpan } = require('./otel-tracing.service');
const { logEvent } = require('./observability.service');
const {
  RequestQueue,
  llmQueue,
  QueueOverflowError,
  QueueWaitTimeoutError,
} = require('./llm-request-queue');
const {
  buildHistoryMessages,
  boundContextMessages,
  compactHistory,
  createCompactCache,
} = require('./llm-context-boundary');
const {
  IncompleteStreamError,
  buildStreamPayload,
  assembleToolCalls,
  parseSseStream,
} = require('./llm-stream-parser');

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
 * 请求队列：所有 LLM API 调用（含流式）经过 llmQueue（llm-request-queue.js），控制并发，
 * 避免触发 API 提供商的速率限制（429）。
 * 上下文边界与历史压缩见 llm-context-boundary.js，SSE 流解析见 llm-stream-parser.js。
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
    // compaction 缓存绑定实例生命周期，多个实例（测试）之间互不污染
    this._compactCache = createCompactCache();
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
    return buildHistoryMessages(message, history);
  }

  _boundMessages(messages = []) {
    return boundContextMessages(messages);
  }

  /**
   * 滚动摘要压缩（B 方案）：压缩失败时降级为直接截断，不阻塞主流程。
   * 摘要用独立评测 Key/小模型（judgeService），不抢占生产配额。
   */
  async _compactHistory(history = []) {
    return compactHistory(history, (early) => this.judgeService.summarize(early), this._compactCache);
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
    return buildStreamPayload(provider, this._boundMessages(opts.messages || this._buildMessages(message, history)), opts);
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
    yield* parseSseStream(res, provider, opts, llmSpan, (map, has, needs) => this._assembleToolCalls(map, has, needs));
  }

  /**
   * 把流式累积的 tool_calls 分片组装为完整数组（供 _parseStream 收尾）
   * - 按 index 升序
   * - name 为空的分片丢弃（首片丢失无法执行，避免"未知工具"）
   * - arguments 残缺（流中断）降级为 {}，不静默用残缺 JSON
   */
  _assembleToolCalls(toolCallMap, hasToolCalls, needsTools) {
    return assembleToolCalls(toolCallMap, hasToolCalls, needsTools);
  }

  getMockResponse(message) {
    return `收到您的问题："${message}"。AI 服务暂时不可用，请稍后再试。`;
  }
}

// 单例实例：全项目共享一个 AiService，复用配置和连接
const aiService = new AiService();

// 错误类与队列保持从本模块导出（历史兼容面：测试与上层按此路径引用）
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
