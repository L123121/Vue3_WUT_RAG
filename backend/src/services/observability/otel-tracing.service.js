"use strict";

const { logEvent } = require('./observability.service');

const config = require('../../config');
const api = require('@opentelemetry/api');

/**
 * OTelTracing — OpenTelemetry OTLP trace 导出（env 门控，默认关）
 *
 * 在自研轻量可观测层（traceId 贯穿 + rag-tracer 阶段记录 + LLM 用量记录）之上
 * 补标准协议导出，手动埋点三处（不引 auto-instrumentation，控内存）：
 *   1. HTTP 根 span — middleware 首个中间件，http.* 语义属性，res finish 收口
 *   2. RAG 阶段 span — RagTracer.recordStage 单点接线，显式时间戳子 span
 *   3. LLM 调用 span — ai.service 非流式/流式单一收口，gen_ai.* 语义属性
 *
 * 未设置 OTEL_EXPORTER_OTLP_ENDPOINT 时不加载 SDK：@opentelemetry/api 走
 * Noop tracer，埋点代码始终直调 helper（span 为 NonRecordingSpan，零成本），
 * 无需任何判空分支。OTel traceId 与应用 traceId 的关系：无上游 X-Trace-Id
 * 时优先采用 OTel traceId，两边同源；有上游头时应用 traceId 为准，另挂
 * app.trace_id 属性关联。
 */

const TRACER_NAME = 'wuli-elf';

let sdk = null;

/**
 * 初始化（进程内幂等）。
 * 用显式 spanProcessors + BatchSpanProcessor（sdk-node 0.221 的 traceExporter 废弃
 * 路径实测不导出）；测试可注入 options.spanProcessors（SimpleSpanProcessor + InMemory）直通。
 */
function initTracing(options = {}) {
  const cfg = config.otel || {};
  if (!cfg.enabled || sdk) return sdk;
  const { NodeSDK } = require('@opentelemetry/sdk-node');
  const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
  const { BatchSpanProcessor } = require('@opentelemetry/sdk-trace-node');
  sdk = new NodeSDK({
    spanProcessors: options.spanProcessors
      || [new BatchSpanProcessor(new OTLPTraceExporter())], // 端点/headers 读 OTEL_* 标准环境变量
    serviceName: process.env.OTEL_SERVICE_NAME || 'wuli-elf-backend',
  });
  sdk.start();
  logEvent('info', 'otel_tracing_enabled', { endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT });
  return sdk;
}

/** 优雅关闭：flush 未导出的 span（BatchSpanProcessor 在 shutdown 时强制冲刷） */
async function shutdownTracing() {
  if (!sdk) return;
  const closing = sdk;
  sdk = null;
  try {
    await closing.shutdown();
    logEvent('info', 'otel_tracing_shutdown_done', { message: 'tracing 已关闭（span 已 flush）' });
  } catch (err) {
    logEvent('warn', 'otel_tracing_shutdown_failed', { error: err.message });
  }
}

function isEnabled() {
  return !!sdk;
}

/** OTel 属性只接受标量/标量数组：非标量值 JSON 截断后放字符串 */
function scalarAttributes(attrs = {}) {
  const out = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') {
      out[key] = value;
    } else if (Array.isArray(value) && value.every((v) => typeof v === 'string' || typeof v === 'boolean' || typeof v === 'number')) {
      out[key] = value;
    } else {
      try {
        out[key] = String(JSON.stringify(value)).slice(0, 300);
      } catch { out[key] = String(value).slice(0, 300); }
    }
  }
  return out;
}

/** 通用 span 包装：OTel 关闭时为 Noop，直接执行 fn；错误自动 recordException + ERROR 状态 */
async function withActiveSpan(name, attributes, fn) {
  return api.trace.getTracer(TRACER_NAME).startActiveSpan(name, { attributes: scalarAttributes(attributes) }, async (span) => {
    try {
      return await fn(span);
    } catch (err) {
      span.recordException(err);
      span.setStatus({ code: api.SpanStatusCode.ERROR, message: String(err?.message || err).slice(0, 200) });
      throw err;
    } finally {
      span.end();
    }
  });
}

