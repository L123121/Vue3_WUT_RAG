"use strict";

const https = require('https');
const { StringDecoder } = require('string_decoder');
const { metrics } = require('../services/metrics.service');

// ==================== 共享 HTTPS 客户端 ====================
// 提供连接池（keep-alive）、重试、超时统一处理

const DEFAULT_TIMEOUT = 60000;
const DEFAULT_RETRIES = 2;
const RETRYABLE_STATUS = [408, 429, 502, 503, 504];

const waitForRetry = (delayMs, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) {
    const error = new Error('客户端已断开');
    error.name = 'AbortError';
    error.code = 'CLIENT_ABORTED';
    reject(error);
    return;
  }
  const timer = setTimeout(() => {
    signal?.removeEventListener('abort', onAbort);
    resolve();
  }, delayMs);
  const onAbort = () => {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    const error = new Error('客户端已断开');
    error.name = 'AbortError';
    error.code = 'CLIENT_ABORTED';
    reject(error);
  };
  signal?.addEventListener('abort', onAbort, { once: true });
});

// 全局 keep-alive agent（连接池）
// 注意：https.Agent({ timeout }) 是 socket 连接后设置的超时，**对活动请求同样生效**，
// 不是"空闲连接超时"。此前误缩短为 15s，导致 StepFun 流式首 token（常需 4~26s）
// 被中途 destroy → 触发重试 → 首 token 翻倍、偶发流中断（outputChars=0）。
// 正确做法：agent timeout 与请求级一致（60s），死连接问题靠 requestStream 重试解决。
const agent = new https.Agent({
  keepAlive: true,
  maxSockets: 20,
  maxFreeSockets: 5,
  timeout: DEFAULT_TIMEOUT,
});

/**
 * 发送 HTTPS 请求（非流式），自动处理重试和错误
 * @param {Object} options - https.request options（不含 agent/timeout，可覆盖）
 * @param {number} [options.timeout=60000] - 请求超时 ms
 * @param {number} [options.retries=2] - 重试次数
 * @param {boolean} [options.retryOn5xx=true] - 5xx 是否重试
 * @param {string} [options.body] - JSON 字符串体
 * @returns {Promise<{statusCode, data, headers}>}
 */
async function request(options, body, signal) {
  const timeout = options.timeout || DEFAULT_TIMEOUT;
  const retries = options.retries ?? DEFAULT_RETRIES;
  const retryOn5xx = options.retryOn5xx !== false;

  const reqOptions = {
    ...options,
    agent,
    timeout,
  };
  delete reqOptions.retries;
  delete reqOptions.retryOn5xx;

  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const start = Date.now();
    try {
      const result = await _sendRequest(reqOptions, body, signal);
      metrics.recordLatency('http', Date.now() - start);
      return result;
    } catch (err) {
      lastError = err;
      if (signal?.aborted) throw err;
      const shouldRetry = attempt < retries && (
        err.code === 'ECONNRESET' ||
        err.code === 'ETIMEDOUT' ||
        err.code === 'ECONNREFUSED' ||
        (retryOn5xx && err.statusCode && RETRYABLE_STATUS.includes(err.statusCode))
      );
      if (!shouldRetry) break;
      const delay = Math.min(1000 * Math.pow(2, attempt) + Math.random() * 500, 10000);
      await waitForRetry(delay, signal);
    }
  }
  throw lastError;
}

/**
 * 发送流式 HTTPS 请求（返回原始 IncomingMessage）
 * 带连接失败/5xx 重试：keep-alive 复用死连接、瞬时断连（ECONNRESET/ETIMEDOUT）
 * 是流式首 token 偶发 10~30s 卡顿的主因，这里与 request() 一致地做指数退避重试。
 * @param {Object} options - https.request options
 * @param {string} [body] - JSON 字符串体
 * @param {AbortSignal} [signal] - 取消信号（abort 后不重试）
 * @returns {Promise<IncomingMessage>}
 */
