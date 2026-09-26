import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 模拟 config（避免读 .env）
vi.mock('../src/config', () => ({
  rag: {
    intentRoutingEnabled: true,
    intentClassifyEnabled: false,
  },
  ai: {
    apiKey: 'test-key',
    baseUrl: 'https://api.test.com/v2',
    model: 'test-model',
    maxTokens: 4000,
    temperature: 0.7,
    timeout: 60000,
  },
  agent: {
    toolEnabled: true,
    decideTimeoutMs: 15000,
    toolTimeoutMs: 15000,
    maxToolRounds: 2,
  },
}));

// 模拟 rag.service / ai.service，避免真实初始化向量库
vi.mock('../src/services/rag/rag.service', () => {
  class FakeRagService {
    async chat(query, history, opts) {
      return {
        reply: `模拟知识库回答（${query}）`,
        sources: [{ title: '测试文档' }],
        isMock: true,
      };
    }
  }
  return { RagService: FakeRagService };
});

vi.mock('../src/services/llm/ai.service', () => {
  class FakeAiService {
    async getCompletion(message, history, opts) {
      return { content: '模拟 LLM 回答', isMock: true, model: 'mock' };
    }
    async *getCompletionStream(message, history) {
      yield { content: '模拟', done: false };
      yield { content: '回答', done: false };
      yield { content: '', done: true };
    }
  }
  return { aiService: new FakeAiService(), AiService: FakeAiService };
});

let registryMod;
let agentTools;
let agentMod;

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of Object.keys(require.cache)) {
    if (k.includes('tool-registry') || k.includes('agent-tools') || k.includes('agent.service')) {
      delete require.cache[k];
    }
  }
  registryMod = require('../src/services/agent/tool-registry.service');
  agentTools = require('../src/services/agent/agent-tools.service');
  agentMod = require('../src/services/agent/agent.service');
});

