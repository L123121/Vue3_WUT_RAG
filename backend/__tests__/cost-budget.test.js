import { describe, it, expect, vi, afterEach } from 'vitest';

/**
 * 请求级 LLM 成本硬门禁单测（cost-budget.service.js）
 *
 * ⚠️ cost-budget 通过 CJS require 读 config（阈值在模块加载时固化），
 * 改环境变量后必须清 require.cache 并动态 import 重建（同 ocr.service.test.js 模式）。
 * 覆盖：
 * 1. 无预算上下文时断言直通（后台任务 / 未接入请求）
 * 2. 预算上下文内记账与断言（调用数 / token 两条超限路径）
 * 3. runWithoutBudget 豁免、嵌套 runWithBudget 复用外层预算
 * 4. COST_GATE_ENABLED=false 全局关闭
 */
async function loadCostBudget() {
  vi.resetModules();
  delete require.cache[require.resolve('../src/config')];
  delete require.cache[require.resolve('../src/services/llm/cost-budget.service')];
  return await import('../src/services/llm/cost-budget.service');
}

describe('请求级 LLM 成本硬门禁', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    delete require.cache[require.resolve('../src/config')];
    delete require.cache[require.resolve('../src/services/llm/cost-budget.service')];
  });

  it('无预算上下文时断言直通，不抛错', async () => {
    const costBudget = await loadCostBudget();
    expect(costBudget.currentBudget()).toBeNull();
    expect(() => costBudget.assertWithinBudget('test')).not.toThrow();
    expect(() => costBudget.beginLlmCall('test')).not.toThrow();
    expect(() => costBudget.addUsage({ prompt_tokens: 1000, completion_tokens: 1000 })).not.toThrow();
  });

  it('预算上下文内记账：调用数与 token 累计', async () => {
    const costBudget = await loadCostBudget();
    await costBudget.runWithBudget(async () => {
      costBudget.beginLlmCall('a');
      costBudget.addUsage({ prompt_tokens: 100, completion_tokens: 50 });
      costBudget.beginLlmCall('b');
      costBudget.addUsage({ prompt_tokens: 30 });
      const budget = costBudget.currentBudget();
      expect(budget.llmCalls).toBe(2);
      expect(budget.promptTokens).toBe(130);
      expect(budget.completionTokens).toBe(50);
    });
  });

  it('LLM 调用数超限：断言抛 CostBudgetExceededError（reason=llm_calls）', async () => {
    vi.stubEnv('COST_GATE_MAX_LLM_CALLS', '2');
    const costBudget = await loadCostBudget();
    await costBudget.runWithBudget(async () => {
      costBudget.beginLlmCall('a');
      expect(() => costBudget.assertWithinBudget('a')).not.toThrow();
      costBudget.beginLlmCall('b');
      // 已达 2 次：断言被拦截
      expect(() => costBudget.assertWithinBudget('c')).toThrow(costBudget.CostBudgetExceededError);
      // 已 exceeded 后再断言持续拦截（不依赖再次计数）
      expect(() => costBudget.assertWithinBudget('d')).toThrow(/成本预算已耗尽/);
      const budget = costBudget.currentBudget();
      expect(budget.exceeded.reason).toBe('llm_calls');
    });
  });

  it('token 总量超限：断言抛 CostBudgetExceededError（reason=total_tokens）', async () => {
    vi.stubEnv('COST_GATE_MAX_TOTAL_TOKENS', '1000');
    const costBudget = await loadCostBudget();
    await costBudget.runWithBudget(async () => {
      costBudget.beginLlmCall('a');
      costBudget.addUsage({ prompt_tokens: 700, completion_tokens: 400 });
      expect(() => costBudget.assertWithinBudget('b')).toThrow(costBudget.CostBudgetExceededError);
      const budget = costBudget.currentBudget();
      expect(budget.exceeded.reason).toBe('total_tokens');
    });
  });

  it('runWithoutBudget 豁免：预算耗尽后后台任务调用不受影响', async () => {
    vi.stubEnv('COST_GATE_MAX_LLM_CALLS', '1');
    const costBudget = await loadCostBudget();
    await costBudget.runWithBudget(async () => {
      costBudget.beginLlmCall('main');
      expect(() => costBudget.assertWithinBudget('main2')).toThrow(costBudget.CostBudgetExceededError);
      await costBudget.runWithoutBudget(async () => {
        expect(costBudget.currentBudget()).toBeNull();
        expect(() => costBudget.assertWithinBudget('background')).not.toThrow();
      });
    });
  });

  it('嵌套 runWithBudget 复用外层预算，不重建', async () => {
    const costBudget = await loadCostBudget();
    await costBudget.runWithBudget(async () => {
      costBudget.beginLlmCall('outer');
      await costBudget.runWithBudget(async () => {
        const budget = costBudget.currentBudget();
        expect(budget.llmCalls).toBe(1); // 外层记账在内层可见
        costBudget.beginLlmCall('inner');
      });
      expect(costBudget.currentBudget().llmCalls).toBe(2);
    });
  });

  it('COST_GATE_ENABLED=false 时全局关闭：不建上下文', async () => {
    vi.stubEnv('COST_GATE_ENABLED', 'false');
    const costBudget = await loadCostBudget();
    await costBudget.runWithBudget(async () => {
      expect(costBudget.currentBudget()).toBeNull();
      costBudget.beginLlmCall('a');
      expect(costBudget.currentBudget()).toBeNull();
    });
  });
});
