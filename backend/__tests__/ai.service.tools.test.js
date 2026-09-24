import { describe, it, expect, vi } from 'vitest';

// 模拟 config（避免读 .env / 构造 AiService 时的真实依赖）
vi.mock('../src/config', () => ({
  ai: {
    apiKey: 'test-key',
    baseUrl: 'https://api.test.com/v1',
    model: 'test-model',
    maxTokens: 4000,
    temperature: 0.7,
    timeout: 60000,
    fallback: null,
  },
}));

const { AiService } = require('../src/services/ai.service');

// 用 Object.create 拿到原型方法，避免构造器副作用（judgeService 等）
function makeService() {
  return Object.create(AiService.prototype);
}

/** 构造一个假的 SSE 响应（可异步迭代） */
function makeFakeRes(events) {
  return {
    statusCode: 200,
    [Symbol.asyncIterator]: async function* () {
      for (const e of events) yield Buffer.from(e);
    },
  };
}

const provider = { anthropicMode: false, model: 'test-model' };

describe('AiService._parseStream 原生 function calling', () => {
  it('无 tools 参数时 tool_calls 为 null（向后兼容）', async () => {
    const svc = makeService();
    const res = makeFakeRes([
      'data: {"choices":[{"delta":{"content":"你好"}}]}\n\n',
      'data: [DONE]\n\n',
    ]);
    const chunks = [];
    for await (const c of svc._parseStream(res, provider, {})) chunks.push(c);
    expect(chunks[0].content).toBe('你好');
    const done = chunks[chunks.length - 1];
    expect(done.done).toBe(true);
    expect(done.tool_calls).toBeNull();
  });

  it('上游提前 EOF 且没有 [DONE] 时拒绝为不完整流', async () => {
    const svc = makeService();
    const res = makeFakeRes([
      'data: {"choices":[{"delta":{"content":"半截回答"}}]}\n\n',
    ]);
    const consume = async () => {
      const chunks = [];
      for await (const chunk of svc._parseStream(res, provider, {})) chunks.push(chunk);
      return chunks;
    };

    await expect(consume()).rejects.toMatchObject({
      name: 'IncompleteStreamError',
      code: 'INCOMPLETE_STREAM',
      retryable: true,
    });
  });

  it('处理切开的 UTF-8 字节、JSON 和无换行尾部 [DONE]', async () => {
    const svc = makeService();
    const payload = Buffer.from('data: {"choices":[{"delta":{"content":"武汉"}}]}\n\ndata: [DONE]', 'utf8');
    const splitAt = payload.indexOf(Buffer.from('汉', 'utf8')) + 1;
    const res = makeFakeRes([payload.subarray(0, splitAt), payload.subarray(splitAt, splitAt + 1), payload.subarray(splitAt + 1)]);
    const chunks = [];
    for await (const chunk of svc._parseStream(res, provider, {})) chunks.push(chunk);

    expect(chunks.map((chunk) => chunk.content).join('')).toBe('武汉');
    expect(chunks.at(-1)).toMatchObject({ done: true });
  });

  it('增量拼接 delta.tool_calls（跨分片 name/arguments）', async () => {
    const svc = makeService();
    const res = makeFakeRes([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"search_knowledge_base","arguments":""}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"query\\":\\"食"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"堂几点关门\\"}"}}]}}]}\n\n',
      'data: [DONE]\n\n',
    ]);
    const chunks = [];
    for await (const c of svc._parseStream(res, provider, { tools: [{ type: 'function' }] })) chunks.push(c);
    const done = chunks[chunks.length - 1];
    expect(done.done).toBe(true);
    expect(done.tool_calls).toHaveLength(1);
    expect(done.tool_calls[0].function.name).toBe('search_knowledge_base');
    expect(JSON.parse(done.tool_calls[0].function.arguments)).toEqual({ query: '食堂几点关门' });
  });

  it('多 index 工具调用按 index 排序', async () => {
    const svc = makeService();
    const res = makeFakeRes([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"b","function":{"name":"calculate","arguments":"{\\"expression\\":\\"2+2\\"}"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"a","function":{"name":"search_knowledge_base","arguments":"{\\"query\\":\\"x\\"}"}}]}}]}\n\n',
      'data: [DONE]\n\n',
    ]);
    const chunks = [];
    for await (const c of svc._parseStream(res, provider, { tools: [{}, {}] })) chunks.push(c);
    const tcs = chunks[chunks.length - 1].tool_calls;
    expect(tcs.map((t) => t.function.name)).toEqual(['search_knowledge_base', 'calculate']);
  });

  it('arguments 残缺（JSON 不完整）降级为空参数', async () => {
    const svc = makeService();
    const res = makeFakeRes([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c","function":{"name":"calculate","arguments":"{\\"expr"}}]}}]}\n\n',
      'data: [DONE]\n\n',
    ]);
    const chunks = [];
    for await (const c of svc._parseStream(res, provider, { tools: [{}] })) chunks.push(c);
    const tcs = chunks[chunks.length - 1].tool_calls;
    expect(tcs).toHaveLength(1);
    expect(tcs[0].function.arguments).toBe('{}');
  });
});