describe('ToolRegistry（移植自存档版）', () => {
  it('注册/查询/移除工具', () => {
    const { ToolRegistry } = registryMod;
    const reg = new ToolRegistry();
    const handler = vi.fn(async () => 'ok');
    reg.register({ name: 'test_tool', description: 'd', handler });
    expect(reg.getTool('test_tool')).not.toBeNull();
    expect(reg.getToolNames()).toContain('test_tool');
    expect(reg.unregister('test_tool')).toBe(true);
    expect(reg.getTool('test_tool')).toBeNull();
  });

  it('缺少 name/handler 时拒绝注册', () => {
    const { ToolRegistry } = registryMod;
    const reg = new ToolRegistry();
    expect(() => reg.register({ name: 'x' })).toThrow('name 和 handler');
  });

  it('执行工具返回 handler 结果', async () => {
    const { ToolRegistry } = registryMod;
    const reg = new ToolRegistry();
    reg.register({ name: 'echo', handler: async (args) => `echo:${args.v}` });
    expect(await reg.executeTool('echo', { v: 42 })).toBe('echo:42');
  });

  it('未知工具/禁用工具返回语义化提示', async () => {
    const { ToolRegistry } = registryMod;
    const reg = new ToolRegistry();
    reg.register({ name: 't', handler: async () => 'ok' });
    reg.setEnabled('t', false);
    expect(await reg.executeTool('unknown', {})).toContain('未知工具');
    expect(await reg.executeTool('t', {})).toContain('已禁用');
  });

  it('handler 抛错时返回失败信息而非 reject', async () => {
    const { ToolRegistry } = registryMod;
    const reg = new ToolRegistry();
    reg.register({ name: 'boom', handler: async () => { throw new Error('boom!'); } });
    const r = await reg.executeTool('boom', {});
    expect(r).toContain('执行失败');
    expect(r).toContain('boom');
  });

  it('超时返回语义化提示（不 reject）', async () => {
    const { ToolRegistry } = registryMod;
    const reg = new ToolRegistry();
    reg.register({
      name: 'slow',
      timeoutMs: 50,
      handler: async () => { await new Promise(r => setTimeout(r, 500)); return 'late'; },
    });
    const r = await reg.executeTool('slow', {});
    expect(r).toContain('执行超时');
  });

  it('工具响应内部取消信号时仍按超时返回', async () => {
    const { ToolRegistry } = registryMod;
    const reg = new ToolRegistry();
    reg.register({
      name: 'timeout_abortable',
      timeoutMs: 30,
      handler: async (_args, context) => new Promise((resolve, reject) => {
        context.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
      }),
    });
    const result = await reg.executeTool('timeout_abortable', {});
    expect(result).toContain('执行超时');
  });

  it('getToolSchemas 输出 OpenAI function calling 格式', () => {
    const { ToolRegistry } = registryMod;
    const reg = new ToolRegistry();
    reg.register({
      name: 'calc', description: '计算',
      parameters: { type: 'object', properties: { a: { type: 'number' } }, required: ['a'] },
      handler: async () => '0',
    });
    const schemas = reg.getToolSchemas();
    expect(schemas[0].type).toBe('function');
    expect(schemas[0].function.name).toBe('calc');
    expect(schemas[0].function.parameters.properties.a.type).toBe('number');
  });

  it('执行前校验必填参数和类型', async () => {
    const { ToolRegistry } = registryMod;
    const reg = new ToolRegistry();
    const handler = vi.fn(async () => 'ok');
    reg.register({
      name: 'validated',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', maxLength: 5 } },
        required: ['query'],
        additionalProperties: false,
      },
      handler,
    });
    expect((await reg.executeToolDetailed('validated', {})).content).toContain('缺少必填参数');
    expect((await reg.executeToolDetailed('validated', { query: 1 })).content).toContain('必须是字符串');
    expect((await reg.executeToolDetailed('validated', { query: '123456' })).content).toContain('超过最大长度');
    expect(handler).not.toHaveBeenCalled();
  });

  it('父级取消信号会传递给工具 handler', async () => {
    const { ToolRegistry } = registryMod;
    const reg = new ToolRegistry();
    let receivedSignal;
    reg.register({
      name: 'abortable',
      timeoutMs: 1000,
      handler: async (_args, context) => {
        receivedSignal = context.signal;
        await new Promise((resolve, reject) => {
          context.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
        });
      },
    });
    const controller = new AbortController();
    const pending = reg.executeToolDetailed('abortable', {}, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(receivedSignal.aborted).toBe(true);
  });
});

describe('agent-tools（内置工具）', () => {
  it('注册了 search_knowledge_base 与 calculate', () => {
    const names = agentTools.getToolNames();
    expect(names).toContain('search_knowledge_base');
    expect(names).toContain('calculate');
  });

  it('search_knowledge_base 工具契约：返回字符串且不抛错（走真实 rag 链路，CJS mock 不生效）', async () => {
    // ⚠️ CLAUDE.md 记录的坑：vitest 4 中 vi.mock 对 CJS require 链不生效，
    // 此处执行的是真实 rag.service（本地向量库）。测试只锁定工具契约：
    // 输出为字符串、以"检索结果/知识库检索失败"开头（不抛错、可降级）。
    const r = await agentTools.executeTool('search_knowledge_base', { query: '食堂几点关门' });
    expect(typeof r).toBe('string');
    expect(r.length).toBeGreaterThan(0);
    expect(/^(检索结果|知识库检索失败|工具.*超时)/.test(r)).toBe(true);
  });

  it('calculate 用 mathjs 安全求值', async () => {
    expect(await agentTools.executeTool('calculate', { expression: '2+3*4' })).toBe('2+3*4 = 14');
    expect(await agentTools.executeTool('calculate', { expression: 'sqrt(16)' })).toBe('sqrt(16) = 4');
  });

  it('calculate 对非法表达式返回失败信息（不抛错）', async () => {
    const r = await agentTools.executeTool('calculate', { expression: '1/0+??' });
    expect(r).toContain('计算失败');
  });

  it('executeToolDetailed 返回结构化 { ok, content }（替代中文正则猜成败）', async () => {
    const ok = await agentTools.executeToolDetailed('calculate', { expression: '2+2' });
    expect(ok.ok).toBe(true);
    expect(ok.content).toBe('2+2 = 4');

    const fail = await agentTools.executeToolDetailed('calculate', { expression: '1/0+??' });
    expect(fail.ok).toBe(false);
    expect(fail.content).toContain('计算失败');

    const unknown = await agentTools.executeToolDetailed('not_exist', {});
    expect(unknown.ok).toBe(false);
    expect(unknown.content).toContain('未知工具');
  });

  it('search_knowledge_base 仅检索不生成（retrieveOnly，避免双重生成）', async () => {
    // 走真实 rag 链路（CJS mock 不生效），契约：content 以"检索结果/检索失败/超时"开头
    const r = await agentTools.executeToolDetailed('search_knowledge_base', { query: '食堂几点关门' });
    expect(typeof r.content).toBe('string');
    expect(/^(检索结果|知识库检索失败|工具.*超时)/.test(r.content)).toBe(true);
    // 命中时 data.sources 为数组（结构化透传给 agent → 前端引用展示）
    if (r.content.startsWith('检索结果：\n')) {
      expect(Array.isArray(r.data?.sources)).toBe(true);
      expect(r.uiSummary).toContain('知识库检索完成');
    }
  });
});

