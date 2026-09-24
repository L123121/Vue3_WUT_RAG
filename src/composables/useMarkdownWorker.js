import { ref } from 'vue';

/**
 * Composable that offloads Markdown rendering to a Web Worker.
 * Falls back to synchronous rendering if Worker is unavailable.
 *
 * Usage:
 *   const { renderInWorker } = useMarkdownWorker();
 *   try {
 *     const html = await renderInWorker('# Hello');
 *   } catch {
 *     // Worker 失败/超时/不可用 — 调用方走主线程兜底
 *   }
 *
 * Worker 为模块级单例：聊天消息气泡会实例化大量 MarkdownRenderer 组件，
 * 若每个组件都创建独立 Worker（含 markdown-it + highlight.js 全套），
 * 长会话会占用几十个常驻 Worker 导致内存爆炸。单例共享一个 Worker 即可。
 *
 * 失败语义：renderInWorker 在「Worker 不可用 / 超时 / onerror」时 reject(Error)。
 * 调用方用 .catch(() => '') 或 try/catch 降级到主线程渲染。
 * 旧的「resolve('') 表示失败」约定已废弃——空串是合法的渲染输出（空内容），
 * 用它兼作失败信号会吞掉真实错误并让 onerror 静默退化。
 */
let worker = null;
let isReady = ref(false);
let lastCrashAt = 0;
// 崩溃退避：模块加载失败类错误会持续崩，短间隔重建只会让每次渲染白等超时
const RESPAWN_COOLDOWN_MS = 30000;

// pending 条目：{ resolve, reject, timer }
// 每条带独立超时定时器，超时即 reject 并自我清理，杜绝泄漏。
let pendingCallbacks = new Map();
let idCounter = 0;

const WORKER_TIMEOUT_MS = 5000;
const MAX_DURATION_SAMPLES = 200;
const workerStats = {
  submitted: 0,
  completed: 0,
  failed: 0,
  timedOut: 0,
  staleResults: 0,
  contentChars: 0,
  durations: [],
};

const now = () => globalThis.performance?.now?.() || Date.now();
const recordDuration = (duration) => {
  if (!Number.isFinite(duration) || duration < 0) return;
  workerStats.durations.push(Math.round(duration));
  if (workerStats.durations.length > MAX_DURATION_SAMPLES) {
    workerStats.durations.splice(0, workerStats.durations.length - MAX_DURATION_SAMPLES);
  }
};
const percentile = (values, ratio) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)];
};

export const getMarkdownWorkerStats = () => ({
  submitted: workerStats.submitted,
  completed: workerStats.completed,
  failed: workerStats.failed,
  timedOut: workerStats.timedOut,
  staleResults: workerStats.staleResults,
  contentChars: workerStats.contentChars,
  queueDepth: pendingCallbacks.size,
  queued: Math.max(pendingCallbacks.size - 1, 0),
  inFlight: pendingCallbacks.size > 0 ? 1 : 0,
  duration: {
    p50Ms: percentile(workerStats.durations, 0.5),
    p95Ms: percentile(workerStats.durations, 0.95),
    sampleCount: workerStats.durations.length,
  },
});

let lastReportedAt = 0;

function reportMarkdownWorkerStats() {
  if (!import.meta.env.PROD || typeof fetch !== 'function') return;
  const timestamp = Date.now();
  if (timestamp - lastReportedAt < 60_000) return;
  lastReportedAt = timestamp;
  const body = JSON.stringify({ name: 'markdown_worker', ...getMarkdownWorkerStats() });
  try {
    if (typeof navigator !== 'undefined' && navigator.sendBeacon && typeof Blob !== 'undefined') {
      navigator.sendBeacon('/api/metrics/client-performance', new Blob([body], { type: 'application/json' }));
      return;
    }
  } catch {
    // fetch fallback below
  }
  fetch('/api/metrics/client-performance', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body,
    keepalive: true,
  }).catch(() => {});
}

export const recordMarkdownWorkerStaleResult = () => {
  workerStats.staleResults += 1;
};

function settleEntry(entry, outcome) {
  if (!entry || entry.settled) return;
  entry.settled = true;
  recordDuration(now() - entry.startedAt);
  workerStats.contentChars += entry.contentLength || 0;
  if (outcome === 'completed') workerStats.completed += 1;
  else workerStats.failed += 1;
  reportMarkdownWorkerStats();
}

function rejectAllPending(reason) {
  for (const [, entry] of pendingCallbacks) {
    if (entry.timer) clearTimeout(entry.timer);
    settleEntry(entry, 'failed');
    entry.reject(reason);
  }
  pendingCallbacks.clear();
}

function initWorker() {
  if (worker || isReady.value) return;
  if (Date.now() - lastCrashAt < RESPAWN_COOLDOWN_MS) return;
  try {
    worker = new Worker(
      new URL('../workers/markdown.worker.js', import.meta.url),
      { type: 'module' }
    );

    worker.onmessage = (e) => {
      const { id, html } = e.data;
      const entry = pendingCallbacks.get(id);
      if (entry) {
        pendingCallbacks.delete(id);
        if (entry.timer) clearTimeout(entry.timer);
        settleEntry(entry, 'completed');
        entry.resolve(html);
      }
    };

    worker.onerror = (err) => {
      console.error('[MarkdownWorker] Error:', err);
      // Worker 崩溃：拒绝所有在途请求，调用方各自降级主线程。
      // 必须复位单例状态，否则 worker 恒为「存在但已死」，
      // 后续每次大内容渲染都要等满 5s 超时才能走主线程兜底
      rejectAllPending(new Error('markdown worker error'));
      try { worker.terminate(); } catch { /* 已死 */ }
      worker = null;
      isReady.value = false;
      lastCrashAt = Date.now();
    };

    isReady.value = true;
  } catch {
    console.warn('[MarkdownWorker] Worker not supported, falling back to main thread');
    isReady.value = false;
  }
}

export function useMarkdownWorker() {
  initWorker();

  const renderInWorker = (content) => {
    return new Promise((resolve, reject) => {
      // 上次崩溃后已过冷却期 → 允许重建一次再判定
      if (!worker || !isReady.value) initWorker();
      if (!worker || !isReady.value) {
        reject(new Error('markdown worker unavailable'));
        return;
      }

      const id = ++idCounter;

      // 独立超时：到点未回 → reject 并自我清理，确保 entry 不残留
      const timer = setTimeout(() => {
        const entry = pendingCallbacks.get(id);
        if (entry) {
          pendingCallbacks.delete(id);
          workerStats.timedOut += 1;
          settleEntry(entry, 'failed');
          reject(new Error('markdown worker timeout'));
        }
      }, WORKER_TIMEOUT_MS);

      const entry = { resolve, reject, timer, startedAt: now(), settled: false, contentLength: String(content || '').length };
      pendingCallbacks.set(id, entry);
      workerStats.submitted += 1;
      try {
        worker.postMessage({ id, content });
      } catch (error) {
        pendingCallbacks.delete(id);
        clearTimeout(timer);
        settleEntry(entry, 'failed');
        reject(error);
      }
    });
  };

  return {
    isReady,
    renderInWorker,
    getStats: getMarkdownWorkerStats,
    recordStaleResult: recordMarkdownWorkerStaleResult,
  };
}
