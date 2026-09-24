import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const { createRunEventLog, normalizeEvent, normalizeRunId } = require('../src/services/run-event-log.service');

const tempDirectories = [];

afterEach(() => {
  while (tempDirectories.length) {
    fs.rmSync(tempDirectories.pop(), { recursive: true, force: true });
  }
});

describe('run-event-log.service', () => {
  it('规范化并脱敏事件，按 runId 回放完整事件序列', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wuli-run-events-'));
    tempDirectories.push(tempDir);
    const filePath = path.join(tempDir, 'events.jsonl');
    const log = createRunEventLog({ enabled: true, includeContent: true, filePath });

    await log.record({
      v: 1,
      runId: 'run_client_1',
      attempt: 0,
      seq: 2,
      type: 'message.delta',
      traceId: 'trace_1',
      data: {
        content: '回答片段',
        authorization: 'should-not-persist',
        nested: { apiKey: 'also-hidden', keep: true },
      },
    });
    await log.record({
      v: 1,
      runId: 'run_client_1',
      attempt: 0,
      seq: 1,
      type: 'run.started',
      traceId: 'trace_1',
      data: { conversationId: 'conv_1' },
    });
    await log.record({
      v: 1,
      runId: 'run_other_1',
      attempt: 0,
      seq: 1,
      type: 'run.started',
      data: {},
    });

    const events = await log.read('run_client_1');
    expect(events).toHaveLength(2);
    expect(events.map((event) => event.seq)).toEqual([1, 2]);
    expect(events[1].data).toEqual({ content: '回答片段', nested: { keep: true } });
    expect(await log.read('invalid')).toEqual([]);
    expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
  });

  it('默认不持久化 message.delta 正文，只保留回放诊断元数据', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wuli-run-events-'));
    tempDirectories.push(tempDir);
    const log = createRunEventLog({ enabled: true, filePath: path.join(tempDir, 'events.jsonl') });

    await log.record({ runId: 'run_client_2', seq: 1, type: 'message.delta', data: { content: '隐私回答' } });

    const [event] = await log.read('run_client_2');
    expect(event.data).toMatchObject({ content: '', contentLength: 4, contentOmitted: true });
  });

  it('超过容量时按最近运行和每次运行事件数压缩', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wuli-run-events-'));
    tempDirectories.push(tempDir);
    const filePath = path.join(tempDir, 'events.jsonl');
    const log = createRunEventLog({
      enabled: true,
      filePath,
      maxBytes: 1,
      maxRuns: 1,
      maxEventsPerRun: 2,
    });

    for (const [runId, seq] of [
      ['run_first_1', 1],
      ['run_first_1', 2],
      ['run_first_1', 3],
      ['run_second_1', 1],
    ]) {
      await log.record({ runId, attempt: 0, seq, type: 'trace', data: {} });
    }

    const events = JSON.parse(`[${(await fs.promises.readFile(filePath, 'utf8')).trim().split('\n').join(',')}]`);
    expect(new Set(events.map((event) => event.runId))).toEqual(new Set(['run_second_1']));
    expect(events).toHaveLength(1);
  });

  it('拒绝不符合约束的 runId，并固定事件信封字段', () => {
    expect(normalizeRunId('run_client_1')).toBe('run_client_1');
    expect(normalizeRunId('../run_client_1')).toBe('');
    expect(normalizeEvent({ runId: '../escape', type: 'trace' })).toMatchObject({
      v: 1,
      runId: '',
      attempt: 0,
      seq: 0,
      type: 'trace',
      data: {},
    });
  });
});
