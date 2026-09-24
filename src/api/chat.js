const API_BASE = import.meta.env.VITE_API_BASE_URL || '/api';
const API_URL = API_BASE.endsWith('/') ? API_BASE.slice(0, -1) : API_BASE;
const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY = 1000;
const MAX_RETRY_DELAY = 30000;
const HEARTBEAT_INTERVAL = 30000;
const HEARTBEAT_TIMEOUT = 10000;
const STREAM_STALL_TIMEOUT = 60000; // 60s without data = stalled
const RESPONSE_HEADERS_TIMEOUT = 30000; // 建连后迟迟不出响应头的兜底（响应后的慢数据由 stallCheck 负责）

import { fetchOpts } from './client.js';
import {
  isRunEventV1,
  RUN_EVENT_TYPES,
  RUN_EVENT_VERSION,
  TERMINAL_RUN_EVENT_TYPES,
} from '../utils/runEvents.js';

// 流式热路径日志仅在开发环境输出（生产构建每 chunk 打日志会卡 DevTools）
const debug = (...args) => {
  if (import.meta.env.DEV) console.debug(...args);
};

const getExponentialDelay = (attempt) => {
  const delayMs = Math.min(INITIAL_RETRY_DELAY * Math.pow(2, attempt), MAX_RETRY_DELAY);
  return delayMs + Math.random() * 1000;
};

// Connection state management
export const connectionManager = {
  isConnected: true,
  lastHeartbeat: Date.now(),
  listeners: new Set(),

  subscribe(callback) {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  },

  notify(event, data) {
    this.listeners.forEach((cb) => cb(event, data));
  },

  setConnected(connected) {
    const wasConnected = this.isConnected;
    this.isConnected = connected;
    debug('[Connection] setConnected:', connected, 'wasConnected:', wasConnected);
    if (wasConnected !== connected) {
      this.notify(connected ? 'connected' : 'disconnected');
    }
  },
};

// Heartbeat
let heartbeatTimer = null;

const startHeartbeat = () => {
  if (heartbeatTimer) clearInterval(heartbeatTimer);

  heartbeatTimer = setInterval(async () => {
    // 断连时也必须继续探测——心跳的职责就是发现恢复。
    // 此前断连即 return，而发送按钮又依赖 isConnected，一次瞬时失败
    // 就会永久锁死发送（只有整页刷新能解开）
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), HEARTBEAT_TIMEOUT);

      const response = await fetch(`${API_URL}/health`, {
        method: 'GET',
        signal: controller.signal,
        credentials: 'include',
      });

      clearTimeout(timeoutId);

      if (response.ok) {
        connectionManager.lastHeartbeat = Date.now();
        connectionManager.setConnected(true);
      } else {
        connectionManager.setConnected(false);
      }
    } catch (err) {
      console.warn('[Stream] Heartbeat failed:', err.message);
      connectionManager.setConnected(false);
    }
  }, HEARTBEAT_INTERVAL);
};

startHeartbeat();

/**
 * 组合外部中止信号与响应头超时：任一触发即中止请求。
 * 不用 AbortSignal.any（Safari <17.4 不支持），手动桥接保持全兼容。
 * timedOut() 用于在 catch 中区分「超时（可重试）」和「用户主动中止」。
 */
const createRequestSignal = (externalSignal, timeoutMs) => {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onExternalAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) onExternalAbort();
    else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
  }
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    // 响应头到达后只停超时闸门；外部中止桥接必须保留到流结束，否则流式中途停止会失效
    clearTimer: () => clearTimeout(timer),
    dispose: () => {
      clearTimeout(timer);
      if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
    },
  };
};

