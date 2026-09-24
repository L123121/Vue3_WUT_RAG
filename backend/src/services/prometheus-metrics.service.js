"use strict";

const { operationalMetrics } = require('./operational-metrics.service');

/**
 * PrometheusMetrics — Prometheus 文本格式 /metrics 渲染（零依赖）
 *
 * 把自研运营指标层（operational-metrics.service：计数器 + 有界原始延迟样本）
 * 映射为 Prometheus 文本格式，并补充进程自观测（内存 / uptime / 事件循环延迟）。
 * 抓取方放外部（Prometheus / Grafana Cloud），2G 小主机不本地塞监控栈。
 *
 * 注意：原始样本是滑动窗口（≤2000 条），只能做 histogram 分布，
 * 计数器一律取生命周期累计的 totals，避免窗口翻转造成计数器回退。
 *
 * 渲染器 renderPrometheusMetrics 为纯函数，独立于采集，便于单测。
 */

// 延迟直方图分桶（ms）：覆盖 HTTP 请求（<50ms 命中缓存 → 数十秒 LLM 流式）与 LLM 调用
const LATENCY_BUCKETS_MS = [50, 100, 250, 500, 1000, 2000, 3000, 5000, 10000, 30000];

const METRIC_PREFIX = 'wuli_elf_';

const escapeHelp = (text) => String(text).replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
const escapeLabelValue = (value) => String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');

/** 数值格式化：浮点截到 6 位小数（成本类），NaN/Infinity 归 0（Prometheus 不接受） */
function formatValue(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '0';
  return String(Math.round(num * 1e6) / 1e6);
}

function counterLine(name, value, labels = null) {
  const labelPart = labels
    ? `{${Object.entries(labels).map(([k, v]) => `${k}="${escapeLabelValue(v)}"`).join(',')}}`
    : '';
  return `${METRIC_PREFIX}${name}${labelPart} ${formatValue(value)}`;
}

/**
 * 直方图族：分桶（累计）、sum、count。
 * 样本先排序，用指针扫描出各 le 的累计数，O(n log n) / 每次抓取。
 */
function histogramFamily(name, help, samples, buckets) {
  const sorted = (samples || []).filter((v) => Number.isFinite(v) && v >= 0).sort((a, b) => a - b);
  const lines = [`# HELP ${METRIC_PREFIX}${name} ${escapeHelp(help)}`, `# TYPE ${METRIC_PREFIX}${name} histogram`];
  let idx = 0;
  for (const le of buckets) {
    while (idx < sorted.length && sorted[idx] <= le) idx++;
    lines.push(`${METRIC_PREFIX}${name}_bucket{le="${le}"} ${idx}`);
  }
  lines.push(`${METRIC_PREFIX}${name}_bucket{le="+Inf"} ${sorted.length}`);
  lines.push(`${METRIC_PREFIX}${name}_sum ${formatValue(sorted.reduce((s, v) => s + v, 0))}`);
  lines.push(`${METRIC_PREFIX}${name}_count ${sorted.length}`);
  return lines;
}

function counterFamily(name, help, value, labels = null) {
  return [`# HELP ${METRIC_PREFIX}${name} ${escapeHelp(help)}`, `# TYPE ${METRIC_PREFIX}${name} counter`, counterLine(name, value, labels)];
}

function gaugeFamily(name, help, value) {
  return [`# HELP ${METRIC_PREFIX}${name} ${escapeHelp(help)}`, `# TYPE ${METRIC_PREFIX}${name} gauge`, counterLine(name, value)];
}

/**
 * 纯函数渲染：data 形如 collectPrometheusSnapshot() 的返回值
 */
