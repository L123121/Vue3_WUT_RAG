"use strict";

/**
 * SSE 事件 → 线上格式的唯一映射层。
 *
 * v0 保留历史扁平事件与 [DONE]，供旧页面和评测脚本过渡使用；
 * v1 统一为 RunEvent 信封，避免前端依赖顶层字段形状识别事件。
 */

const { createRunId, createTraceId, sanitizeTraceId } = require("../services/observability.service");
const { recordRunEvent } = require('../services/run-event-log.service');
const { operationalMetrics } = require('../services/operational-metrics.service');

const RUN_EVENT_VERSION = 1;
const TERMINAL_RUN_EVENT_TYPES = new Set(["run.completed", "run.failed"]);

function writeSse(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function normalizeStreamVersion(value) {
  return Number.parseInt(value, 10) >= RUN_EVENT_VERSION ? RUN_EVENT_VERSION : 0;
}

function normalizeAttempt(value) {
  const attempt = Number.parseInt(value, 10);
  return Number.isInteger(attempt) ? Math.min(Math.max(attempt, 0), 20) : 0;
}

function createStreamContext({ streamVersion, runId, attempt, traceId } = {}) {
  return {
    streamVersion: normalizeStreamVersion(streamVersion),
    runId: sanitizeTraceId(runId) || createRunId(),
    attempt: normalizeAttempt(attempt),
    traceId: sanitizeTraceId(traceId) || createTraceId("req"),
    sequence: 0,
    terminalWritten: false,
    metricsRecorded: false,
    startedAt: Date.now(),
    firstEventAt: null,
    route: 'unknown',
    toolRounds: 0,
    toolCalls: 0,
    fallback: false,
  };
}

function updateRunContext(context, type, data = {}) {
  if (!context || typeof context !== 'object') return;
  if (!context.firstEventAt) context.firstEventAt = Date.now();

  if (type === 'intent') {
    const intent = data.intent;
    context.route = typeof intent === 'string' ? intent : intent?.route || context.route;
  } else if (type === 'tool.call') {
    context.toolCalls += 1;
  } else if (type === 'trace') {
    const trace = data.trace || {};
    if (Number.isFinite(trace.rounds)) context.toolRounds = Math.max(context.toolRounds, trace.rounds);
    context.fallback = context.fallback || Boolean(trace.fallbackReason || trace.outcome?.fallbackReason);
  } else if (type === 'decision.fallback') {
    context.fallback = true;
  }
}

function recordRunMetrics(context, status) {
  if (!context || context.metricsRecorded) return;
  context.metricsRecorded = true;
  operationalMetrics.recordRun({
    status,
    route: context.route,
    durationMs: Date.now() - context.startedAt,
    firstEventMs: context.firstEventAt ? context.firstEventAt - context.startedAt : 0,
    toolRounds: context.toolRounds,
    toolCalls: context.toolCalls,
    fallback: context.fallback,
    traceId: context.traceId,
  });
}

function isRunEventV1(context) {
  return context?.streamVersion === RUN_EVENT_VERSION;
}

function resolveTraceId(value, fallbackTraceId) {
  return sanitizeTraceId(value) || sanitizeTraceId(fallbackTraceId) || createTraceId("req");
}

function writeRunEvent(res, context, type, data = {}, traceId = context?.traceId) {
  if (TERMINAL_RUN_EVENT_TYPES.has(type) && context?.terminalWritten) return false;
  updateRunContext(context, type, data);
  if (TERMINAL_RUN_EVENT_TYPES.has(type)) {
    context.terminalWritten = true;
    recordRunMetrics(context, type === 'run.completed' ? 'completed' : 'failed');
  }
  if (!isRunEventV1(context)) return false;

  context.sequence += 1;
  const payload = {
    v: RUN_EVENT_VERSION,
    runId: context.runId,
    attempt: context.attempt,
    seq: context.sequence,
    type,
    traceId: resolveTraceId(traceId, context.traceId),
    data: data && typeof data === "object" ? data : {},
  };
  void recordRunEvent(payload);
  writeSse(res, payload);
  return true;
}

function writeRunStarted(res, context, data = {}) {
  return writeRunEvent(res, context, "run.started", data);
}

function writeRunCompleted(res, context, data = {}) {
  return writeRunEvent(res, context, "run.completed", data);
}

function writeRunFailed(res, context, error) {
  const message = String(error?.message || error || "流式请求失败").slice(0, 300);
  return writeRunEvent(res, context, "run.failed", {
    code: error?.code || "STREAM_FAILED",
    message,
  });
}

function projectTrace(event, fallbackTraceId) {
  const trace = event.trace || {};
  const traceId = resolveTraceId(trace.traceId, fallbackTraceId);

  if (event.channel === "agentic_rag") {
    return {
      traceId,
      data: {
        channel: "agentic_rag",
        trace: {
          rounds: trace.rounds || 0,
          queries: trace.queries || [],
          toolCalls: trace.toolCalls || [],
          matchedDocs: trace.matchedDocs || 0,
          totalMs: trace.totalMs || 0,
          finishReason: trace.finishReason || null,
          fallbackReason: trace.fallbackReason || null,
        },
      },
    };
  }

  if (event.channel === "agent") {
    return {
      traceId,
      data: {
        channel: "agent",
        trace: {
          rounds: trace.rounds || 0,
          toolCalls: trace.toolCalls || [],
          totalMs: trace.totalMs || 0,
          finishReason: trace.finishReason || null,
        },
      },
    };
  }

  const outcome = trace.outcome || {};
  return {
    traceId,
    data: {
      channel: "rag",
      trace: {
        usedRag: outcome.usedRag === true,
        usedParentChild: outcome.usedParentChild === true,
        matchedDocs: outcome.matchedDocs || 0,
        retrievedChunks: outcome.retrievedChunks || 0,
        fallbackReason: outcome.fallbackReason || null,
      },
    },
  };
}

function mapInternalEventToRunEvent(event, fallbackTraceId) {
  if (!event || typeof event !== "object") return null;

  if (event.type === "decision") {
    const status = event.decision?.status === "fallback" ? "fallback" : "applied";
    return {
      type: `decision.${status}`,
      traceId: fallbackTraceId,
      data: { decision: event.decision || {} },
    };
  }
  if (event.type === "retrieval") {
    return {
      type: "retrieval",
      traceId: resolveTraceId(event.traceId, fallbackTraceId),
      data: { retrieval: event.retrieval || null, trace: event.trace || null },
    };
  }
  if (event.type === "intent") {
    return { type: "intent", traceId: fallbackTraceId, data: { intent: event.intent || null } };
  }
  if (event.type === "sources") {
    return { type: "sources", traceId: fallbackTraceId, data: { sources: event.sources || [] } };
  }
  if (event.type === "tool_call") {
    return { type: "tool.call", traceId: fallbackTraceId, data: { toolCall: event.tool_call || null } };
  }
  if (event.type === "tool_result") {
    return {
      type: "tool.result",
      traceId: fallbackTraceId,
      data: {
        toolResult: {
          name: event.tool_result?.name,
          content: event.tool_result?.uiSummary || event.tool_result?.content,
          durationMs: event.tool_result?.durationMs,
          artifactId: event.tool_result?.artifactId || null,
          spilled: event.tool_result?.spilled === true,
          totalChars: event.tool_result?.totalChars || 0,
          offset: event.tool_result?.offset || 0,
          hasMore: event.tool_result?.hasMore === true,
        },
      },
    };
  }
  if (event.type === "process") {
    return { type: "process", traceId: fallbackTraceId, data: { processCard: event.processCard || null } };
  }
  if (event.type === "trace") {
    const projected = projectTrace(event, fallbackTraceId);
    return { type: "trace", ...projected };
  }
  if (event.type === "grounding") {
    return { type: "grounding", traceId: fallbackTraceId, data: { grounding: event.grounding || null } };
  }
  if (event.type === "usage") {
    return { type: "usage", traceId: fallbackTraceId, data: { usage: event.usage || null } };
  }
  if (event.type === "followups") {
    return { type: "followups", traceId: fallbackTraceId, data: { items: event.items || [] } };
  }
  if (event.type === "content" && !event.done) {
    return {
      type: "message.delta",
      traceId: fallbackTraceId,
      data: { content: event.content || "", decision: event.decision === true },
    };
  }

  // 只有显式标记为 public 的未来扩展事件才能透传，避免把内部 event 整体暴露给客户端。
  if (event.public === true && /^[a-z][a-z0-9._-]{1,80}$/i.test(String(event.publicType || ""))) {
    return {
      type: String(event.publicType),
      traceId: fallbackTraceId,
      data: event.publicData && typeof event.publicData === "object" && !Array.isArray(event.publicData)
        ? event.publicData
        : {},
    };
  }

  return null;
}

function writeLegacyStreamEvent(res, event, fallbackTraceId) {
  if (event.type === "retrieval") {
    writeSse(res, { traceId: event.traceId || fallbackTraceId, retrieval: event.retrieval, trace: event.trace });
  } else if (event.type === "intent") {
    writeSse(res, { intent: event.intent });
  } else if (event.type === "sources") {
    writeSse(res, { traceId: fallbackTraceId, sources: event.sources });
  } else if (event.type === "tool_call") {
    writeSse(res, { tool_call: event.tool_call });
  } else if (event.type === "tool_result") {
    writeSse(res, {
      tool_result: {
        name: event.tool_result?.name,
        content: event.tool_result?.uiSummary || event.tool_result?.content,
        durationMs: event.tool_result?.durationMs,
      },
    });
  } else if (event.type === "process") {
    writeSse(res, { traceId: fallbackTraceId, processCard: event.processCard });
  } else if (event.type === "trace" && event.channel === "agentic_rag") {
    const trace = event.trace || {};
    writeSse(res, {
      traceId: trace.traceId || fallbackTraceId,
      agenticRag: {
        rounds: trace.rounds || 0,
        queries: trace.queries || [],
        toolCalls: trace.toolCalls || [],
        matchedDocs: trace.matchedDocs || 0,
        totalMs: trace.totalMs || 0,
        finishReason: trace.finishReason || null,
        fallbackReason: trace.fallbackReason || null,
      },
    });
  } else if (event.type === "trace" && event.channel === "agent") {
    const trace = event.trace || {};
    writeSse(res, {
      traceId: trace.traceId || fallbackTraceId,
      agent: {
        rounds: trace.rounds || 0,
        toolCalls: trace.toolCalls || [],
        totalMs: trace.totalMs || 0,
        finishReason: trace.finishReason || null,
      },
    });
  } else if (event.type === "trace") {
    const outcome = event.trace?.outcome || {};
    writeSse(res, {
      traceId: event.trace?.traceId || fallbackTraceId,
      rag: {
        usedRag: outcome.usedRag === true,
        usedParentChild: outcome.usedParentChild === true,
        matchedDocs: outcome.matchedDocs || 0,
        retrievedChunks: outcome.retrievedChunks || 0,
        fallbackReason: outcome.fallbackReason || null,
      },
    });
  } else if (event.type === "grounding") {
    writeSse(res, { traceId: fallbackTraceId, grounding: event.grounding });
  } else if (event.type === "usage") {
    writeSse(res, { usage: event.usage });
  } else if (event.type === "followups") {
    writeSse(res, { traceId: fallbackTraceId, followups: event.items });
  } else if (event.type === "content") {
    if (event.done) res.write("data: [DONE]\n\n");
    else if (event.decision) writeSse(res, { content: event.content || "", decision: true });
    else writeSse(res, { content: event.content || "" });
  }
}

function writeStreamEvent(res, event, contextOrTraceId) {
  if (isRunEventV1(contextOrTraceId)) {
    const mapped = mapInternalEventToRunEvent(event, contextOrTraceId.traceId);
    if (!mapped) return false;
    return writeRunEvent(res, contextOrTraceId, mapped.type, mapped.data, mapped.traceId);
  }
  if (contextOrTraceId && typeof contextOrTraceId === 'object') {
    const mapped = mapInternalEventToRunEvent(event, contextOrTraceId.traceId);
    if (mapped) updateRunContext(contextOrTraceId, mapped.type, mapped.data);
    writeLegacyStreamEvent(res, event, contextOrTraceId.traceId);
  } else {
    writeLegacyStreamEvent(res, event, contextOrTraceId);
  }
  return true;
}

module.exports = {
  RUN_EVENT_VERSION,
  createStreamContext,
  isRunEventV1,
  mapInternalEventToRunEvent,
  writeRunCompleted,
  writeRunEvent,
  writeRunFailed,
  writeRunStarted,
  writeSse,
  writeStreamEvent,
};
