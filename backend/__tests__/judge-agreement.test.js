import { describe, it, expect } from 'vitest';

const {
  doubleJudgeStepForRatio,
  shouldDoubleJudge,
  computeJudgeAgreement,
  averageJudgeResults,
} = require('../src/services/agent/judge-agreement.service');

const metrics = (faithfulness, answerRelevancy, contextPrecision, contextRecall) => ({
  faithfulness,
  answer_relevancy: answerRelevancy,
  context_precision: contextPrecision,
  context_recall: contextRecall,
});

describe('judge-agreement.service', () => {
  describe('doubleJudgeStepForRatio', () => {
    it('0.1 → 每 10 条抽 1 条', () => {
      expect(doubleJudgeStepForRatio(0.1)).toBe(10);
    });
    it('0.25 → 每 4 条抽 1 条（四舍五入）', () => {
      expect(doubleJudgeStepForRatio(0.25)).toBe(4);
    });
    it('0.5 → 每 2 条、1 → 全量', () => {
      expect(doubleJudgeStepForRatio(0.5)).toBe(2);
      expect(doubleJudgeStepForRatio(1)).toBe(1);
      expect(doubleJudgeStepForRatio(2)).toBe(1);
    });
    it('0 / 负数 / 非法 → 关闭', () => {
      expect(doubleJudgeStepForRatio(0)).toBe(0);
      expect(doubleJudgeStepForRatio(-0.1)).toBe(0);
      expect(doubleJudgeStepForRatio(undefined)).toBe(0);
      expect(doubleJudgeStepForRatio('abc')).toBe(0);
    });
  });

  describe('shouldDoubleJudge', () => {
    it('步长命中判定', () => {
      expect(shouldDoubleJudge(0, 10)).toBe(true);
      expect(shouldDoubleJudge(10, 10)).toBe(true);
      expect(shouldDoubleJudge(5, 10)).toBe(false);
      expect(shouldDoubleJudge(3, 0)).toBe(false);
    });
  });

  describe('computeJudgeAgreement', () => {
    it('两次完全一致 → consistent=true', () => {
      const a = { ...metrics(0.8, 0.7, 0.9, 0.6), reason: 'r' };
      const b = { ...metrics(0.8, 0.7, 0.9, 0.6), reason: 'r2' };
      const { consistent, maxDiff, avgDiff } = computeJudgeAgreement(a, b);
      expect(consistent).toBe(true);
      expect(maxDiff).toBe(0);
      expect(avgDiff).toBe(0);
    });

    it('指标差在容差内 → 一致，超出 → 不一致', () => {
      const a = metrics(0.8, 0.7, 0.9, 0.6);
      const within = computeJudgeAgreement(a, metrics(0.85, 0.7, 0.9, 0.6));
      expect(within.consistent).toBe(true);
      expect(within.maxDiff).toBeCloseTo(0.05);

      const beyond = computeJudgeAgreement(a, metrics(0.4, 0.7, 0.9, 0.6));
      expect(beyond.consistent).toBe(false);
      expect(beyond.maxDiff).toBeCloseTo(0.4);
    });

    it('指标缺失 → consistent=null（不计入一致率）', () => {
      const a = metrics(0.8, 0.7, 0.9, 0.6);
      const { consistent } = computeJudgeAgreement(a, { faithfulness: 0.8, answer_relevancy: 0.7 });
      expect(consistent).toBeNull();
    });

    it('自定义容差生效', () => {
      const a = metrics(0.8, 0.7, 0.9, 0.6);
      expect(computeJudgeAgreement(a, metrics(0.88, 0.7, 0.9, 0.6), 0.05).consistent).toBe(false);
      expect(computeJudgeAgreement(a, metrics(0.88, 0.7, 0.9, 0.6), 0.1).consistent).toBe(true);
    });
  });

  describe('averageJudgeResults', () => {
    it('四指标取均值，latency 累加', () => {
      const first = {
        ...metrics(0.8, 0.7, 0.9, 0.6),
        reason: '首判原因',
        model: 'judge-model',
        latency: 120,
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      };
      const second = {
        ...metrics(0.6, 0.9, 0.7, 0.8),
        reason: '复判原因（应被丢弃）',
        model: 'other-model',
        latency: 80,
        usage: { prompt_tokens: 110, completion_tokens: 60, total_tokens: 170 },
      };
      const merged = averageJudgeResults(first, second);

      expect(merged.faithfulness).toBeCloseTo(0.7);
      expect(merged.answer_relevancy).toBeCloseTo(0.8);
      expect(merged.context_precision).toBeCloseTo(0.8);
      expect(merged.context_recall).toBeCloseTo(0.7);
      expect(merged.reason).toBe('首判原因');
      expect(merged.model).toBe('judge-model');
      expect(merged.latency).toBe(200);
      expect(merged.usage.prompt_tokens).toBe(210);
      expect(merged.usage.total_tokens).toBe(320);
    });

    it('第二次缺指标时保留首判值', () => {
      const first = { ...metrics(0.8, 0.7, 0.9, 0.6), model: 'm', latency: 100 };
      const merged = averageJudgeResults(first, {});
      expect(merged.faithfulness).toBe(0.8);
      expect(merged.model).toBe('m');
    });
  });
});
