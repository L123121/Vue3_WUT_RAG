import { describe, expect, it } from 'vitest';

const {
  createStreamContext,
  writeRunCompleted,
  writeRunStarted,
  writeStreamEvent,
} = require('../src/utils/sse-events');

function createResponse() {
  const lines = [];
  return {
    lines,
    write(value) {
      lines.push(value);
    },
  };
}

function parseEvents(response) {
  return response.lines.map((line) => JSON.parse(line.slice('data: '.length)));
}

describe('RunEvent v1 SSE 映射', () => {
  it('以统一信封输出运行生命周期和内部流事件', () => {
    const response = createResponse();
    const context = createStreamContext({
      streamVersion: 1,
      runId: 'run_client_1',
      attempt: 2,
      traceId: 'trace_1',
    });

    writeRunStarted(response, context, { conversationId: 'conv_1' });
    writeStreamEvent(response, { type: 'intent', intent: { route: 'rag' } }, context);
    writeStreamEvent(response, { type: 'content', content: '你好', done: false }, context);
    writeStreamEvent(response, {
      type: 'trace',
      channel: 'agent',
      trace: {
        traceId: 'trace_agent',
        userId: 'private-user-id',
        conversationId: 'private-conversation-id',
        rounds: 2,
        toolCalls: [{ name: 'calculate' }],
        totalMs: 123,
        finishReason: 'direct_answer',
      },
    }, context);
    writeStreamEvent(response, { type: 'content', content: '', done: true }, context);
    writeRunCompleted(response, context);
    writeRunCompleted(response, context);

    const events = parseEvents(response);
    expect(events.map((event) => event.type)).toEqual([
      'run.started',
      'intent',
      'message.delta',
      'trace',
      'run.completed',
    ]);
    expect(events.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5]);
    for (const event of events) {
      expect(event).toMatchObject({
        v: 1,
        runId: 'run_client_1',
        attempt: 2,
        traceId: expect.any(String),
        data: expect.any(Object),
      });
    }
    expect(events[2].data).toEqual({ content: '你好', decision: false });
    expect(events[3].data).toEqual({
      channel: 'agent',
      trace: {
        rounds: 2,
        toolCalls: [{ name: 'calculate' }],
        totalMs: 123,
        finishReason: 'direct_answer',
      },
    });
    expect(JSON.stringify(events[3])).not.toContain('private-user-id');
    expect(JSON.stringify(events[3])).not.toContain('private-conversation-id');
  });

  it('决策应用与降级事件进入 v1 回放且不进入旧协议正文', () => {
    const response = createResponse();
    const context = createStreamContext({ streamVersion: 1, runId: 'run_decision_1', traceId: 'trace_decision' });

    writeStreamEvent(response, {
      type: 'decision',
      decision: { provider: 'jev', status: 'applied', applied: true, decisionId: 'jev_1' },
    }, context);
    writeStreamEvent(response, {
      type: 'decision',
      decision: { provider: 'jev', status: 'fallback', applied: false, fallback: true },
    }, context);

    const events = parseEvents(response);
    expect(events.map((event) => event.type)).toEqual(['decision.applied', 'decision.fallback']);
    expect(events[0].data.decision).toMatchObject({ provider: 'jev', applied: true });
    expect(events[1].data.decision).toMatchObject({ fallback: true });
  });

  it('未协商 v1 时保留旧内容事件和 [DONE] 终态', () => {
    const response = createResponse();

    writeStreamEvent(response, { type: 'content', content: '旧协议', done: false }, 'trace_legacy');
    writeStreamEvent(response, { type: 'content', content: '', done: true }, 'trace_legacy');

    expect(response.lines).toEqual([
      'data: {"content":"旧协议"}\n\n',
      'data: [DONE]\n\n',
    ]);
  });

  it('旧客户端传入 streamContext 时仍使用字符串 traceId，不泄露上下文对象', () => {
    const response = createResponse();
    const context = createStreamContext({ streamVersion: 0, traceId: 'trace_legacy_context' });

    writeRunStarted(response, context);
    writeStreamEvent(response, {
      type: 'sources',
      sources: [{ docId: 'doc-1', title: '校园手册' }],
    }, context);
    writeRunCompleted(response, context);

    const payload = JSON.parse(response.lines[0].slice('data: '.length));
    expect(payload.traceId).toBe('trace_legacy_context');
    expect(payload.sources).toEqual([{ docId: 'doc-1', title: '校园手册' }]);
  });
});
