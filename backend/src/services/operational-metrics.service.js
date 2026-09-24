'use strict';

const { createDefaultOperationalMetricsPersistence } = require('./operational-metrics-persistence.service');
const { logEvent } = require('./observability.service');

const MAX_SAMPLES = 2000;
const DEFAULT_TIME_ZONE = 'Asia/Shanghai';
const TOTAL_DEFAULTS = {
  requests: 0,
  requestErrors: 0,
  llmCalls: 0,
  promptTokens: 0,
  completionTokens: 0,
  llmCostCny: 0,
  ttsCalls: 0,
  ttsCharacters: 0,
  ttsCostCny: 0,
  runs: 0,
  completedRuns: 0,
  failedRuns: 0,
  abortedRuns: 0,
  runToolCalls: 0,
  runFallbacks: 0,
  decisionCalls: 0,
  decisionSuccesses: 0,
  decisionFallbacks: 0,
  decisionTimeouts: 0,
  decisionShadow: 0,
};

const numberEnv = (name, fallback) => {
  const value = Number.parseFloat(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
};

const pushBounded = (list, value) => {
  list.push(value);
  if (list.length > MAX_SAMPLES) list.splice(0, list.length - MAX_SAMPLES);
};

const percentile = (values, ratio) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)];
};

const normalizeTimeZone = (value) => {
  const timeZone = String(value || DEFAULT_TIME_ZONE).trim() || DEFAULT_TIME_ZONE;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(0);
    return timeZone;
  } catch (error) {
    logEvent('warn', 'op_metrics_invalid_timezone_fallback', { timeZone, fallback: DEFAULT_TIME_ZONE, error: error.message });
    return DEFAULT_TIME_ZONE;
  }
};

const localDayKey = (timestamp, timeZone) => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(timestamp));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
};

const estimateLlmCost = (promptTokens, completionTokens) => (
  promptTokens * numberEnv('AI_INPUT_COST_CNY_PER_MILLION', 0) / 1_000_000
  + completionTokens * numberEnv('AI_OUTPUT_COST_CNY_PER_MILLION', 0) / 1_000_000
);

