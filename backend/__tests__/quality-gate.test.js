import { describe, expect, it } from 'vitest';

let evaluateQualityGate;

const loadQualityGate = async () => {
  if (!evaluateQualityGate) {
    ({ evaluateQualityGate } = await import('../../scripts/rag-eval/quality-gate.mjs'));
  }
  return evaluateQualityGate;
};

describe('RAG quality gate', () => {
  it('指标达到阈值时通过', async () => {
    const result = (await loadQualityGate())({ aggregate: { 'recall@5': 0.9, faithfulness: 0.85 } }, {
      RAG_GATE_MIN_RECALL5: '0.8',
      RAG_GATE_MIN_FAITHFULNESS: '0.8',
    });
    expect(result).toMatchObject({ passed: true, failures: [] });
  });

  it('指标缺失或低于阈值时失败', async () => {
    const result = (await loadQualityGate())({ aggregate: { 'recall@5': 0.7 } }, {
      RAG_GATE_MIN_RECALL5: '0.8',
      RAG_GATE_MIN_FAITHFULNESS: '0.8',
    });
    expect(result.passed).toBe(false);
    expect(result.failures).toEqual(expect.arrayContaining([
      expect.stringContaining('recall@5'),
      expect.stringContaining('faithfulness'),
    ]));
  });

  it('检测相对基线回归', async () => {
    const result = (await loadQualityGate())({ aggregate: { 'recall@5': 0.72 } }, {
      RAG_GATE_MAX_REGRESSION: '0.05',
      baseline: { aggregate: { 'recall@5': 0.85 } },
    });
    expect(result.passed).toBe(false);
    expect(result.failures[0]).toContain('回归');
  });
});
