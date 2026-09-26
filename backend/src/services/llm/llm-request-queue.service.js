"use strict";

// ==================== LLM 请求队列（API 并发限流） ====================
// 防止 LLM API 限流（429 Too Many Requests），控制同时发往 API 的请求数量。
// 多余的请求排队等待，而非直接报错。
// 从 ai.service.js 拆出：队列只做并发控制，不感知 LLM 协议细节。

const LLM_CONCURRENCY = Math.max(1, parseInt(process.env.LLM_CONCURRENCY || '3', 10));
const LLM_MAX_PENDING = Math.max(0, parseInt(process.env.LLM_MAX_PENDING || '20', 10));
const LLM_QUEUE_TIMEOUT_MS = Math.max(1000, parseInt(process.env.LLM_QUEUE_TIMEOUT_MS || '15000', 10));

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

// 单例：全项目共享一个 LLM 队列
const llmQueue = new RequestQueue(LLM_CONCURRENCY);

module.exports = {
  RequestQueue,
  llmQueue,
  QueueOverflowError,
  QueueWaitTimeoutError,
  createAbortError,
  LLM_CONCURRENCY,
  LLM_MAX_PENDING,
  LLM_QUEUE_TIMEOUT_MS,
};