function renderPrometheusMetrics(data) {
  const {
    totals = {}, dailyCostCny = 0, httpDurations = [], llmLatencies = [],
    runDurations = [], runFirstEventLatencies = [], decisionLatencies = [], memory = null, uptimeSeconds = null, eventLoop = null,
  } = data || {};

  const lines = [];
  lines.push(...counterFamily('http_requests_total', 'Total HTTP requests recorded by the ops metrics layer', totals.requests || 0));
  lines.push(...counterFamily('http_request_errors_total', 'Total HTTP requests answered with status >= 500', totals.requestErrors || 0));
  lines.push(...histogramFamily('http_request_duration_ms', 'HTTP request duration in milliseconds', httpDurations, LATENCY_BUCKETS_MS));

  lines.push(...counterFamily('runs_total', 'Total conversation/agent runs recorded', totals.runs || 0));
  lines.push(...counterFamily('runs_completed_total', 'Total conversation/agent runs completed', totals.completedRuns || 0));
  lines.push(...counterFamily('runs_failed_total', 'Total conversation/agent runs failed', totals.failedRuns || 0));
  lines.push(...counterFamily('runs_aborted_total', 'Total conversation/agent runs aborted', totals.abortedRuns || 0));
  lines.push(...counterFamily('run_tool_calls_total', 'Total tool calls observed across runs', totals.runToolCalls || 0));
  lines.push(...counterFamily('run_fallbacks_total', 'Total runs that fell back to another chain', totals.runFallbacks || 0));
  lines.push(...histogramFamily('run_duration_ms', 'Conversation/agent run duration in milliseconds', runDurations, LATENCY_BUCKETS_MS));
  lines.push(...histogramFamily('run_first_event_ms', 'Time to first RunEvent in milliseconds', runFirstEventLatencies, LATENCY_BUCKETS_MS));

  lines.push(...counterFamily('decision_calls_total', 'Total Jev/System One decision calls recorded', totals.decisionCalls || 0));
  lines.push(...counterFamily('decision_successes_total', 'Total successful Jev/System One decisions', totals.decisionSuccesses || 0));
  lines.push(...counterFamily('decision_fallbacks_total', 'Total Jev/System One decisions that fell back', totals.decisionFallbacks || 0));
  lines.push(...counterFamily('decision_timeouts_total', 'Total Jev/System One decision timeouts', totals.decisionTimeouts || 0));
  lines.push(...counterFamily('decision_shadow_total', 'Total Jev/System One shadow decisions', totals.decisionShadow || 0));
  lines.push(...histogramFamily('decision_latency_ms', 'Jev/System One decision latency in milliseconds', decisionLatencies, LATENCY_BUCKETS_MS));

  lines.push(...counterFamily('llm_calls_total', 'Total LLM calls recorded', totals.llmCalls || 0));
  lines.push(`# HELP ${METRIC_PREFIX}llm_tokens_total Total LLM tokens by type`);
  lines.push(`# TYPE ${METRIC_PREFIX}llm_tokens_total counter`);
  lines.push(counterLine('llm_tokens_total', totals.promptTokens || 0, { type: 'prompt' }));
  lines.push(counterLine('llm_tokens_total', totals.completionTokens || 0, { type: 'completion' }));
  lines.push(...counterFamily('llm_cost_cny_total', 'Estimated LLM cost in CNY (lifetime, cumulative)', totals.llmCostCny || 0));
  lines.push(...histogramFamily('llm_latency_ms', 'LLM call latency in milliseconds', llmLatencies, LATENCY_BUCKETS_MS));

  lines.push(...counterFamily('tts_calls_total', 'Total TTS synthesis calls', totals.ttsCalls || 0));
  lines.push(...counterFamily('tts_characters_total', 'Total TTS characters synthesized', totals.ttsCharacters || 0));
  lines.push(...counterFamily('tts_cost_cny_total', 'Estimated TTS cost in CNY (lifetime, cumulative)', totals.ttsCostCny || 0));

  lines.push(...gaugeFamily('daily_cost_cny', 'Estimated cost in CNY for the current local day (LLM + TTS)', dailyCostCny));

  if (uptimeSeconds !== null && Number.isFinite(uptimeSeconds)) {
    lines.push(...gaugeFamily('process_uptime_seconds', 'Process uptime in seconds', uptimeSeconds));
  }
  if (memory) {
    lines.push(...gaugeFamily('process_resident_memory_bytes', 'Process resident set size in bytes', memory.rss));
    lines.push(...gaugeFamily('process_heap_used_bytes', 'V8 heap used in bytes', memory.heapUsed));
    lines.push(...gaugeFamily('process_heap_total_bytes', 'V8 heap total in bytes', memory.heapTotal));
    lines.push(...gaugeFamily('process_external_memory_bytes', 'V8 external memory in bytes', memory.external));
  }
  if (eventLoop) {
    lines.push(`# HELP ${METRIC_PREFIX}event_loop_lag_ms Event loop delay in milliseconds`);
    lines.push(`# TYPE ${METRIC_PREFIX}event_loop_lag_ms summary`);
    for (const [q, key] of [['0.5', 'p50Ms'], ['0.95', 'p95Ms'], ['0.99', 'p99Ms']]) {
      lines.push(`${METRIC_PREFIX}event_loop_lag_ms{quantile="${q}"} ${formatValue(eventLoop[key])}`);
    }
    lines.push(...gaugeFamily('event_loop_lag_max_ms', 'Max observed event loop delay in milliseconds since monitor start', eventLoop.maxMs));
  }

  return `${lines.join('\n')}\n`;
}

