import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/config', () => ({
  agenticRag: {
    enabled: false,
    maxRounds: 2,
    maxDurationMs: 20000,
    rewriteTimeoutMs: 8000,
    minSources: 1,
  },
}));

const { AgenticRagService } = require('../src/services/agent/agentic-rag.service');

async function collect(stream) {
  const events = [];
  for await (const event of stream) events.push(event);
  return events;
}

function createRagService(searchResults) {
  let searchIndex = 0;
  return {
    localSearchChat: vi.fn(async () => searchResults[Math.min(searchIndex++, searchResults.length - 1)]),
    isProcessQuestion: vi.fn(() => false),
    buildParentChildPrompt: vi.fn((question, context) => `${question}\n${context}`),
    buildProcessPrompt: vi.fn((question, context) => `${question}\n${context}`),
    parseProcessCard: vi.fn(() => null),
    async *chatStream() {
      yield { type: 'content', content: '传统 RAG 降级回答', done: false };
      yield { type: 'content', content: '', done: true };
    },
  };
}

function createAiService(rewrite = null) {
  return {
    getCompletion: vi.fn(async () => ({ content: rewrite || '' })),
    getCompletionStream: vi.fn(async function* getCompletionStream() {
      yield { content: 'Agentic RAG 回答', done: false };
      yield { content: '', done: true };
    }),
  };
}

describe('AgenticRagService', () => {
  it('首轮证据充分时直接生成回答，不调用查询改写', async () => {
    const ragService = createRagService([{
      context: '图书馆开放时间为测试内容',
      sources: [{ docId: 'doc-1', title: '图书馆指南' }],
    }]);
    const aiService = createAiService();
    const service = new AgenticRagService({ aiService, ragService, enabled: true, maxRounds: 2 });

    const events = await collect(service.chatStream('图书馆几点开门', [], { traceId: 'trace-1' }));

    expect(ragService.localSearchChat).toHaveBeenCalledOnce();
    expect(aiService.getCompletion).not.toHaveBeenCalled();
    expect(events).toContainEqual(expect.objectContaining({ type: 'sources' }));
    expect(events).toContainEqual({ type: 'content', content: 'Agentic RAG 回答', done: false });
    expect(events).toContainEqual(expect.objectContaining({
      type: 'trace',
      channel: 'agentic_rag',
      trace: expect.objectContaining({ rounds: 1, finishReason: 'evidence_found' }),
    }));
  });

  it('首轮证据不足时改写查询并执行第二轮检索', async () => {
    const ragService = createRagService([
      { context: '', sources: [] },
      { context: '奖学金申请条件测试内容', sources: [{ docId: 'doc-2', title: '奖学金办法' }] },
    ]);
    const aiService = createAiService('{"query":"武汉理工大学奖学金申请条件及流程","reason":"补充学校和正式文档术语"}');
    const service = new AgenticRagService({ aiService, ragService, enabled: true, maxRounds: 2 });

    const events = await collect(service.chatStream('奖学金怎么弄', [], { traceId: 'trace-2' }));

    expect(ragService.localSearchChat).toHaveBeenCalledTimes(2);
    expect(ragService.localSearchChat.mock.calls[1][0]).toBe('武汉理工大学奖学金申请条件及流程');
    expect(events).toContainEqual(expect.objectContaining({
      type: 'tool_result',
      tool_result: expect.objectContaining({ name: 'rewrite_knowledge_query' }),
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: 'trace',
      trace: expect.objectContaining({ rounds: 2, finishReason: 'evidence_found' }),
    }));
  });

  it('多轮后仍无证据时回退现有 RAG 流程', async () => {
    const ragService = createRagService([{ context: '', sources: [] }]);
    const aiService = createAiService();
    const service = new AgenticRagService({ aiService, ragService, enabled: true, maxRounds: 1 });

    const events = await collect(service.chatStream('未知校园问题', [], { traceId: 'trace-3' }));

    expect(events).toContainEqual(expect.objectContaining({
      type: 'trace',
      channel: 'agentic_rag',
      trace: expect.objectContaining({ finishReason: 'round_limit', fallbackReason: 'round_limit' }),
    }));
    expect(events).toContainEqual({ type: 'content', content: '传统 RAG 降级回答', done: false });
  });
});
