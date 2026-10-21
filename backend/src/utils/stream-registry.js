"use strict";

const { writeRunFailed, writeSse } = require("./sse-events");

const SHUTDOWN_CODE = "SERVER_SHUTTING_DOWN";
const SHUTDOWN_MESSAGE = "服务正在重启，请稍后重试";

const activeStreams = new Set();
let draining = false;

/** 登记一条进行中的 SSE 流，返回注销函数 */
function trackStream(entry) {
  activeStreams.add(entry);
  return () => activeStreams.delete(entry);
}

function isDraining() {
  return draining;
}

function activeStreamCount() {
  return activeStreams.size;
}

function terminateStream(entry) {
  const { res, abortController, streamContext } = entry;
  // 先中止上游，再在同一 tick 内写出终止事件并结束响应；
  // 处理函数恢复执行时看到 aborted / writableEnded 会直接返回，不会再写
  abortController?.abort();
  try {
    if (!res.writableEnded) {
      const error = { code: SHUTDOWN_CODE, message: SHUTDOWN_MESSAGE };
      if (streamContext?.streamVersion === 1) writeRunFailed(res, streamContext, error);
      else writeSse(res, { error: SHUTDOWN_MESSAGE, code: SHUTDOWN_CODE });
      res.end();
    }
  } catch {
    // 连接已断开
  }
  activeStreams.delete(entry);
}

/**
 * 进入排空：拒绝新流，等待进行中的流自然结束；超时后对剩余流发送明确的终止事件。
 * @returns {Promise<{completed: number, terminated: number}>}
 */
async function drainStreams({ timeoutMs = 25000, pollMs = 200 } = {}) {
  draining = true;
  const initial = activeStreams.size;
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (activeStreams.size > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  const remaining = [...activeStreams];
  remaining.forEach(terminateStream);
  return { completed: initial - remaining.length, terminated: remaining.length };
}

function resetStreamRegistry() {
  activeStreams.clear();
  draining = false;
}

module.exports = {
  SHUTDOWN_CODE,
  SHUTDOWN_MESSAGE,
  trackStream,
  isDraining,
  activeStreamCount,
  drainStreams,
  resetStreamRegistry,
};
