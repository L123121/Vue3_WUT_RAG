/**
 * @import { RunEvent, RunEventHandlerMap } from '../types/runEvents'
 */

export const RUN_EVENT_VERSION = 1;

export const RUN_EVENT_TYPES = Object.freeze({
  RUN_STARTED: 'run.started',
  RUN_COMPLETED: 'run.completed',
  RUN_FAILED: 'run.failed',
  MESSAGE_DELTA: 'message.delta',
  INTENT: 'intent',
  DECISION_APPLIED: 'decision.applied',
  DECISION_FALLBACK: 'decision.fallback',
  RETRIEVAL: 'retrieval',
  SOURCES: 'sources',
  TOOL_CALL: 'tool.call',
  TOOL_RESULT: 'tool.result',
  PROCESS: 'process',
  TRACE: 'trace',
  GROUNDING: 'grounding',
  USAGE: 'usage',
  FOLLOWUPS: 'followups',
});

export const TERMINAL_RUN_EVENT_TYPES = new Set([
  RUN_EVENT_TYPES.RUN_COMPLETED,
  RUN_EVENT_TYPES.RUN_FAILED,
]);

export const createRunId = () => {
  const id = globalThis.crypto?.randomUUID?.()
    || `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
  return `run_${id}`;
};

export const isRunEventV1 = (value) => (
  value
  && typeof value === 'object'
  && value.v === RUN_EVENT_VERSION
  && typeof value.runId === 'string'
  && Number.isInteger(value.attempt)
  && Number.isInteger(value.seq)
  && typeof value.type === 'string'
  && value.data
  && typeof value.data === 'object'
);

/**
 * 实时流与历史回放共用的事件映射器。
 * 只负责把协议事件投影到 UI 回调，不负责 runId/seq 校验或状态收敛。
 *
 * @param {RunEvent} event
 * @param {RunEventHandlerMap} [handlers]
 * @returns {boolean} 事件通过 v1 校验并分发时为 true
 */
export const dispatchRunEvent = (event, handlers = {}) => {
  if (!isRunEventV1(event)) return false;
  const data = event.data || {};
  switch (event.type) {
    case RUN_EVENT_TYPES.RUN_STARTED:
      handlers.onStarted?.(event);
      break;
    case RUN_EVENT_TYPES.MESSAGE_DELTA:
      handlers.onChunk?.(data.content || '', { decision: data.decision === true }, event);
      break;
    case RUN_EVENT_TYPES.INTENT:
      handlers.onIntent?.(data.intent, event);
      break;
    case RUN_EVENT_TYPES.DECISION_APPLIED:
    case RUN_EVENT_TYPES.DECISION_FALLBACK:
      handlers.onDecision?.(data.decision, event);
      break;
    case RUN_EVENT_TYPES.RETRIEVAL:
      handlers.onTrace?.({ traceId: event.traceId, retrieval: data.retrieval, trace: data.trace }, event);
      break;
    case RUN_EVENT_TYPES.SOURCES:
      handlers.onSources?.(data.sources || [], event);
      break;
    case RUN_EVENT_TYPES.TOOL_CALL:
      handlers.onToolCall?.(data.toolCall, event);
      break;
    case RUN_EVENT_TYPES.TOOL_RESULT:
      handlers.onToolResult?.(data.toolResult, event);
      break;
    case RUN_EVENT_TYPES.PROCESS:
      handlers.onProcess?.(data.processCard, event);
      break;
    case RUN_EVENT_TYPES.TRACE: {
      const tracePayload = { traceId: event.traceId };
      if (data.channel === 'agent') tracePayload.agent = data.trace;
      else if (data.channel === 'agentic_rag') tracePayload.agenticRag = data.trace;
      else tracePayload.rag = data.trace;
      handlers.onTrace?.(tracePayload, event);
      break;
    }
    case RUN_EVENT_TYPES.GROUNDING:
      handlers.onGrounding?.(data.grounding, event);
      break;
    case RUN_EVENT_TYPES.USAGE:
      handlers.onUsage?.(data.usage, event);
      break;
    case RUN_EVENT_TYPES.FOLLOWUPS:
      handlers.onFollowups?.(data.items || [], event);
      break;
    case RUN_EVENT_TYPES.RUN_COMPLETED:
      handlers.onDone?.(event);
      break;
    case RUN_EVENT_TYPES.RUN_FAILED: {
      const error = new Error(data.message || '运行失败');
      error.code = data.code;
      handlers.onError?.(error, event);
      break;
    }
    default:
      handlers.onUnknown?.({ type: event.type, data, origin: {
        attempt: event.attempt,
        seq: event.seq,
        traceId: event.traceId,
      } }, event);
      break;
  }
  return true;
};