describe('RequestQueue 背压与取消', () => {
  it('排队中的请求可被 AbortSignal 移除，不占用 pending', async () => {
    const { RequestQueue } = require('../src/services/ai.service');
    const queue = new RequestQueue(1, { maxPending: 2, waitTimeoutMs: 1000 });
    const release = await queue.acquire();
    const controller = new AbortController();
    const waiting = queue.acquire(controller.signal);

    expect(queue.pending).toBe(1);
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError', code: 'CLIENT_ABORTED' });
    expect(queue.pending).toBe(0);
    release();
    expect(queue.running).toBe(0);
  });

  it('超过等待上限返回可重试的 503 错误', async () => {
    const { RequestQueue } = require('../src/services/ai.service');
    const queue = new RequestQueue(1, { maxPending: 1, waitTimeoutMs: 1000 });
    const release = await queue.acquire();
    const waiting = queue.acquire();

    await expect(queue.acquire()).rejects.toMatchObject({
      code: 'LLM_QUEUE_FULL',
      statusCode: 503,
      retryable: true,
    });
    release();
    const secondRelease = await waiting;
    secondRelease();
  });

  it('排队超时后释放 waiter，不留下悬挂队列', async () => {
    const { RequestQueue } = require('../src/services/ai.service');
    const queue = new RequestQueue(1, { maxPending: 1, waitTimeoutMs: 10 });
    const release = await queue.acquire();

    await expect(queue.acquire()).rejects.toMatchObject({
      code: 'LLM_QUEUE_TIMEOUT',
      statusCode: 503,
    });
    expect(queue.pending).toBe(0);
    release();
  });
});

describe('AiService._assembleToolCalls', () => {
  it('name 为空的调用被丢弃', () => {
    const svc = makeService();
    const map = new Map([
      [0, { id: 'x', name: '', arguments: '{}' }],
      [1, { id: 'y', name: 'calculate', arguments: '{"expression":"1+1"}' }],
    ]);
    const tcs = svc._assembleToolCalls(map, true, true);
    expect(tcs).toHaveLength(1);
    expect(tcs[0].function.name).toBe('calculate');
  });

  it('未启用 tools / 无调用时返回 null', () => {
    const svc = makeService();
    expect(svc._assembleToolCalls(new Map(), true, false)).toBeNull();
    expect(svc._assembleToolCalls(new Map(), false, true)).toBeNull();
  });
});

describe('AiService._buildStreamPayload', () => {
  it('OpenAI 兼容流式请求显式要求返回 usage', () => {
    const svc = makeService();
    svc._buildMessages = vi.fn().mockReturnValue([{ role: 'user', content: '你好' }]);
    const payload = svc._buildStreamPayload({
      anthropicMode: false,
      baseUrl: 'https://api.stepfun.com/v1',
      model: 'test-model',
      maxTokens: 1000,
      temperature: 0.2,
      enableThinking: false,
    }, '你好', [], {});

    expect(payload.stream_options).toEqual({ include_usage: true });
  });

  it('Anthropic 请求不携带 OpenAI stream_options', () => {
    const svc = makeService();
    svc._buildMessages = vi.fn().mockReturnValue([{ role: 'user', content: '你好' }]);
    const payload = svc._buildStreamPayload({
      anthropicMode: true,
      baseUrl: 'https://api.example.com/anthropic',
      model: 'claude-test',
      maxTokens: 1000,
      temperature: 0.2,
    }, '你好', [], {});

    expect(payload).not.toHaveProperty('stream_options');
  });
});

describe('AiService history compaction', () => {
  it('长对话压缩时保留 system 记忆消息', async () => {
    const svc = makeService();
    svc.judgeService = { summarize: async () => '早期摘要' };
    const history = [
      { role: 'system', content: '持久记忆上下文' },
      ...Array.from({ length: 14 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: `消息${index}` })),
    ];
    const compacted = await svc._compactHistory(history);
    expect(compacted[0]).toEqual({ role: 'system', content: '持久记忆上下文' });
    expect(compacted.some(message => message.content.includes('早期摘要'))).toBe(true);
  });
});
