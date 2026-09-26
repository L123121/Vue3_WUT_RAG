import { describe, it, expect, afterAll } from 'vitest';

const {
  importEvaluation,
  getEvaluationPayload,
  updateEvaluationScores,
  getEvaluations,
} = require('../src/services/agent/quality-governance.service');
const { redis: store } = require('../src/services/memory/memory-store.service');

const EVALUATION_KEY = 'quality_governance:evaluations';
const EVALUATION_PAYLOAD_KEY = 'quality_governance:eval_payloads';
const createdIds = [];

function makeReport() {
  return {
    datasetVersion: 'manual-import-test',
    results: [
      {
        id: 'case-1',
        question: '图书馆几点开门？',
        answer: '早上 8 点。',
        ground_truth: '8 点。',
        metrics: { faithfulness: 1, answer_relevancy: 0.8, context_precision: 0.6, context_recall: 1, overall: 0.85 },
        latency: 1200,
        model: 'step-3.7-flash',
        humanScore: 4,
        comment: '基本正确',
      },
      {
        id: 'case-2',
        question: '转专业条件？',
        answer: '绩点达标后申请。',
        metrics: { faithfulness: 0.5, answer_relevancy: 0.5, context_precision: 0.5, context_recall: 0.5, overall: 0.5 },
        humanScore: 2,
      },
      {
        id: 'case-3',
        question: '无指标条目',
        answer: '——',
      },
    ],
  };
}

afterAll(async () => {
  for (const id of createdIds) {
    await store.hdel(EVALUATION_KEY, id);
    await store.hdel(EVALUATION_PAYLOAD_KEY, id);
  }
});

describe('importEvaluation（离线报告导入）', () => {
  it('聚合 RAGAS 指标、还原人工分，source=manual', async () => {
    const saved = await importEvaluation(makeReport());
    createdIds.push(saved.id);

    expect(saved.source).toBe('manual');
    expect(saved.sampleCount).toBe(3);
    expect(saved.datasetVersion).toBe('manual-import-test');
    expect(saved.model).toBe('step-3.7-flash');
    // 无指标条目不拉低均值：(1 + 0.5) / 2
    expect(saved.metrics.faithfulness).toBeCloseTo(0.75);
    expect(saved.metrics.overall).toBeCloseTo(0.675);
    // 平均延迟只统计有限数值
    expect(saved.avgLatency).toBe(1200);
    // humanScore 平铺在 results 里 → 还原为映射
    expect(saved.scoredCount).toBe(2);
  });

  it('缺少 results 数组时返回 400', async () => {
    await expect(importEvaluation({ foo: 1 })).rejects.toMatchObject({ status: 400 });
  });

  it('payload 可回读，打分回写为整体替换', async () => {
    const saved = await importEvaluation(makeReport());
    createdIds.push(saved.id);

    const payload = await getEvaluationPayload(saved.id);
    expect(payload.results).toHaveLength(3);
    expect(payload.humanScores['case-1']).toBe(4);
    expect(payload.comments['case-1']).toBe('基本正确');
    expect(payload.importedAt).toBeTruthy();

    const updated = await updateEvaluationScores(saved.id, {
      humanScores: { 'case-1': 5 },
      comments: {},
    });
    expect(updated.scoredCount).toBe(1);

    const reloaded = await getEvaluationPayload(saved.id);
    expect(reloaded.humanScores).toEqual({ 'case-1': 5 });
    expect(reloaded.comments).toEqual({});
  });

  it('回写不存在的评测返回 404', async () => {
    await expect(updateEvaluationScores('eval_nonexistent', { humanScores: {} }))
      .rejects.toMatchObject({ status: 404 });
  });

  it('导入记录进入评测历史（与在线 RAGAS 同表）', async () => {
    const saved = await importEvaluation(makeReport());
    createdIds.push(saved.id);

    const list = await getEvaluations();
    const imported = list.find((item) => item.id === saved.id);
    expect(imported).toBeTruthy();
    expect(imported.source).toBe('manual');
  });
});
