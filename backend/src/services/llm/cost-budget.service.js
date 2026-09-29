"use strict";

/**
 * CostBudgetService — 请求级 LLM 成本硬门禁
 *
 * 问题：单次请求的 LLM 调用分散在多条链路（意图分类 / Jev 决策 / Agent 多轮 /
 * Agentic RAG 重写循环 / RAG 生成 / 记忆提取），各链路有自己的轮次上限，但
 * "全链路合计失控"没有统一闸门——任何一处循环 bug 或重试风暴都会直接烧钱。
 *
 * 方案：AsyncLocalStorage 建立请求作用域的预算上下文，ai.service 的两个入口
 * （getCompletion / getCompletionStream）统一接入：
 *   - 调用前 assertWithinBudget：超限抛 CostBudgetExceededError（fail-closed，
 *     上游各链路均有降级路径：RAG 拒答 / agent 回落 / 记忆正则回退）
 *   - 调用后 record：调用数 +1，token 用量随响应累计
 *
 * 设计约束：
 *   - 零调用方改动：预算断言与记账都收敛在 ai.service 入口，业务链路无感
 *   - 后台增强任务豁免：记忆提取/压缩、百科互链编译是响应后的 fire-and-forget
 *     调用，被主流程预算耗尽时不应连坐（各有正则/降级兜底），用 runWithoutBudget 隔离
 *   - 摘要压缩（judgeService.summarize）走独立评测 Key，不计入生产预算
 *   - 阈值默认宽松（16 次 / 120k token）：只拦截失控循环，正常最重请求
 *     （agent 2 轮 + agentic RAG 2 轮 + RAG 生成 + 记忆提取 ≈ 6-8 次调用）远够用
 */

const { AsyncLocalStorage } = require('async_hooks');
const config = require('../../config');
const { logEvent } = require('../observability/observability.service');
const { operationalMetrics } = require('../observability/operational-metrics.service');

class CostBudgetExceededError extends Error {
  constructor(reason, snapshot) {
    super(`LLM 成本预算已耗尽（${reason}）：本次请求后续 LLM 调用被硬门禁拦截`);
    this.name = 'CostBudgetExceededError';
    this.code = 'COST_BUDGET_EXCEEDED';
    this.reason = reason;
    this.snapshot = snapshot;
  }
}

const storage = new AsyncLocalStorage();

function enabled() {
  return config.costGate?.enabled !== false;
}

function limits() {
  return {
    maxLlmCalls: Math.max(config.costGate?.maxLlmCalls || 16, 1),
    maxTotalTokens: Math.max(config.costGate?.maxTotalTokens || 120000, 1),
  };
}

function createBudget(traceId) {
  return {
    traceId: traceId || null,
    llmCalls: 0,
    promptTokens: 0,
    completionTokens: 0,
    exceeded: null, // { reason, at }
  };
}

function totalTokens(budget) {
  return budget.promptTokens + budget.completionTokens;
}

/**
 * 在请求作用域内建立预算上下文。middleware 层调用一次，整个异步链共享。
 * 关闭（COST_GATE_ENABLED=false）或已处于预算上下文时直通不重建。
 */
function runWithBudget(fn, { traceId } = {}) {
  if (!enabled()) return fn();
  if (storage.getStore()) return fn(); // 嵌套调用复用外层预算
  return storage.run(createBudget(traceId), fn);
}

/**
 * 豁免上下文：后台增强任务（记忆提取/压缩、百科互链编译）不受主流程预算约束。
 */
function runWithoutBudget(fn) {
  return storage.run(null, fn);
}

function currentBudget() {
  return storage.getStore() || null;
}

/**
 * 预算断言：超限抛 CostBudgetExceededError。ai.service 调用前执行。
 */
function assertWithinBudget(stage) {
  const budget = currentBudget();
  if (!budget) return;
  if (budget.exceeded) throw new CostBudgetExceededError(budget.exceeded.reason, snapshotOf(budget));

  const limitsNow = limits();
  if (budget.llmCalls >= limitsNow.maxLlmCalls) {
    budget.exceeded = { reason: 'llm_calls', at: Date.now() };
  } else if (totalTokens(budget) >= limitsNow.maxTotalTokens) {
    budget.exceeded = { reason: 'total_tokens', at: Date.now() };
  }

  if (budget.exceeded) {
    logEvent('warn', 'cost_budget_exceeded', {
      traceId: budget.traceId,
      stage: stage || 'unknown',
      reason: budget.exceeded.reason,
      llmCalls: budget.llmCalls,
      totalTokens: totalTokens(budget),
      limits: limitsNow,
    });
    operationalMetrics.recordCostGateExceeded({ traceId: budget.traceId, reason: budget.exceeded.reason });
    throw new CostBudgetExceededError(budget.exceeded.reason, snapshotOf(budget));
  }
}

/**
 * 记账：ai.service 调用开始时 llmCalls+1（失败也计——成本已发生），
 * 响应返回后按 usage 累计 token。
 */
function beginLlmCall(stage) {
  const budget = currentBudget();
  if (!budget) return;
  budget.llmCalls += 1;
  if (process.env.COST_GATE_TRACE === 'true') {
    logEvent('info', 'cost_budget_call', {
      traceId: budget.traceId, stage: stage || 'unknown', llmCalls: budget.llmCalls, totalTokens: totalTokens(budget),
    });
  }
}

function addUsage(usage) {
  const budget = currentBudget();
  if (!budget || !usage) return;
  budget.promptTokens += Number(usage.prompt_tokens) || 0;
  budget.completionTokens += Number(usage.completion_tokens) || 0;
}

function snapshotOf(budget) {
  return {
    llmCalls: budget.llmCalls,
    promptTokens: budget.promptTokens,
    completionTokens: budget.completionTokens,
    totalTokens: totalTokens(budget),
  };
}

module.exports = {
  CostBudgetExceededError,
  runWithBudget,
  runWithoutBudget,
  currentBudget,
  assertWithinBudget,
  beginLlmCall,
  addUsage,
};
