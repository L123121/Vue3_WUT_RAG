"use strict";

/**
 * JudgeAgreement — 双判抽样（judge 质量控制）
 *
 * 评测主循环按比例抽样对同一样本调用两次 judge：
 *   - 两次四指标差的绝对值全部 ≤ tolerance → 判定"一致"，据此量化 judge 本身的稳定性
 *   - 抽中的样本取两次评分的均值作为最终分（降方差），失败侧单判回退
 *
 * 纯函数模块：采样与一致性计算独立于 IO，便于单测。
 */

const METRIC_KEYS = ['faithfulness', 'answer_relevancy', 'context_precision', 'context_recall'];

const round4 = (n) => Math.round(n * 10000) / 10000;

/** ratio → 采样步长：0.1 → 每 10 条抽 1 条；≤0 或非法 → 关闭；≥1 → 全量 */
function doubleJudgeStepForRatio(ratio) {
  const r = Number(ratio);
  if (!Number.isFinite(r) || r <= 0) return 0;
  if (r >= 1) return 1;
  return Math.max(1, Math.round(1 / r));
}

function shouldDoubleJudge(index, step) {
  return step > 0 && index % step === 0;
}

/**
 * 两次 judge 结果的一致性
 * @param {Object} first 首判结果（含四指标）
 * @param {Object} second 复判结果
 * @param {number} [tolerance=0.1] 一致容差（四指标差的绝对值均需 ≤ tolerance）
 * @returns {{ metricDiffs: Object<string, number|null>, maxDiff: number, avgDiff: number|null,
 *             consistent: boolean|null, tolerance: number }}
 *   指标缺失时无法判定，consistent 为 null（不计入一致率）
 */
function computeJudgeAgreement(first, second, tolerance = 0.1) {
  const metricDiffs = {};
  let maxDiff = 0;
  let sumDiff = 0;
  let counted = 0;
  for (const key of METRIC_KEYS) {
    const a = Number(first?.[key]);
    const b = Number(second?.[key]);
    const diff = Number.isFinite(a) && Number.isFinite(b) ? Math.abs(a - b) : null;
    metricDiffs[key] = diff;
    if (diff !== null) {
      maxDiff = Math.max(maxDiff, diff);
      sumDiff += diff;
      counted++;
    }
  }
  const avgDiff = counted > 0 ? sumDiff / counted : null;
  return {
    metricDiffs,
    maxDiff: round4(maxDiff),
    avgDiff: avgDiff === null ? null : round4(avgDiff),
    consistent: counted === METRIC_KEYS.length ? maxDiff <= tolerance : null,
    tolerance,
  };
}

/**
 * 抽中样本的最终评分：两次均值（降方差）。
 * reason/model 取第一次；latency/usage 累加，反映双判的真实评测开销。
 */
function averageJudgeResults(first, second) {
  const merged = { ...first };
  for (const key of METRIC_KEYS) {
    const a = Number(first?.[key]);
    const b = Number(second?.[key]);
    if (Number.isFinite(a) && Number.isFinite(b)) merged[key] = (a + b) / 2;
  }
  if (Number.isFinite(first?.latency) && Number.isFinite(second?.latency)) {
    merged.latency = first.latency + second.latency;
  }
  if (first?.usage && second?.usage) {
    merged.usage = {
      ...first.usage,
      prompt_tokens: (first.usage.prompt_tokens || 0) + (second.usage.prompt_tokens || 0),
      completion_tokens: (first.usage.completion_tokens || 0) + (second.usage.completion_tokens || 0),
      total_tokens: (first.usage.total_tokens || 0) + (second.usage.total_tokens || 0),
    };
  }
  return merged;
}

module.exports = {
  METRIC_KEYS,
  doubleJudgeStepForRatio,
  shouldDoubleJudge,
  computeJudgeAgreement,
  averageJudgeResults,
};