/**
 * 事件循环延迟监测：进程级单例，20ms 分辨率。
 * 只在 /metrics 端点启用时开启（无抓取方时零开销）。
 */
let eventLoopHistogram = null;
function ensureEventLoopMonitor() {
  if (eventLoopHistogram) return eventLoopHistogram;
  const { monitorEventLoopDelay } = require('perf_hooks');
  eventLoopHistogram = monitorEventLoopDelay({ resolution: 20 });
  eventLoopHistogram.enable();
  return eventLoopHistogram;
}

/**
 * 采集当前快照（operational-metrics 计数器/原始样本 + 进程自观测）
 */
function collectPrometheusSnapshot() {
  const snapshot = operationalMetrics.snapshot();
  const raw = operationalMetrics.rawSamples();

  let eventLoop = null;
  if (eventLoopHistogram) {
    // monitorEventLoopDelay 统计单位为纳秒
    eventLoop = {
      p50Ms: eventLoopHistogram.percentile(50) / 1e6,
      p95Ms: eventLoopHistogram.percentile(95) / 1e6,
      p99Ms: eventLoopHistogram.percentile(99) / 1e6,
      maxMs: eventLoopHistogram.max / 1e6,
    };
  }

  return {
    totals: {
      requests: snapshot.requests?.total || 0,
      requestErrors: snapshot.requests?.errors || 0,
      llmCalls: snapshot.llm?.total || 0,
      promptTokens: snapshot.llm?.promptTokens || 0,
      completionTokens: snapshot.llm?.completionTokens || 0,
      llmCostCny: snapshot.llm?.estimatedCostCny || 0,
      ttsCalls: snapshot.tts?.total || 0,
      ttsCharacters: snapshot.tts?.characters || 0,
      ttsCostCny: snapshot.tts?.estimatedCostCny || 0,
      runs: snapshot.runs?.total || 0,
      completedRuns: snapshot.runs?.completed || 0,
      failedRuns: snapshot.runs?.failed || 0,
      abortedRuns: snapshot.runs?.aborted || 0,
      runToolCalls: snapshot.runs?.toolCalls || 0,
      runFallbacks: snapshot.runs?.fallbacks || 0,
      decisionCalls: snapshot.decisions?.total || 0,
      decisionSuccesses: snapshot.decisions?.successes || 0,
      decisionFallbacks: snapshot.decisions?.fallbacks || 0,
      decisionTimeouts: snapshot.decisions?.timeouts || 0,
      decisionShadow: snapshot.decisions?.shadow || 0,
    },
    dailyCostCny: snapshot.daily?.estimatedCostCny || 0,
    httpDurations: raw.httpDurations,
    llmLatencies: raw.llmLatencies,
    runDurations: raw.runDurations,
    runFirstEventLatencies: raw.runFirstEventLatencies,
    decisionLatencies: raw.decisionLatencies,
    memory: process.memoryUsage(),
    uptimeSeconds: process.uptime(),
    eventLoop,
  };
}

module.exports = {
  renderPrometheusMetrics,
  collectPrometheusSnapshot,
  ensureEventLoopMonitor,
  LATENCY_BUCKETS_MS,
  METRIC_PREFIX,
  formatValue,
  escapeLabelValue,
};
