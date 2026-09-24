import { describe, expect, it, vi } from 'vitest';
import {
  dispatchRunEvent,
  isRunEventV1,
  RUN_EVENT_TYPES,
} from '../utils/runEvents.js';

const event = (type, data = {}) => ({
  v: 1,
  runId: 'run_client_1',
  attempt: 0,
  seq: 1,
  type,
  traceId: 'trace_1',
  data,
});

describe('RunEvent v1 mapper', () => {
  it('将标准事件投影到统一 UI 回调', () => {
    const handlers = {
      onStarted: vi.fn(),
      onChunk: vi.fn(),
      onTrace: vi.fn(),
      onDone: vi.fn(),
    };

    dispatchRunEvent(event(RUN_EVENT_TYPES.RUN_STARTED), handlers);
    dispatchRunEvent(event(RUN_EVENT_TYPES.MESSAGE_DELTA, { content: '回答', decision: true }), handlers);
    dispatchRunEvent(event(RUN_EVENT_TYPES.TRACE, { channel: 'agent', trace: { rounds: 2 } }), handlers);
    dispatchRunEvent(event(RUN_EVENT_TYPES.RUN_COMPLETED), handlers);

    expect(handlers.onStarted).toHaveBeenCalledOnce();
    expect(handlers.onChunk).toHaveBeenCalledWith('回答', { decision: true }, expect.any(Object));
    expect(handlers.onTrace).toHaveBeenCalledWith({ traceId: 'trace_1', agent: { rounds: 2 } }, expect.any(Object));
    expect(handlers.onDone).toHaveBeenCalledOnce();
  });

  it('决策应用和降级事件进入 onDecision 回调', () => {
    const onDecision = vi.fn();
    dispatchRunEvent(event(RUN_EVENT_TYPES.DECISION_APPLIED, { decision: { applied: true } }), { onDecision });
    dispatchRunEvent(event(RUN_EVENT_TYPES.DECISION_FALLBACK, { decision: { fallback: true } }), { onDecision });

    expect(onDecision).toHaveBeenNthCalledWith(1, { applied: true }, expect.any(Object));
    expect(onDecision).toHaveBeenNthCalledWith(2, { fallback: true }, expect.any(Object));
  });

  it('未知事件保留原始类型、数据和序号来源，失败事件携带 code', () => {
    const onUnknown = vi.fn();
    const onError = vi.fn();
    const unknown = event('ui.chart', { points: [1, 2] });
    unknown.seq = 9;

    dispatchRunEvent(unknown, { onUnknown });
    dispatchRunEvent(event(RUN_EVENT_TYPES.RUN_FAILED, { code: 'UPSTREAM', message: '上游失败' }), { onError });

    expect(onUnknown).toHaveBeenCalledWith({
      type: 'ui.chart',
      data: { points: [1, 2] },
      origin: { attempt: 0, seq: 9, traceId: 'trace_1' },
    }, unknown);
    expect(onError.mock.calls[0][0]).toMatchObject({ message: '上游失败', code: 'UPSTREAM' });
  });

  it('拒绝不完整或错误版本的事件', () => {
    const handler = vi.fn();
    expect(isRunEventV1({ ...event(RUN_EVENT_TYPES.MESSAGE_DELTA), v: 2 })).toBe(false);
    expect(dispatchRunEvent({ type: RUN_EVENT_TYPES.MESSAGE_DELTA }, { onChunk: handler })).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });
});
