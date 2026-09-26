import { describe, expect, it, vi } from 'vitest';

const { ConversationOrchestrator } = require('../src/services/conversation/conversation-orchestrator.service');

describe('ConversationOrchestrator', () => {
  it('读取持久记忆并作为 system history 注入 chat 链路', async () => {
    const aiService = {
      getCompletion: vi.fn(async (_message, history) => ({ content: history[1].content, model: 'test' })),
    };
    const memoryService = {
      buildMemoryContext: vi.fn(async () => '[用户信息]\n- major: 软件工程'),
      saveChatMemory: vi.fn(),
    };
    const orchestrator = new ConversationOrchestrator({
      aiService,
      memoryService,
      intentRouter: { route: vi.fn(async () => ({ intent: 'general_chat', route: 'chat', confidence: 1, reason: 'test' })) },
      ragService: {},
      agentService: { enabled: false },
      intentRoutingEnabled: true,
    });

    const result = await orchestrator.chat('你好', [], { userId: 'u1' });
    expect(result.reply).toContain('经用户授权保存的历史信息');
    expect(memoryService.buildMemoryContext).toHaveBeenCalledWith('u1', '你好');
    expect(memoryService.saveChatMemory).toHaveBeenCalledWith('u1', '你好', result.reply);
  });

  it('Agent 决策失败时在同一编排链路降级 RAG', async () => {
    const ragService = {
      async *chatStream() {
        yield { type: 'content', content: 'RAG 回答', done: false };
        yield { type: 'content', content: '', done: true };
      },
    };
    const agentService = {
      enabled: true,
      async *chatStream() {
        yield { type: 'error', error: Object.assign(new Error('agent failed'), { agentShouldFallback: true }) };
      },
    };
    const memoryService = { buildMemoryContext: vi.fn(async () => ''), saveChatMemory: vi.fn() };
    const orchestrator = new ConversationOrchestrator({
      aiService: {},
      ragService,
      agentService,
      memoryService,
      intentRouter: { route: vi.fn(async () => ({ intent: 'complex_task', route: 'agent', confidence: 0.9, reason: 'test' })) },
      intentRoutingEnabled: true,
    });

    const events = [];
    for await (const event of orchestrator.chatStream('制定计划', [], { userId: 'u1' })) events.push(event);
    expect(events.some(event => event.type === 'intent' && event.intent.route === 'rag')).toBe(true);
    expect(events.some(event => event.type === 'content' && event.content === 'RAG 回答')).toBe(true);
    expect(memoryService.saveChatMemory).toHaveBeenCalledWith('u1', '制定计划', 'RAG 回答');
  });

  it('知识库路由在开关启用时进入 Agentic RAG 链路', async () => {
    const agenticRagService = {
      enabled: true,
      chat: vi.fn(async () => ({ reply: 'Agentic 回答', sources: [], model: 'agentic-rag' })),
      async *chatStream() {
        yield { type: 'trace', trace: { traceId: 'agentic-1', rounds: 2 } };
        yield { type: 'content', content: 'Agentic 回答', done: false };
        yield { type: 'content', content: '', done: true };
      },
    };
    const ragService = {
      chat: vi.fn(),
      chatStream: vi.fn(),
    };
    const memoryService = { buildMemoryContext: vi.fn(async () => ''), saveChatMemory: vi.fn() };
    const orchestrator = new ConversationOrchestrator({
      aiService: {},
      ragService,
      agentService: { enabled: false },
      agenticRagService,
      memoryService,
      intentRouter: { route: vi.fn(async () => ({ intent: 'knowledge_query', route: 'rag', confidence: 0.9, reason: 'test' })) },
      intentRoutingEnabled: true,
    });

    const result = await orchestrator.chat('图书馆几点开门', [], { userId: 'u1' });
    expect(result.reply).toBe('Agentic 回答');
    expect(agenticRagService.chat).toHaveBeenCalledOnce();
    expect(ragService.chat).not.toHaveBeenCalled();

    const events = [];
    for await (const event of orchestrator.chatStream('图书馆几点开门', [], { userId: 'u1' })) events.push(event);
    expect(events).toContainEqual(expect.objectContaining({ type: 'trace', channel: 'agentic_rag' }));
    expect(memoryService.saveChatMemory).toHaveBeenCalledWith('u1', '图书馆几点开门', 'Agentic 回答');
  });
});