/**
 * HTTP 根 span：包住整个请求生命周期，fn 内的异步链都处于该 span 的上下文中。
 * span 在 res 'finish' 时收口（写入 http.response.status_code）。
 * fn 收到 { otelTraceId }（有效时），middleware 可将其作为应用 traceId。
 */
function withHttpRootSpan(req, res, fn) {
  if (!sdk) return fn(null);
  try {
    const tracer = api.trace.getTracer(TRACER_NAME);
    const span = tracer.startSpan(`HTTP ${req.method} ${req.path || req.url || ''}`, {
      attributes: scalarAttributes({
        'http.request.method': req.method,
        'url.path': req.path || String(req.originalUrl || '').split('?')[0],
        'server.address': req.hostname,
        'user_agent.original': req.get && req.get('user-agent'),
      }),
    });
    const spanContext = span.spanContext();
    const otelTraceId = spanContext && typeof spanContext.traceId === 'string' && /^[0-9a-f]{32}$/.test(spanContext.traceId)
      ? spanContext.traceId
      : null;
    const ctx = api.trace.setSpan(api.context.active(), span);
    return api.context.with(ctx, () => {
      res.on('finish', () => {
        try {
          span.setAttribute('http.response.status_code', res.statusCode);
        } catch { /* 埋点永不影响主流程 */ }
        span.end();
      });
      return fn({ otelTraceId });
    });
  } catch (err) {
    logEvent('warn', 'otel_http_span_create_failed_passthrough', { error: err.message });
    return fn(null);
  }
}

/**
 * RAG 阶段 span：RagTracer.recordStage 单点调用，阶段已结束（带 durationMs），
 * 用显式时间戳补出子 span；父 span 取当前活跃上下文（请求根 span）。
 */
function recordStageSpan({ name, durationMs, success = true, attributes = {}, traceId = null }) {
  if (!sdk) return;
  try {
    const tracer = api.trace.getTracer(TRACER_NAME);
    const endedAt = Date.now();
    const startedAt = endedAt - Math.max(0, Math.round(Number(durationMs) || 0));
    const span = tracer.startSpan(`rag.stage ${name}`, {
      startTime: startedAt,
      attributes: scalarAttributes({
        'rag.stage.name': name,
        'rag.stage.success': success,
        'app.trace_id': traceId || undefined,
        ...attributes,
      }),
    });
    if (!success) span.setStatus({ code: api.SpanStatusCode.ERROR, message: 'stage failed' });
    span.end(endedAt);
  } catch {
    // 埋点永不影响主流程
  }
}

/** LLM 流式 span：生成器无法用 startActiveSpan 包裹，手动起 span（父取活跃上下文），end 交给调用方 finally */
function startLlmSpan(provider, opts = {}) {
  if (!sdk) return null;
  try {
    return api.trace.getTracer(TRACER_NAME).startSpan(`LLM chat ${provider.model}`, {
      attributes: scalarAttributes({
        'gen_ai.system': 'stepfun',
        'gen_ai.operation.name': 'chat',
        'gen_ai.request.model': provider.model,
        'ai.stream': !!opts.stream,
      }),
    });
  } catch { return null; }
}

function setLlmUsage(span, usage) {
  if (!span || !usage) return;
  try {
    const promptTokens = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0) || 0;
    const completionTokens = Number(usage.completion_tokens ?? usage.output_tokens ?? 0) || 0;
    span.setAttributes({
      'gen_ai.usage.input_tokens': promptTokens,
      'gen_ai.usage.output_tokens': completionTokens,
    });
  } catch { /* 埋点永不影响主流程 */ }
}

function endLlmSpan(span, err = null) {
  if (!span) return;
  try {
    if (err) {
      span.recordException(err);
      span.setStatus({ code: api.SpanStatusCode.ERROR, message: String(err?.message || err).slice(0, 200) });
    }
    span.end();
  } catch { /* 埋点永不影响主流程 */ }
}

module.exports = {
  initTracing,
  shutdownTracing,
  isEnabled,
  withActiveSpan,
  withHttpRootSpan,
  recordStageSpan,
  startLlmSpan,
  setLlmUsage,
  endLlmSpan,
  scalarAttributes,
};
