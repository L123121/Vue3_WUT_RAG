"use strict";

/**
 * FaithfulnessGate — faithfulness 硬门禁决策层
 *
 * 背景：grounding.service 只做"标注与观测"（前端徽标），低溯源回答照样到达用户。
 * 本服务在其上叠加门禁决策，把运行时引用校验从纯观测升级为可执行动作：
 *
 *   mode=off      完全现状：仅 grounding 事件标注（默认，避免误杀改写型正确答案）
 *   mode=warn     低溯源回答额外下发 faithfulness_gate 事件（action=warn），前端展示醒目警示条
 *   mode=enforce  低溯源回答 action=block：
 *                   - 流式：回答已流出，SSE 下发 gate 事件，前端把气泡文案替换为拒答说明
 *                     （与内容审核的中途撤回同一模式；原文不删除，随 gate.originalText 供追溯面板展示）
 *                   - 非流式（drain 路径，评测/Agent 工具）：gate 事件回流 drainChat，
 *                     reply 直接替换为拒答文案，未通过校验的回答不返回给调用方
 *
 * 设计约束：
 *   - 零模型调用：决策只消费 grounding.service 已算好的覆盖率（<1ms，不拖慢收尾）
 *   - 阈值与 grounding 的 minSupport 解耦：minSupport 判定"单句是否已溯源"，
 *     gateMinCoverage 判定"整篇回答可不可信"（默认 0.35，即 ≥65% 句子未溯源才拦截）
 *   - 仅在存在 RAG 上下文时执行（grounding 为 null 的路径天然通过）
 */

const config = require('../../config');
const { logEvent } = require('../observability/observability.service');

const GATE_MODES = new Set(['off', 'warn', 'enforce']);

/** enforce 拦截时对用户展示的替换文案（与"没有可靠来源"拒答区分开：来源有，但回答没过校验） */
const REFUSAL_TEXT = '抱歉，本次回答未通过引用校验——部分内容无法在检索到的资料中溯源，为避免误导已拦截。' +
  '你可以换一种问法重试，或把问题补充得更具体。';

function gateMode() {
  const mode = String(config.rag?.faithfulnessGateMode || 'off').toLowerCase();
  return GATE_MODES.has(mode) ? mode : 'off';
}

function gateMinCoverage() {
  const value = Number.parseFloat(config.rag?.faithfulnessGateMinCoverage);
  return Number.isFinite(value) ? Math.min(Math.max(value, 0), 1) : 0.35;
}

/**
 * 门禁决策
 *
 * @param {Object|null} grounding - grounding.service 的校验结果（null 表示本次未校验）
 * @param {Object} [options]
 * @param {string} [options.mode] - 覆盖全局 mode（测试用）
 * @param {number} [options.minCoverage] - 覆盖全局阈值（测试用）
 * @returns {Object|null} null=不产生门禁动作；否则
 *   { action: 'warn'|'block', mode, coverage, level, minCoverage, minSupport,
 *     unsupportedCount, refusalText?, blocked, gatedAt }
 */
function evaluateFaithfulnessGate(grounding, options = {}) {
  if (!grounding || typeof grounding !== 'object') return null;
  const mode = options.mode || gateMode();
  if (mode === 'off') return null;

  const minCoverage = Number.isFinite(options.minCoverage)
    ? Math.min(Math.max(options.minCoverage, 0), 1)
    : gateMinCoverage();
  const coverage = Number(grounding.coverage);
  if (!Number.isFinite(coverage) || coverage >= minCoverage) return null;

  const block = mode === 'enforce';
  return {
    action: block ? 'block' : 'warn',
    mode,
    coverage,
    level: grounding.level || null,
    minCoverage,
    minSupport: grounding.minSupport ?? null,
    unsupportedCount: grounding.unsupportedCount ?? null,
    totalSentences: grounding.totalSentences ?? null,
    blocked: block,
    refusalText: block ? REFUSAL_TEXT : undefined,
    gatedAt: Date.now(),
  };
}

/**
 * 决策 + 观测（logEvent 一体化）：rag-generation 两处调用共用，保证日志口径一致。
 * 返回与 evaluateFaithfulnessGate 相同的决策结果。
 */
function evaluateAndLog(grounding, { traceId } = {}) {
  const gate = evaluateFaithfulnessGate(grounding);
  if (gate) {
    logEvent('warn', 'faithfulness_gate_triggered', {
      traceId: traceId || null,
      action: gate.action,
      mode: gate.mode,
      coverage: gate.coverage,
      minCoverage: gate.minCoverage,
      unsupportedCount: gate.unsupportedCount,
      totalSentences: gate.totalSentences,
    });
  }
  return gate;
}

module.exports = {
  REFUSAL_TEXT,
  GATE_MODES,
  evaluateFaithfulnessGate,
  evaluateAndLog,
};
