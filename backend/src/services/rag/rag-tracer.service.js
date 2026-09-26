"use strict";

const {
  compactPayload,
  createTraceId,
  logEvent,
  sanitizeError,
  truncateText,
} = require('../observability/observability.service');
const { recordStageSpan } = require('../observability/otel-tracing.service');

class RagTracer {
  constructor({ traceId = null, userId = null, conversationId = null, message = '', category = null } = {}) {
    this.traceId = traceId || createTraceId('rag');
    this.userId = userId;
    this.conversationId = conversationId;
    this.message = message;
    this.category = category;
    this.startedAt = Date.now();
    this.endedAt = null;
    this.status = 'ok';
    this.error = null;
    this.stages = [];
    this.outcome = {};
    this.retrieval = null;
  }

  recordStage(name, durationMs, success = true, details = {}, err = null) {
    this.stages.push({
      name,
      durationMs: Math.max(0, Math.round(Number(durationMs) || 0)),
      success: !!success,
      ...compactPayload(details),
      ...(err ? { error: sanitizeError(err) } : {}),
    });
    // OTel 启用时把阶段补成带显式时间戳的子 span（retrieve/rerank/generate…），关闭时 Noop
    recordStageSpan({
      name,
      durationMs,
      success,
      attributes: details,
      traceId: this.traceId,
    });
  }

  setRetrieval(retrieval) {
    this.retrieval = retrieval || null;
  }

  setOutcome(outcome = {}) {
    this.outcome = { ...this.outcome, ...compactPayload(outcome) };
  }

  markError(err) {
    this.status = 'error';
    this.error = sanitizeError(err);
  }

  markFallback(reason) {
    if (this.status === 'ok') this.status = 'fallback';
    if (!this.outcome.fallbackReason) this.outcome.fallbackReason = truncateText(reason, 120);
  }

  finish(extraOutcome = {}) {
    if (Object.keys(extraOutcome).length > 0) this.setOutcome(extraOutcome);
    if (!this.endedAt) this.endedAt = Date.now();
    const trace = this.toJSON();

    logEvent(this.status === 'error' ? 'error' : 'info', 'rag_trace', trace);
    return trace;
  }

  toJSON() {
    return {
      traceId: this.traceId,
      userId: this.userId,
      conversationId: this.conversationId,
      message: truncateText(this.message, 120),
      category: this.category,
      status: this.status,
      stages: this.stages,
      retrieval: this.retrieval,
      outcome: this.outcome,
      error: this.error,
      totalMs: this.endedAt ? (this.endedAt - this.startedAt) : (Date.now() - this.startedAt),
      startedAt: new Date(this.startedAt).toISOString(),
    };
  }

  toSummary() {
    const finished = this.endedAt || Date.now();
    const failedStages = this.stages.filter(stage => !stage.success);
    return {
      traceId: this.traceId,
      status: this.status,
      totalMs: finished - this.startedAt,
      stageCount: this.stages.length,
      failedStageCount: failedStages.length,
      failedStages: failedStages.map(stage => ({ name: stage.name, error: stage.error })),
      timings: this.stages.map(stage => ({ name: stage.name, durationMs: stage.durationMs, success: stage.success })),
      retrieval: this.retrieval,
      outcome: this.outcome,
      startedAt: new Date(this.startedAt).toISOString(),
    };
  }
}

module.exports = { RagTracer };