async function requestStream(options, body, signal) {
  const timeout = options.timeout || DEFAULT_TIMEOUT;
  const retries = options.retries ?? DEFAULT_RETRIES;
  const retryOn5xx = options.retryOn5xx !== false;
  const reqOptions = {
    ...options,
    agent,
    timeout,
  };
  delete reqOptions.retries;
  delete reqOptions.retryOn5xx;

  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const start = Date.now();
    try {
      const res = await _sendStreamRequest(reqOptions, body, signal);
      metrics.recordLatency('http', Date.now() - start);
      return res;
    } catch (err) {
      lastError = err;
      // abort 是客户端主动取消，不重试
      if (signal?.aborted) throw err;
      const shouldRetry = attempt < retries && (
        err.code === 'ECONNRESET' ||
        err.code === 'ETIMEDOUT' ||
        err.code === 'ECONNREFUSED' ||
        err.code === 'ECONNABORTED' ||
        (retryOn5xx && err.statusCode && RETRYABLE_STATUS.includes(err.statusCode))
      );
      if (!shouldRetry) break;
      const delay = Math.min(1000 * Math.pow(2, attempt) + Math.random() * 500, 10000);
      await waitForRetry(delay, signal);
    }
  }
  throw lastError;
}

/**
 * 内部：发送单次流式请求（不重试）
 */
function _sendStreamRequest(options, body, signal) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      if (res.statusCode !== 200) {
        let errData = '';
        res.on('data', chunk => { errData += chunk; });
        res.on('end', () => {
          const err = new Error(`HTTP ${res.statusCode}: ${errData.slice(0, 200)}`);
          err.statusCode = res.statusCode;
          reject(err);
        });
        return;
      }
      resolve(res);
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      const err = new Error('请求超时');
      err.code = 'ETIMEDOUT';
      reject(err);
    });

    // 客户端断开 / abort → 立即销毁底层 socket，使流式 for-await 尽快退出，
    // 不必等到下一个 chunk 或 socket 超时（最坏 60s）。
    if (signal) {
      if (signal.aborted) {
        req.destroy();
        return reject(new Error('aborted'));
      }
      const onAbort = () => {
        req.destroy();
        reject(new Error('aborted'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      // 请求结束后移除监听，避免 signal 上累积监听器
      const cleanup = () => signal.removeEventListener('abort', onAbort);
      req.on('close', cleanup);
      req.on('error', cleanup);
    }

    if (body) req.write(body);
    req.end();
  });
}

/**
 * 内部：发送单次请求
 */
function _sendRequest(options, body, signal) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let onAbort = null;
    const cleanup = () => {
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
    };
    const rejectOnce = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const resolveOnce = (value) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const req = https.request(options, (res) => {
      const decoder = new StringDecoder('utf8');
      let data = '';
      res.on('data', chunk => { data += decoder.write(chunk); });
      res.on('close', cleanup);
      res.on('end', () => {
        data += decoder.end();
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const err = new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`);
          err.statusCode = res.statusCode;
          return rejectOnce(err);
        }
        try {
          const json = JSON.parse(data);
          resolveOnce({ statusCode: res.statusCode, data: json, headers: res.headers });
        } catch {
          resolveOnce({ statusCode: res.statusCode, data, headers: res.headers });
        }
      });
    });

    req.on('error', rejectOnce);
    req.on('timeout', () => {
      req.destroy();
      const err = new Error('请求超时');
      err.code = 'ETIMEDOUT';
      rejectOnce(err);
    });

    if (signal) {
      onAbort = () => {
        req.destroy();
        const error = new Error('客户端已断开');
        error.name = 'AbortError';
        error.code = 'CLIENT_ABORTED';
        rejectOnce(error);
      };
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }

    if (body) req.write(body);
    req.end();
  });
}

module.exports = { request, requestStream };