const createOperationalMetrics = (options = {}) => {
  const now = options.now || Date.now;
  const timeZone = normalizeTimeZone(options.timeZone || process.env.OPS_TIMEZONE);
  const persistence = options.persistence || null;
  const configuredPersistDelay = options.persistDelayMs ?? numberEnv('OPS_METRICS_PERSIST_INTERVAL_MS', 5000);
  const persistDelayMs = Number.isFinite(configuredPersistDelay) ? Math.max(0, configuredPersistDelay) : 5000;
  const requests = [];
  const llmUsage = [];
  const ttsUsage = [];
  const runUsage = [];
  const decisionUsage = [];
  const alertState = new Map();
  let restoredState = null;
  if (persistence) {
    try {
      restoredState = persistence.load();
    } catch (error) {
      logEvent('warn', 'op_metrics_state_read_failed_reset', { error: error.message });
    }
  }
  const totals = Object.fromEntries(Object.entries(TOTAL_DEFAULTS).map(([key, fallback]) => {
    const value = Number(restoredState?.totals?.[key]);
    return [key, Number.isFinite(value) ? value : fallback];
  }));
  const currentDate = localDayKey(now(), timeZone);
  let daily = restoredState?.daily?.date === currentDate
    ? { date: currentDate, estimatedCostCny: Number(restoredState.daily.estimatedCostCny) || 0 }
    : { date: currentDate, estimatedCostCny: 0 };
  let persistTimer = null;
  let persistDirty = false;
  let closed = false;

  const persistedSnapshot = () => ({ totals: { ...totals }, daily: { ...daily } });

  const flush = () => {
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    if (!persistence || !persistDirty || closed) return;
    try {
      persistence.save(persistedSnapshot());
      persistDirty = false;
    } catch (error) {
      logEvent('warn', 'op_metrics_state_write_failed_memory_kept', { error: error.message });
    }
  };

  const schedulePersist = () => {
    if (!persistence || closed) return;
    persistDirty = true;
    if (persistDelayMs === 0) {
      flush();
      return;
    }
    if (persistTimer) return;
    persistTimer = setTimeout(flush, persistDelayMs);
    persistTimer.unref?.();
  };

  const ensureDaily = (timestamp = now()) => {
    const date = localDayKey(timestamp, timeZone);
    if (daily.date !== date) {
      daily = { date, estimatedCostCny: 0 };
      return true;
    }
    return false;
  };

  const currentDaily = (timestamp = now()) => {
    ensureDaily(timestamp);
    return daily;
  };

  const emitAlert = (key, message, details) => {
    const timestamp = now();
    if (timestamp - (alertState.get(key) || 0) < 60_000) return;
    alertState.set(key, timestamp);
    logEvent('warn', 'ops_alert', { message, ...details });
  };

  const checkAlerts = () => {
    const timestamp = now();
    const recent = requests.filter((item) => timestamp - item.timestamp < 5 * 60_000);
    if (recent.length) {
      const errorRate = recent.filter((item) => item.statusCode >= 500).length / recent.length;
      if (errorRate >= numberEnv('OPS_ALERT_ERROR_RATE', 0.1)) emitAlert('error-rate', 'HTTP 错误率超过阈值', { errorRate, total: recent.length });
      const p95 = percentile(recent.map((item) => item.durationMs), 0.95);
      if (p95 >= numberEnv('OPS_ALERT_P95_MS', 3000)) emitAlert('latency', 'HTTP P95 延迟超过阈值', { p95, total: recent.length });
    }
    const dailyState = currentDaily(timestamp);
    if (dailyState.estimatedCostCny >= numberEnv('OPS_ALERT_DAILY_COST_CNY', Number.POSITIVE_INFINITY)) {
      emitAlert('daily-cost', '当日模型成本超过阈值', { dailyCost: dailyState.estimatedCostCny });
    }
  };

  const recordRun = ({
    status = 'completed',
    route = 'unknown',
    durationMs = 0,
    firstEventMs = 0,
    toolRounds = 0,
    toolCalls = 0,
    fallback = false,
    traceId = null,
  } = {}) => {
    const timestamp = now();
    const normalizedStatus = ['completed', 'failed', 'aborted'].includes(status) ? status : 'failed';
    const duration = Number(durationMs);
    const firstEvent = Number(firstEventMs);
    const rounds = Number(toolRounds);
    const calls = Number(toolCalls);
    const isFallback = fallback === true;

    totals.runs += 1;
    totals[`${normalizedStatus}Runs`] += 1;
    totals.runToolCalls += Number.isFinite(calls) && calls > 0 ? calls : 0;
    if (isFallback) totals.runFallbacks += 1;
    pushBounded(runUsage, {
      timestamp,
      status: normalizedStatus,
      route: String(route || 'unknown').slice(0, 40),
      durationMs: Number.isFinite(duration) && duration >= 0 ? duration : 0,
      firstEventMs: Number.isFinite(firstEvent) && firstEvent >= 0 ? firstEvent : 0,
      toolRounds: Number.isFinite(rounds) && rounds >= 0 ? rounds : 0,
      toolCalls: Number.isFinite(calls) && calls >= 0 ? calls : 0,
      fallback: isFallback,
      traceId: traceId || null,
    });
    checkAlerts();
    schedulePersist();
  };

  return {
    recordRun,
    recordRequest({ method, path, statusCode, durationMs, traceId }) {
      const timestamp = now();
      totals.requests += 1;
      if (statusCode >= 500) totals.requestErrors += 1;
      pushBounded(requests, { timestamp, method, path, statusCode, durationMs, traceId: traceId || null });
      checkAlerts();
      schedulePersist();
    },
    recordError(error, context = {}) {
      logEvent('error', 'ops_error', { message: error?.message, stack: error?.stack, ...context });
    },
    recordDecision({ status = 'success', mode = 'off', latencyMs = 0, fallback = false, traceId = null } = {}) {
      const timestamp = now();
      const normalizedStatus = ['success', 'error', 'timeout'].includes(status) ? status : 'error';
      const latency = Number(latencyMs);
      totals.decisionCalls += 1;
      if (normalizedStatus === 'success') totals.decisionSuccesses += 1;
      if (normalizedStatus === 'timeout') totals.decisionTimeouts += 1;
      if (fallback || normalizedStatus !== 'success') totals.decisionFallbacks += 1;
      if (mode === 'shadow') totals.decisionShadow += 1;
      pushBounded(decisionUsage, {
        timestamp,
        status: normalizedStatus,
        mode: String(mode || 'off').slice(0, 20),
        latencyMs: Number.isFinite(latency) && latency >= 0 ? latency : 0,
        fallback: fallback === true || normalizedStatus !== 'success',
        traceId: traceId || null,
      });
      schedulePersist();
    },
    recordLlmUsage({ model, usage, traceId, latencyMs = 0 }) {
      if (!usage) return;
      const timestamp = now();
      const promptTokens = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0) || 0;
      const completionTokens = Number(usage.completion_tokens ?? usage.output_tokens ?? 0) || 0;
      const totalTokens = Number(usage.total_tokens ?? promptTokens + completionTokens) || 0;
      const estimatedCostCny = estimateLlmCost(promptTokens, completionTokens);
      totals.llmCalls += 1;
      totals.promptTokens += promptTokens;
      totals.completionTokens += completionTokens;
      totals.llmCostCny += estimatedCostCny;
      currentDaily(timestamp).estimatedCostCny += estimatedCostCny;
      pushBounded(llmUsage, { timestamp, model: model || 'unknown', promptTokens, completionTokens, totalTokens, estimatedCostCny, latencyMs, traceId: traceId || null });
      checkAlerts();
      schedulePersist();
    },
    recordTtsUsage({ model, characters, traceId, latencyMs = 0 }) {
      const timestamp = now();
      const count = Number(characters) || 0;
      const estimatedCostCny = count * numberEnv('TTS_COST_CNY_PER_10K_CHARS', 0) / 10_000;
      totals.ttsCalls += 1;
      totals.ttsCharacters += count;
      totals.ttsCostCny += estimatedCostCny;
      currentDaily(timestamp).estimatedCostCny += estimatedCostCny;
      pushBounded(ttsUsage, { timestamp, model: model || 'unknown', characters: count, estimatedCostCny, latencyMs, traceId: traceId || null });
      checkAlerts();
      schedulePersist();
    },
    snapshot() {
      const durations = requests.map((item) => item.durationMs);
      const runDurations = runUsage.map((item) => item.durationMs);
      const firstEventLatencies = runUsage.map((item) => item.firstEventMs);
      const decisionLatencies = decisionUsage.map((item) => item.latencyMs);
      const routeCounts = {};
      for (const item of runUsage) routeCounts[item.route] = (routeCounts[item.route] || 0) + 1;
      if (ensureDaily(now())) schedulePersist();
      return {
        requests: { total: totals.requests, errors: totals.requestErrors, p50Ms: percentile(durations, 0.5), p95Ms: percentile(durations, 0.95) },
        runs: {
          total: totals.runs,
          completed: totals.completedRuns,
          failed: totals.failedRuns,
          aborted: totals.abortedRuns,
          successRate: totals.runs > 0 ? totals.completedRuns / totals.runs : 0,
          fallbackRate: totals.runs > 0 ? totals.runFallbacks / totals.runs : 0,
          fallbacks: totals.runFallbacks,
          toolCalls: totals.runToolCalls,
          duration: { p50Ms: percentile(runDurations, 0.5), p95Ms: percentile(runDurations, 0.95) },
          firstEvent: { p50Ms: percentile(firstEventLatencies, 0.5), p95Ms: percentile(firstEventLatencies, 0.95) },
          routeCounts,
          recent: runUsage.slice(-100),
        },
        decisions: {
          total: totals.decisionCalls,
          successes: totals.decisionSuccesses,
          fallbacks: totals.decisionFallbacks,
          timeouts: totals.decisionTimeouts,
          shadow: totals.decisionShadow,
          successRate: totals.decisionCalls > 0 ? totals.decisionSuccesses / totals.decisionCalls : 0,
          fallbackRate: totals.decisionCalls > 0 ? totals.decisionFallbacks / totals.decisionCalls : 0,
          latency: { p50Ms: percentile(decisionLatencies, 0.5), p95Ms: percentile(decisionLatencies, 0.95) },
          recent: decisionUsage.slice(-100),
        },
        llm: { total: totals.llmCalls, promptTokens: totals.promptTokens, completionTokens: totals.completionTokens, estimatedCostCny: totals.llmCostCny, recent: llmUsage.slice(-100) },
        tts: { total: totals.ttsCalls, characters: totals.ttsCharacters, estimatedCostCny: totals.ttsCostCny, recent: ttsUsage.slice(-100) },
        daily: { ...daily },
        estimatedCostCny: totals.llmCostCny + totals.ttsCostCny,
      };
    },
    /**
     * 有界窗口内的原始样本（供 Prometheus 端点现场分桶直方图用）。
     * 注意这是滑动窗口样本，只用于分布（histogram），不可当单调计数器累加。
     */
    rawSamples() {
      return {
        httpDurations: requests.map((item) => item.durationMs).filter((v) => Number.isFinite(v) && v >= 0),
        llmLatencies: llmUsage.map((item) => item.latencyMs).filter((v) => Number.isFinite(v) && v > 0),
        runDurations: runUsage.map((item) => item.durationMs).filter((v) => Number.isFinite(v) && v >= 0),
        runFirstEventLatencies: runUsage.map((item) => item.firstEventMs).filter((v) => Number.isFinite(v) && v >= 0),
        decisionLatencies: decisionUsage.map((item) => item.latencyMs).filter((v) => Number.isFinite(v) && v >= 0),
      };
    },
    flush,
    close() {
      if (closed) return;
      flush();
      closed = true;
      persistence?.close?.();
    },
  };
};

const operationalMetrics = createOperationalMetrics({
  persistence: createDefaultOperationalMetricsPersistence(),
});

module.exports = { createOperationalMetrics, operationalMetrics };
