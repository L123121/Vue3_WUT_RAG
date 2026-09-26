import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { createOperationalMetrics } = require('../src/services/observability/operational-metrics.service');
const { OperationalMetricsPersistence } = require('../src/services/observability/operational-metrics-persistence.service');

const originalTtsCost = process.env.TTS_COST_CNY_PER_10K_CHARS;

describe('operational-metrics.service', () => {
  afterEach(() => {
    if (originalTtsCost === undefined) delete process.env.TTS_COST_CNY_PER_10K_CHARS;
    else process.env.TTS_COST_CNY_PER_10K_CHARS = originalTtsCost;
  });

  it('累计总量不会受最近样本上限影响', () => {
    process.env.TTS_COST_CNY_PER_10K_CHARS = '1';
    const metrics = createOperationalMetrics({ now: () => new Date(2026, 7, 18, 10).getTime() });

    for (let index = 0; index < 2105; index += 1) {
      metrics.recordTtsUsage({ model: 'tts-test', characters: 10 });
    }

    const snapshot = metrics.snapshot();
    expect(snapshot.tts.total).toBe(2105);
    expect(snapshot.tts.characters).toBe(21050);
    expect(snapshot.tts.recent).toHaveLength(100);
    expect(snapshot.daily.estimatedCostCny).toBeCloseTo(2.105);
  });

  it('聚合运行完成率、首事件延迟、工具调用和降级率', () => {
    const metrics = createOperationalMetrics({ now: () => Date.parse('2026-08-18T12:00:00.000Z') });
    metrics.recordRun({ status: 'completed', route: 'rag', durationMs: 100, firstEventMs: 20, toolRounds: 1, toolCalls: 2 });
    metrics.recordRun({ status: 'failed', route: 'agent', durationMs: 300, firstEventMs: 40, toolRounds: 2, toolCalls: 1, fallback: true });

    const snapshot = metrics.snapshot();
    expect(snapshot.runs).toMatchObject({
      total: 2,
      completed: 1,
      failed: 1,
      aborted: 0,
      successRate: 0.5,
      fallbackRate: 0.5,
      toolCalls: 3,
      routeCounts: { rag: 1, agent: 1 },
    });
    expect(snapshot.runs.duration).toEqual({ p50Ms: 100, p95Ms: 300 });
    expect(snapshot.runs.firstEvent).toEqual({ p50Ms: 20, p95Ms: 40 });
    expect(metrics.rawSamples()).toMatchObject({ runDurations: [100, 300], runFirstEventLatencies: [20, 40] });
  });

  it('聚合 Jev 决策成功、shadow、超时和降级指标', () => {
    const metrics = createOperationalMetrics({ now: () => Date.parse('2026-08-18T12:00:00.000Z') });
    metrics.recordDecision({ status: 'success', mode: 'shadow', latencyMs: 80, traceId: 'trace-1' });
    metrics.recordDecision({ status: 'timeout', mode: 'enforce', latencyMs: 1200, fallback: true, traceId: 'trace-2' });

    expect(metrics.snapshot().decisions).toMatchObject({
      total: 2,
      successes: 1,
      fallbacks: 1,
      timeouts: 1,
      shadow: 1,
      successRate: 0.5,
      fallbackRate: 0.5,
      latency: { p50Ms: 80, p95Ms: 1200 },
    });
    expect(metrics.rawSamples().decisionLatencies).toEqual([80, 1200]);
  });

  it('跨自然日后重新计算当日成本', () => {
    process.env.TTS_COST_CNY_PER_10K_CHARS = '1';
    let timestamp = Date.parse('2026-08-18T15:59:00.000Z');
    const metrics = createOperationalMetrics({ now: () => timestamp, timeZone: 'Asia/Shanghai' });
    metrics.recordTtsUsage({ model: 'tts-test', characters: 10000 });

    timestamp = Date.parse('2026-08-18T16:01:00.000Z');
    metrics.recordTtsUsage({ model: 'tts-test', characters: 5000 });

    expect(metrics.snapshot().daily).toEqual({ date: '2026-08-19', estimatedCostCny: 0.5 });
    expect(metrics.snapshot().estimatedCostCny).toBe(1.5);
  });

  it('从持久化状态恢复累计总量并批量写回最新状态', () => {
    process.env.TTS_COST_CNY_PER_10K_CHARS = '1';
    const persistence = {
      load: vi.fn(() => ({
        totals: {
          requests: 8,
          requestErrors: 1,
          llmCalls: 2,
          promptTokens: 300,
          completionTokens: 100,
          llmCostCny: 0.4,
          ttsCalls: 3,
          ttsCharacters: 12000,
          ttsCostCny: 1.2,
        },
        daily: { date: '2026-08-18', estimatedCostCny: 1.6 },
      })),
      save: vi.fn(),
      close: vi.fn(),
    };
    const metrics = createOperationalMetrics({
      now: () => Date.parse('2026-08-18T12:00:00.000Z'),
      timeZone: 'Asia/Shanghai',
      persistence,
      persistDelayMs: 60000,
    });

    metrics.recordTtsUsage({ model: 'tts-test', characters: 5000 });
    metrics.recordRequest({ method: 'GET', path: '/api/health', statusCode: 200, durationMs: 10 });
    metrics.flush();

    expect(metrics.snapshot()).toMatchObject({
      requests: { total: 9, errors: 1 },
      tts: { total: 4, characters: 17000, estimatedCostCny: 1.7 },
      daily: { date: '2026-08-18', estimatedCostCny: 2.1 },
      estimatedCostCny: 2.1,
    });
    expect(persistence.save).toHaveBeenCalledOnce();
    expect(persistence.save).toHaveBeenCalledWith(expect.objectContaining({
      totals: expect.objectContaining({ requests: 9, ttsCalls: 4, ttsCharacters: 17000 }),
      daily: { date: '2026-08-18', estimatedCostCny: 2.1 },
    }));

    metrics.close();
    expect(persistence.close).toHaveBeenCalledOnce();
  });

  it('通过 SQLite 保存并重新加载运营指标状态', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wuli-ops-metrics-'));
    const dbPath = path.join(tempDir, 'metrics.db');
    try {
      const first = new OperationalMetricsPersistence({ dbPath });
      first.save({
        totals: { requests: 12, requestErrors: 2 },
        daily: { date: '2026-08-18', estimatedCostCny: 3.5 },
      });
      first.close();

      const second = new OperationalMetricsPersistence({ dbPath });
      expect(second.load()).toEqual({
        totals: { requests: 12, requestErrors: 2 },
        daily: { date: '2026-08-18', estimatedCostCny: 3.5 },
      });
      second.close();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