// Streaming message with stall detection
export const sendMessageStream = async (message, history = [], callbacks, options = {}) => {
  debug('[Stream] sendMessageStream called, message:', message.substring(0, 30));
  const requestSignal = createRequestSignal(options.signal || null, RESPONSE_HEADERS_TIMEOUT);
  const signal = requestSignal.signal;
  const maxRetries = options.maxRetries ?? MAX_RETRIES;
  const attempt = options.attempt ?? 0;
  const conversationId = options.conversationId;

  // TTFT 埋点：记录 fetch 发起时刻
  const ttftStart = performance.now();
  let ttftMeasured = false;
  const streamVersion = options.streamVersion ?? RUN_EVENT_VERSION;
  const runId = options.runId || null;
  const requestBody = {
    message,
    history,
    conversationId,
    files: options.files || [],
    ...(streamVersion >= RUN_EVENT_VERSION ? { streamVersion, attempt } : {}),
    ...(runId ? { runId } : {}),
  };

  debug('[Stream] fetch:', `${API_URL}/stream`, 'attempt:', attempt, 'runId:', runId);
  try {
    const response = await fetch(`${API_URL}/stream`, {
      ...fetchOpts,
      method: 'POST',
      body: JSON.stringify(requestBody),
      signal,
    });
    // 响应头已到，超时闸门使命完成；之后的慢数据归 stallCheck 管
    requestSignal.clearTimer();

    if (!response.ok) {
      // 携带 status：catch 中区分「确定性 4xx（重试无意义）」和「网络/5xx 故障（可重试）」
      const httpError = new Error(`HTTP error! status: ${response.status}`);
      httpError.status = response.status;
      throw httpError;
    }
    if (!response.body) throw new Error('Response body is null');
    debug('[Stream] response OK, body type:', response.body?.constructor?.name, 'status:', response.status);

    connectionManager.setConnected(true);

    const reader = response.body.getReader();
    debug('[Stream] reader created');
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let lastDataTime = Date.now();
    let receivedRunEvent = false;
    let terminalRunEvent = false;

    // 包装内容事件，v0 的 content 与 v1 的 message.delta 都需使用同一 TTFT 口径。
    const recordFirstChunk = () => {
      if (ttftMeasured) return;
      ttftMeasured = true;
      const ttftMs = Math.round(performance.now() - ttftStart);
      debug(`[TTFT] 首字响应延迟: ${ttftMs}ms`);
      try {
        const key = 'ttft_measurements';
        const arr = JSON.parse(localStorage.getItem(key) || '[]');
        arr.push({ ts: Date.now(), ttft: ttftMs, attempt, msg: message.substring(0, 30) });
        while (arr.length > 100) arr.shift();
        localStorage.setItem(key, JSON.stringify(arr));
      } catch {}
    };
    const originalOnChunk = callbacks.onChunk;
    const measuredOnChunk = (content, meta) => {
      if (content) recordFirstChunk();
      originalOnChunk?.(content, meta);
    };
    const originalOnEvent = callbacks.onEvent;
    const measuredOnEvent = (event) => {
      if (event?.type === RUN_EVENT_TYPES.MESSAGE_DELTA && event.data?.content) recordFirstChunk();
      originalOnEvent?.(event);
    };
    const measuredCallbacks = { ...callbacks, onChunk: measuredOnChunk, onEvent: measuredOnEvent };

    // Stall detection timer。
    // finished 防止二次收敛：stall 触发的 reader.cancel() 会让挂起的 read() 以 done 结束，
    // 若不设标记，onError 之后还会再走一次 onDone（useStreaming 状态机被收敛两次）
    let finished = false;
    const stallCheck = setInterval(() => {
      if (Date.now() - lastDataTime > STREAM_STALL_TIMEOUT) {
        clearInterval(stallCheck);
        finished = true;
        reader.cancel();
        connectionManager.setConnected(false);
        measuredCallbacks.onError(new Error('响应超时（60 秒无数据），请重试'));
      }
    }, 5000);

    try {
      while (true) {
        const { done, value } = await reader.read();
        debug('[Stream] reader.read() done:', done, 'value length:', value?.length);
        if (done) {
          clearInterval(stallCheck);
          debug('[Stream] stream ended (done=true)');
          if (!finished) {
            if (receivedRunEvent && !terminalRunEvent) {
              finished = true;
              measuredCallbacks.onError(new Error('运行流在收到终态前意外结束'));
            } else {
              measuredCallbacks.onDone();
            }
          }
          break;
        }

        lastDataTime = Date.now();
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data:')) continue;
          debug('[Stream] SSE line:', trimmed.substring(0, 80));

          const data = trimmed.slice(5).trim();
          if (data === '[DONE]') {
            clearInterval(stallCheck);
            finished = true;
            // 主动释放响应体：不等服务端关连接（异常路径下可能长时间挂起）
            reader.cancel().catch(() => {});
            measuredCallbacks.onDone();
            return;
          }

          try {
            const json = JSON.parse(data);

            if (isRunEventV1(json)) {
              receivedRunEvent = true;
              debug('[Stream] RunEvent:', json.type, 'seq:', json.seq, 'runId:', json.runId);
              if (typeof measuredCallbacks.onEvent === 'function') {
                measuredCallbacks.onEvent(json);
              } else if (json.type === RUN_EVENT_TYPES.RUN_FAILED) {
                measuredCallbacks.onError(new Error(json.data?.message || '运行失败'));
              }

              if (TERMINAL_RUN_EVENT_TYPES.has(json.type)) {
                terminalRunEvent = true;
                finished = true;
                clearInterval(stallCheck);
                // v1 的 run.completed/run.failed 是唯一终态；主动释放响应体，
                // 防止服务端异常迟迟不关闭连接而再次触发 EOF 回调。
                reader.cancel().catch(() => {});
                return;
              }
              continue;
            }

            // 兼容两种流式格式：
            //   {"content":"..."}              — 标准格式
            //   {"choices":[{"delta":{"content":"..."}}]} — OpenAI 兼容格式
            let content = json.content;
            if (!content && json.choices?.[0]?.delta?.content) {
              content = json.choices[0].delta.content;
            }
            if (content) {
              debug('[Stream] chunk:', content.substring(0, 30));
              measuredCallbacks.onChunk(content, { decision: json.decision === true });
            }
            if (json.intent) measuredCallbacks.onIntent?.(json.intent);
            if (json.tool_call) measuredCallbacks.onToolCall?.(json.tool_call);
            if (json.tool_result) measuredCallbacks.onToolResult?.(json.tool_result);
            if (json.sources) measuredCallbacks.onSources?.(json.sources);
            // agent/agenticRag：Agent 与 AgenticRAG 链路的轮次/工具/收尾原因 trace
            //（此前被丢弃，流式下 AgentToolPanel 的 trace 永远为空）
            if (json.rag || json.trace || json.retrieval || json.agent || json.agenticRag) measuredCallbacks.onTrace?.(json);
            if (json.processCard) measuredCallbacks.onProcess?.(json.processCard);
            if (json.grounding) measuredCallbacks.onGrounding?.(json.grounding);
            if (json.usage) measuredCallbacks.onUsage?.(json.usage);
            if (json.followups) measuredCallbacks.onFollowups?.(json.followups);
            if (json.error) {
              clearInterval(stallCheck);
              finished = true;
              reader.cancel().catch(() => {});
              measuredCallbacks.onError(new Error(json.error));
              return;
            }
          } catch (err) {
            console.warn('[Stream] SSE 数据解析失败:', err.message, 'data:', data.substring(0, 100));
          }
        }
      }
    } finally {
      clearInterval(stallCheck);
      requestSignal.dispose();
    }
  } catch (error) {
    requestSignal.dispose();
    console.error('[Stream] fetch failed:', error.name, error.message);
    // 收到过 HTTP 响应（含 4xx）说明服务可达，不置断连态——
    // 此前确定性 4xx 也会触发重连横幅，最长 30s 后心跳才纠正
    if (!error.status) connectionManager.setConnected(false);

    if (error.name === 'AbortError') {
      if (requestSignal.timedOut()) {
        // 响应头超时是可重试故障，走下方指数退避重试，而非按「用户主动中止」处理
        console.warn('[Stream] 响应头超时（30s），准备重试');
      } else {
        console.warn('[Stream] 流式请求被正常中止:', error.message);
        callbacks.onAbort?.();
        return;
      }
    }

    // 确定性 4xx（除 408 请求超时 / 429 限流）重试必然同样失败，直接收敛到 onError
    const isDeterministic4xx = error.status >= 400 && error.status < 500
      && error.status !== 408 && error.status !== 429;

    // Exponential backoff retry
    if (attempt < maxRetries && !isDeterministic4xx) {
      const retryDelay = getExponentialDelay(attempt);
      console.warn(`[Stream] retry attempt ${attempt + 1}/${maxRetries}, delay ${Math.round(retryDelay)}ms, error: ${error.message}`);
      callbacks.onRetry?.(attempt + 1, maxRetries, retryDelay);
      // 退避等待期间用户点「停止」应立即生效，而非等满退避时长
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, retryDelay);
        options.signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          resolve();
        }, { once: true });
      });
      if (options.signal?.aborted) {
        console.warn('[Stream] 重试退避期间被用户中止');
        callbacks.onAbort?.();
        return;
      }
      return sendMessageStream(message, history, callbacks, {
        ...options,
        attempt: attempt + 1,
        maxRetries,
      });
    }

    console.error('[Stream] all retries exhausted, calling onError. Error:', error.message);
    callbacks.onError(error);
  }
};

// Streaming message with stall detection
export const uploadChatFile = async (file, conversationId = null) => {
  const formData = new FormData();
  formData.append('file', file);
  if (conversationId) formData.append('conversationId', conversationId);

  // 不能传 fetchOpts（它带了 application/json 头），FormData 必须由浏览器自动设置 multipart/form-data
  const response = await fetch(`${API_URL}/chat/upload`, {
    method: 'POST',
    credentials: 'include',
    body: formData,
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error || '文件上传失败');
  }
  return response.json();
};
