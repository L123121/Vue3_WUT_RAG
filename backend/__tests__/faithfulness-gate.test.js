import { describe, it, expect, vi, afterEach } from 'vitest';

/**
 * faithfulness 硬门禁单测（faithfulness-gate.service.js + drainChat 拦截）
 *
 * 覆盖：
 * 1. 决策矩阵：无 grounding / mode=off / coverage 达标 → 无动作
 * 2. warn 模式 → action=warn；enforce 模式 → action=block + 拒答文案
 * 3. 阈值经 config 读取（RAG_FAITHFULNESS_GATE / RAG_FAITHFULNESS_GATE_MIN_COVERAGE）
 * 4. drainChat 收到 faithfulness_gate(block) 事件后 reply 替换为拒答文案（非流式真正拦截）
 */

async function loadGate() {
  vi.resetModules();
  delete require.cache[require.resolve('../src/config')];
  delete require.cache[require.resolve('../src/services/rag/faithfulness-gate.service')];
  return await import('../src/services/rag/faithfulness-gate.service');
}

const lowGrounding = {
  totalSentences: 10,
  supportedCount: 2,
  unsupportedCount: 8,
  coverage: 0.2,
  level: 'low',
  minSupport: 0.35,
};

describe('faithfulness 门禁决策', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    delete require.cache[require.resolve('../src/config')];
    delete require.cache[require.resolve('../src/services/rag/faithfulness-gate.service')];
  });

  it('无 grounding（未校验/无上下文）时不产生门禁动作', async () => {
    const gate = await loadGate();
    expect(gate.evaluateFaithfulnessGate(null)).toBeNull();
    expect(gate.evaluateFaithfulnessGate(undefined)).toBeNull();
  });

  it('mode=off（默认）时仅标注不门禁', async () => {
    const gate = await loadGate();
    expect(gate.evaluateFaithfulnessGate(lowGrounding)).toBeNull();
  });

  it('coverage 达标时不触发', async () => {
    vi.stubEnv('RAG_FAITHFULNESS_GATE', 'enforce');
    const gate = await loadGate();
    expect(gate.evaluateFaithfulnessGate({ ...lowGrounding, coverage: 0.9, level: 'high' })).toBeNull();
  });

  it('warn 模式：低溯源回答 action=warn，不带拒答文案', async () => {
    vi.stubEnv('RAG_FAITHFULNESS_GATE', 'warn');
    const gate = await loadGate();
    const decision = gate.evaluateFaithfulnessGate(lowGrounding);
    expect(decision.action).toBe('warn');
    expect(decision.blocked).toBe(false);
    expect(decision.refusalText).toBeUndefined();
  });

  it('enforce 模式：低溯源回答 action=block 并携带拒答文案', async () => {
    vi.stubEnv('RAG_FAITHFULNESS_GATE', 'enforce');
    const gate = await loadGate();
    const decision = gate.evaluateFaithfulnessGate(lowGrounding);
    expect(decision.action).toBe('block');
    expect(decision.blocked).toBe(true);
    expect(decision.refusalText).toContain('未通过引用校验');
    expect(decision.minCoverage).toBe(0.35);
  });

  it('阈值可用 RAG_FAITHFULNESS_GATE_MIN_COVERAGE 调整', async () => {
    vi.stubEnv('RAG_FAITHFULNESS_GATE', 'enforce');
    vi.stubEnv('RAG_FAITHFULNESS_GATE_MIN_COVERAGE', '0.8');
    const gate = await loadGate();
    // 0.85 在默认阈值（0.35）下会拦截，但调高阈值到 0.8 后通过
    expect(gate.evaluateFaithfulnessGate({ ...lowGrounding, coverage: 0.85, level: 'high' })).toBeNull();
    const decision = gate.evaluateFaithfulnessGate({ ...lowGrounding, coverage: 0.5, level: 'medium' });
    expect(decision.action).toBe('block');
    expect(decision.minCoverage).toBe(0.8);
  });
});

describe('drainChat 的 faithfulness 拦截（非流式路径）', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function makeFakeSvc(events) {
    return {
      async *chatStream() {
        for (const event of events) yield event;
      },
      _createTracer: () => ({ markFallback: () => {}, markError: () => {}, finish: () => {}, recordStage: () => {} }),
      _recordTraceStage: () => 0,
      _finishTrace: (_tracer, result) => ({ ...result, traceId: 't1', trace: {} }),
      aiService: { getCompletion: vi.fn() },
    };
  }

  it('enforce：block 事件把 reply 替换为拒答文案并附 faithfulnessGate', async () => {
    vi.stubEnv('RAG_FAITHFULNESS_GATE', 'enforce');
    const { drainChat } = await import('../src/services/rag/rag-chat-drain.service');
    const gatePayload = {
      action: 'block',
      mode: 'enforce',
      coverage: 0.2,
      minCoverage: 0.35,
      blocked: true,
      refusalText: '抱歉，本次回答未通过引用校验——部分内容无法在检索到的资料中溯源，为避免误导已拦截。',
    };
    const svc = makeFakeSvc([
      { type: 'sources', sources: [{ docId: 'doc_x', title: 'A' }] },
      { type: 'content', content: '这段回答明显在编造', done: false },
      { type: 'grounding', grounding: { coverage: 0.2, level: 'low', unsupportedCount: 8 } },
      { type: 'faithfulness_gate', gate: gatePayload },
      { type: 'content', content: '', done: true, pipeline: { context: 'c', topChunks: [], questionType: null, rewrittenQuery: null, retrieval: null } },
    ]);

    const result = await drainChat(svc, '问题', [], {});
    expect(result.reply).toBe(gatePayload.refusalText);
    expect(result.reply).not.toContain('编造');
    expect(result.faithfulnessGate).toEqual(gatePayload);
    expect(result.grounding).toEqual({ coverage: 0.2, level: 'low', unsupportedCount: 8 });
  });

  it('warn：事件只附加不替换 reply', async () => {
    const { drainChat } = await import('../src/services/rag/rag-chat-drain.service');
    const gatePayload = { action: 'warn', mode: 'warn', coverage: 0.2, minCoverage: 0.35, blocked: false };
    const svc = makeFakeSvc([
      { type: 'content', content: '正常回答', done: false },
      { type: 'faithfulness_gate', gate: gatePayload },
      { type: 'content', content: '', done: true, pipeline: { context: 'c', topChunks: [], questionType: null, rewrittenQuery: null, retrieval: null } },
    ]);

    const result = await drainChat(svc, '问题', [], {});
    expect(result.reply).toContain('正常回答');
    expect(result.faithfulnessGate).toEqual(gatePayload);
  });
});
