import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/services/conversation-orchestrator.service', () => ({
  ConversationOrchestrator: class ConversationOrchestrator {
    async *chatStream() {}
  },
}));

function getStreamHandler() {
  delete require.cache[require.resolve('../src/controllers/chat.controller')];
  return require('../src/controllers/chat.controller').streamHandler;
}

function getWriteStreamEvent() {
  delete require.cache[require.resolve('../src/controllers/chat.controller')];
  return require('../src/controllers/chat.controller').writeStreamEvent;
}

describe('chat.controller streamHandler', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('SSE 响应头发送失败时将原始错误交给 next', async () => {
    const expectedError = new Error('flush failed');
    const response = {
      headersSent: false,
      setHeader: vi.fn(),
      flushHeaders: vi.fn(() => { throw expectedError; }),
      removeListener: vi.fn(),
      write: vi.fn(),
      end: vi.fn(),
    };
    const next = vi.fn();

    await getStreamHandler()(
      { body: { message: '请介绍学校图书馆', history: [] }, userId: 'u1' },
      response,
      next,
    );

    expect(next).toHaveBeenCalledOnce();
    expect(next).toHaveBeenCalledWith(expectedError);
    expect(response.write).not.toHaveBeenCalled();
  });

  it('将 Agentic RAG trace 映射为独立 SSE 字段', () => {
    const response = { write: vi.fn() };

    getWriteStreamEvent()(response, {
      type: 'trace',
      channel: 'agentic_rag',
      trace: {
        traceId: 'agentic-1',
        rounds: 2,
        queries: ['原问题', '改写问题'],
        matchedDocs: 3,
        finishReason: 'evidence_found',
      },
    }, 'fallback-trace');

    const payload = JSON.parse(response.write.mock.calls[0][0].slice(6));
    expect(payload.traceId).toBe('agentic-1');
    expect(payload.agenticRag).toEqual(expect.objectContaining({
      rounds: 2,
      queries: ['原问题', '改写问题'],
      matchedDocs: 3,
      finishReason: 'evidence_found',
    }));
  });

  it('协商 v1 时输出唯一的 RunEvent 生命周期', async () => {
    const events = [];
    const response = {
      headersSent: true,
      setHeader: vi.fn(),
      flushHeaders: vi.fn(),
      on: vi.fn(),
      removeListener: vi.fn(),
      write: vi.fn((line) => events.push(JSON.parse(line.slice(6)))),
      end: vi.fn(),
    };
    const orchestrator = {
      async *chatStream() {
        yield { type: 'content', content: '统一事件', done: false };
        yield { type: 'content', content: '', done: true };
      },
    };
    const { createChatHandlers } = require('../src/controllers/chat.controller');

    await createChatHandlers(orchestrator).streamHandler({
      body: {
        message: '测试 RunEvent',
        history: [],
        conversationId: 'conv_v1',
        streamVersion: 1,
        runId: 'run_client_v1',
        attempt: 0,
      },
      traceId: 'trace_v1',
      userId: 'u1',
    }, response, vi.fn());

    expect(events.map((event) => event.type)).toEqual([
      'run.started',
      'message.delta',
      'run.completed',
    ]);
    expect(events.map((event) => event.seq)).toEqual([1, 2, 3]);
    expect(events.every((event) => event.runId === 'run_client_v1')).toBe(true);
    expect(events[1].data).toEqual({ content: '统一事件', decision: false });
    expect(response.end).toHaveBeenCalledOnce();
  });

  it('上游提前 EOF 时输出 run.failed 而不是 run.completed', async () => {
    const events = [];
    const response = {
      headersSent: true,
      setHeader: vi.fn(),
      flushHeaders: vi.fn(),
      on: vi.fn(),
      removeListener: vi.fn(),
      write: vi.fn((line) => events.push(JSON.parse(line.slice(6)))),
      end: vi.fn(),
    };
    const incomplete = Object.assign(new Error('上游流在终态前提前结束'), {
      code: 'INCOMPLETE_STREAM',
      name: 'IncompleteStreamError',
    });
    const orchestrator = {
      async *chatStream() {
        yield { type: 'content', content: '半截', done: false };
        throw incomplete;
      },
    };

    await require('../src/controllers/chat.controller').createChatHandlers(orchestrator).streamHandler({
      body: {
        message: '测试提前 EOF',
        history: [],
        streamVersion: 1,
        runId: 'run_client_eof',
        attempt: 0,
      },
      traceId: 'trace_eof',
      userId: 'u1',
    }, response, vi.fn());

    expect(events.map((event) => event.type)).toEqual([
      'run.started',
      'message.delta',
      'run.failed',
    ]);
    expect(events.at(-1).data).toMatchObject({ code: 'INCOMPLETE_STREAM' });
    expect(response.end).toHaveBeenCalledOnce();
  });
});