describe('AgentService（单轮工具调度，原生 function calling）', () => {
  it('decide：LLM 返回原生 toolCalls 时解析', async () => {
    const fakeAi = {
      getCompletion: async () => ({
        content: '',
        toolCalls: [{ id: 'call_1', type: 'function', function: { name: 'search_knowledge_base', arguments: '{"query":"食堂"}' } }],
        isMock: false,
      }),
    };
    const svc = new agentMod.AgentService(fakeAi);
    const d = await svc.decide('食堂几点关门');
    expect(d.toolCalls).toHaveLength(1);
    expect(d.toolCalls[0].function.name).toBe('search_knowledge_base');
    expect(JSON.parse(d.toolCalls[0].function.arguments)).toEqual({ query: '食堂' });
  });

  it('decide：无 toolCalls 时直接回答', async () => {
    const fakeAi = {
      getCompletion: async () => ({ content: '你好呀', toolCalls: null, isMock: false }),
    };
    const svc = new agentMod.AgentService(fakeAi);
    const d = await svc.decide('你好呀');
    expect(d.toolCalls).toBeNull();
    expect(d.content).toBe('你好呀');
  });

  it('decide：多工具调用（parallel）时全部保留', async () => {
    const fakeAi = {
      getCompletion: async () => ({
        content: '',
        toolCalls: [
          { id: 'a', function: { name: 'calculate', arguments: '{"expression":"2+2"}' } },
          { id: 'b', function: { name: 'calculate', arguments: '{"expression":"3+3"}' } },
        ],
        isMock: false,
      }),
    };
    const svc = new agentMod.AgentService(fakeAi);
    const d = await svc.decide('算两个数');
    expect(d.toolCalls).toHaveLength(2);
  });

  it('chatStream：原生决策 → 工具执行 → 结果回注生成（事件齐全）', async () => {
    const fakeAi = {
      async *getCompletionStream(message, history, opts) {
        // 第一次调用（带 tools）：返回 tool_calls
        if (opts.tools && opts.tools.length > 0) {
          yield { content: '', done: true, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'calculate', arguments: '{"expression":"2+2"}' } }] };
          return;
        }
        // 第二次调用（工具结果回注）：返回最终答案
        yield { content: '计算结果是 4', done: false };
        yield { content: '', done: true };
      },
    };
    const svc = new agentMod.AgentService(fakeAi);
    const events = [];
    for await (const ev of svc.chatStream('2+2等于多少', [])) {
      events.push(ev);
    }
    const types = events.map(e => e.type);
    expect(types).toContain('tool_call');
    expect(types).toContain('tool_result');
    expect(types).toContain('content');
    const toolCall = events.find(e => e.type === 'tool_call');
    expect(toolCall.tool_call.name).toBe('calculate');
    expect(toolCall.tool_call.arguments).toEqual({ expression: '2+2' });
    const toolResult = events.find(e => e.type === 'tool_result');
    expect(toolResult.tool_result.content).toContain('= 4');
    const content = events.filter(e => e.type === 'content' && e.content !== '' && e.content !== undefined);
    expect(content.some(c => c.content === '计算结果是 4')).toBe(true);
    const done = events.find(e => e.type === 'content' && (e.content === '' || e.done === true) && e.content !== '计算结果是 4');
    expect(done).toBeTruthy();
  });

  it('chatStream：大工具结果先落盘再在 tool_result 事件提供 artifact 元数据', async () => {
    const config = require('../src/config');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-artifact-e2e-'));
    const previous = {
      enabled: config.agent.contextCompactionEnabled,
      threshold: config.agent.toolResultSpillThreshold,
      spillDir: config.agent.toolSpillDir,
    };
    config.agent.contextCompactionEnabled = true;
    config.agent.toolResultSpillThreshold = 10;
    config.agent.toolSpillDir = tmpDir;

    try {
      const fakeAi = {
        async *getCompletionStream(message, history, opts) {
          if (opts.tools && !opts.messages?.some((item) => item.role === 'tool')) {
            yield { content: '', done: true, tool_calls: [{ id: 'artifact-call', function: { name: 'calculate', arguments: '{"expression":"2+2"}' } }] };
            return;
          }
          const hasReadCall = opts.messages?.some((item) => item.role === 'assistant'
            && item.tool_calls?.some((call) => call.function?.name === 'read_tool_artifact'));
          if (opts.tools && !hasReadCall) {
            const previousTool = opts.messages?.find((item) => item.role === 'tool' && String(item.content).includes('已保存至工件'));
            const artifactId = String(previousTool?.content || '').match(/工件 (spill_[a-zA-Z0-9_-]+)/)?.[1];
            yield { content: '', done: true, tool_calls: [{ id: 'read-call', function: { name: 'read_tool_artifact', arguments: JSON.stringify({ artifactId }) } }] };
            return;
          }
          yield { content: '已读取工具结果', done: false };
          yield { content: '', done: true };
        },
      };
      const svc = new agentMod.AgentService(fakeAi);
      svc.runTool = vi.fn(async (name, args, context) => {
        if (name === 'calculate') {
          return {
            ok: true,
            content: '大型工具结果'.repeat(20),
            uiSummary: '工具结果已生成',
          };
        }
        return agentTools.executeToolDetailed(name, args, context);
      });

      const events = [];
      for await (const event of svc.chatStream('读取大结果', [], {
        userId: 'user-artifact',
        conversationId: 'conv-artifact',
      })) events.push(event);

      const toolResults = events.filter((event) => event.type === 'tool_result').map((event) => event.tool_result);
      const toolResult = toolResults[0];
      expect(toolResults).toHaveLength(2);
      expect(svc.runTool).toHaveBeenCalledTimes(2);
      expect(toolResults[1]).toMatchObject({
        artifactId: expect.stringMatching(/^spill_/),
        offset: 0,
        hasMore: expect.any(Boolean),
      });
      expect(toolResult).toMatchObject({
        spilled: true,
        artifactId: expect.stringMatching(/^spill_/),
        totalChars: '大型工具结果'.repeat(20).length,
        offset: 0,
        hasMore: true,
      });
      expect(fs.readdirSync(tmpDir).some((name) => name.endsWith('.md'))).toBe(true);
    } finally {
      config.agent.contextCompactionEnabled = previous.enabled;
      config.agent.toolResultSpillThreshold = previous.threshold;
      config.agent.toolSpillDir = previous.spillDir;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('chatStream：LLM 未调工具（直接回答）时实时透传 decision 内容', async () => {
    const fakeAi = {
      async *getCompletionStream(message, history, opts) {
        yield { content: '直接回答，不需要工具', done: false };
        yield { content: '', done: true, tool_calls: null };
      },
    };
    const svc = new agentMod.AgentService(fakeAi);
    const events = [];
    for await (const ev of svc.chatStream('随便聊聊', [])) {
      events.push(ev);
    }
    const contents = events.filter(e => e.type === 'content').map(e => e.content).join('');
    expect(contents).toContain('直接回答，不需要工具');
    // 决策阶段内容实时透传且带 decision 标记（前端据此渲染到思考草稿区）
    const decisionChunks = events.filter(e => e.type === 'content' && e.decision === true);
    expect(decisionChunks.length).toBeGreaterThan(0);
    expect(decisionChunks.map(c => c.content).join('')).toContain('直接回答，不需要工具');
    // 直答内容只透传一次：不再有"整段重发"的重复 content 事件
    expect(events.filter(e => e.type === 'content' && e.content === '直接回答，不需要工具')).toHaveLength(1);
    // 未调工具 → 无 tool_call/tool_result 事件
    expect(events.some(e => e.type === 'tool_call' && e.tool_call.name !== 'direct')).toBe(false);
  });

  it('chatStream：决策文本 + tool_calls 时草稿被工具调用取代（不重复下发）', async () => {
    const fakeAi = {
      async *getCompletionStream(message, history, opts) {
        if (opts.tools && opts.tools.length > 0) {
          // 决策阶段先输出文本（草稿），再发起工具调用
          yield { content: '让我先搜索一下', done: false };
          yield { content: '', done: true, tool_calls: [{ id: 's1', function: { name: 'search_knowledge_base', arguments: '{"query":"图书馆"}' } }] };
          return;
        }
        yield { content: '最终回答', done: false };
        yield { content: '', done: true };
      },
    };
    const svc = new agentMod.AgentService(fakeAi);
    const events = [];
    for await (const ev of svc.chatStream('图书馆几点开门', [])) {
      events.push(ev);
    }
    // 草稿文本以 decision 标记透传过（前端先渲染到草稿区）
    expect(events.some(e => e.type === 'content' && e.decision === true && e.content === '让我先搜索一下')).toBe(true);
    // 非流式 drain（chat()）的 reply 不应包含被废弃的草稿
    const reply = await svc.chat('图书馆几点开门', []);
    expect(reply.reply).toBe('最终回答');
  });

  it('chatStream：两轮工具调用（第 1 轮工具 → 第 2 轮再决策）', async () => {
    const fakeAi = {
      async *getCompletionStream(message, history, opts) {
        // 带 tools 的调用是"决策轮"；不带 tools 是"收尾生成"
        if (opts.tools && opts.tools.length > 0) {
          // 轮次判断依据：opts.messages 中是否已含 tool 角色消息（chatStream 的 history 参数恒为 []）
          const hasToolResult = opts.messages?.some((m) => m.role === 'tool');
          if (!hasToolResult) {
            // 第 1 轮决策：调 calculate
            yield { content: '', done: true, tool_calls: [{ id: 'r1', function: { name: 'calculate', arguments: '{"expression":"2+2"}' } }] };
          } else {
            // 第 2 轮决策（已含工具结果）：直接回答
            yield { content: '第一轮结果已获得', done: true, tool_calls: null };
          }
          return;
        }
        yield { content: '最终答案', done: false };
        yield { content: '', done: true };
      },
    };
    const svc = new agentMod.AgentService(fakeAi);
    const events = [];
    for await (const ev of svc.chatStream('算一下', [])) {
      events.push(ev);
    }
    const types = events.map(e => e.type);
    expect(types.filter(t => t === 'tool_call').length).toBeGreaterThanOrEqual(1);
    expect(types).toContain('tool_result');
    expect(types).toContain('trace');
    const trace = events.find(e => e.type === 'trace');
    expect(trace.trace.finishReason).toBe('direct_answer');
    expect(trace.trace.toolCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('chatStream：连续相同工具调用 → 无进展检测强制收尾', async () => {
    let calls = 0;
    const fakeAi = {
      async *getCompletionStream(message, history, opts) {
        calls++;
        if (opts.tools && opts.tools.length > 0) {
          // 每次决策都返回同一个工具调用（模拟死循环）
          yield { content: '', done: true, tool_calls: [{ id: `r${calls}`, function: { name: 'calculate', arguments: '{"expression":"1+1"}' } }] };
          return;
        }
        yield { content: '收尾回答', done: false };
        yield { content: '', done: true };
      },
    };
    const svc = new agentMod.AgentService(fakeAi);
    const events = [];
    for await (const ev of svc.chatStream('1+1', [])) {
      events.push(ev);
    }
    const trace = events.find(e => e.type === 'trace');
    expect(trace.trace.finishReason).toBe('no_progress');
    // 决策轮次应被限制（2 轮 + 收尾生成，不会无限循环）
    expect(calls).toBeLessThan(6);
  });

  it('chatStream：达到最大轮次 → round_limit 收尾', async () => {
    let round = 0;
    const fakeAi = {
      async *getCompletionStream(message, history, opts) {
        if (opts.tools && opts.tools.length > 0) {
          round++;
          // 每轮都调不同参数的工具，但始终不直接回答
          yield { content: '', done: true, tool_calls: [{ id: `r${round}`, function: { name: 'calculate', arguments: `{"expression":"${round}+1"}` } }] };
          return;
        }
        yield { content: '轮次用尽后的收尾', done: false };
        yield { content: '', done: true };
      },
    };
    const svc = new agentMod.AgentService(fakeAi);
    const events = [];
    for await (const ev of svc.chatStream('多步计算', [])) {
      events.push(ev);
    }
    const trace = events.find(e => e.type === 'trace');
    expect(trace.trace.finishReason).toBe('round_limit');
    // 默认 maxToolRounds=2，应只决策 2 轮
    expect(round).toBe(2);
  });
});

describe('AgentService 会话记忆（L3）', () => {
  it('buildMemorySummary：提取最近提问主题与上一轮回答结论', () => {
    const history = [
      { role: 'user', content: '高数极限怎么求' },
      { role: 'assistant', content: '用洛必达法则，步骤是……' },
      { role: 'user', content: '那道题再讲讲' },
    ];
    const summary = agentMod.buildMemorySummary(history);
    expect(summary).toContain('最近提问');
    // 最近提问 = 最后一条用户消息（"那道题再讲讲"），而非更早的
    expect(summary).toContain('那道题再讲讲');
    expect(summary).toContain('上一轮回答结论');
    expect(summary).toContain('洛必达');
  });

  it('buildMemorySummary：空历史返回 null', () => {
    expect(agentMod.buildMemorySummary([])).toBeNull();
    expect(agentMod.buildMemorySummary(null)).toBeNull();
  });

  it('buildDecisionMessages：注入会话记忆到 system prompt', () => {
    const history = [
      { role: 'user', content: '帮我算 2+2' },
      { role: 'assistant', content: '结果是 4' },
    ];
    const messages = agentMod.buildDecisionMessages('那道题呢', history);
    const system = messages.find(m => m.role === 'system').content;
    expect(system).toContain('此前对话的摘要');
    expect(system).toContain('结果是 4');
    // history 原样保留 + 当前问题在末尾
    expect(messages.filter(m => m.role === 'user').length).toBeGreaterThanOrEqual(2);
  });

  it('buildDecisionMessages：不再注入 JSON schema（schema 由 API tools 参数携带）', () => {
    const messages = agentMod.buildDecisionMessages('你好', []);
    const system = messages.find(m => m.role === 'system').content;
    // 只含工具名+简述，不含 JSON schema 结构（省 token）
    expect(system).toContain('search_knowledge_base');
    expect(system).not.toContain('"parameters"');
    expect(system).not.toContain('{tool_list}');
  });
});

describe('AgentService 2026-08-15 优化', () => {
  it('stableStringify：key 顺序无关（无进展检测签名不被绕过）', () => {
    const a = agentMod.stableStringify({ query: '食堂', category: '学校概况' });
    const b = agentMod.stableStringify({ category: '学校概况', query: '食堂' });
    expect(a).toBe(b);
    expect(agentMod.stableStringify({ list: [1, { b: 2, a: 1 }] })).toBe('{"list":[1,{"a":1,"b":2}]}');
  });

  it('chat()：drain chatStream，返回 reply + 工具名 + sources', async () => {
    const fakeAi = {
      async *getCompletionStream(message, history, opts) {
        if (opts.tools && opts.tools.length > 0) {
          // 已含工具结果回注（tool 角色消息）→ 直接流出最终答案，不再调工具
          const hasToolResult = opts.messages?.some((m) => m.role === 'tool');
          if (!hasToolResult) {
            yield { content: '', done: true, tool_calls: [{ id: 'c1', function: { name: 'calculate', arguments: '{"expression":"2+2"}' } }] };
          } else {
            yield { content: '计算结果是 4', done: false };
            yield { content: '', done: true, tool_calls: null };
          }
          return;
        }
        yield { content: '计算结果是 4', done: false };
        yield { content: '', done: true };
      },
    };
    const svc = new agentMod.AgentService(fakeAi);
    const result = await svc.chat('2+2等于多少', []);
    expect(result.reply).toBe('计算结果是 4');
    expect(result.tool.name).toBe('calculate');
    expect(Array.isArray(result.sources)).toBe(true);
    expect(result.trace?.toolCalls?.[0]?.ok).toBe(true);
    // 单工具耗时为独立计时（非累计）
    expect(result.trace.toolCalls[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it('chatStream：决策失败且未输出内容 → error 事件（AgentDecisionError，控制器降级 RAG）', async () => {
    const fakeAi = {
      async *getCompletionStream() {
        throw new Error('上游 429');
      },
    };
    const svc = new agentMod.AgentService(fakeAi);
    const events = [];
    for await (const ev of svc.chatStream('食堂几点关门', [])) {
      events.push(ev);
    }
    const errEvent = events.find(e => e.type === 'error');
    expect(errEvent).toBeTruthy();
    expect(errEvent.error.agentShouldFallback).toBe(true);
    // 不应输出误导性兜底文案
    expect(events.some(e => e.type === 'content' && String(e.content).includes('没有理解'))).toBe(false);
  });

  it('chat()：决策失败时抛出 AgentDecisionError（非流式降级入口）', async () => {
    const fakeAi = {
      async *getCompletionStream() {
        throw new Error('上游 500');
      },
    };
    const svc = new agentMod.AgentService(fakeAi);
    await expect(svc.chat('图书馆怎么借书', [])).rejects.toMatchObject({ agentShouldFallback: true });
  });

  it('chatStream：知识库工具命中时透传 sources 事件', async () => {
    const fakeAi = {
      async *getCompletionStream(message, history, opts) {
        if (opts.tools && opts.tools.length > 0) {
          yield { content: '', done: true, tool_calls: [{ id: 's1', function: { name: 'search_knowledge_base', arguments: '{"query":"食堂"}' } }] };
          return;
        }
        yield { content: '食堂 21 点关门', done: false };
        yield { content: '', done: true };
      },
    };
    const svc = new agentMod.AgentService(fakeAi);
    const events = [];
    for await (const ev of svc.chatStream('食堂几点关门', [])) {
      events.push(ev);
    }
    const sourcesEvent = events.find(e => e.type === 'sources');
    // 走真实 rag 链路：只要检索命中就应有 sources 事件（未命中则无，两种都合法）
    if (sourcesEvent) {
      expect(Array.isArray(sourcesEvent.sources)).toBe(true);
      expect(sourcesEvent.sources.length).toBeGreaterThan(0);
    }
    // trace 中工具调用 ok 字段来自结构化返回（非中文正则）
    const trace = events.find(e => e.type === 'trace');
    expect(typeof trace.trace.toolCalls[0].ok).toBe('boolean');
  });
});
