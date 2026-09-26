import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * 隐私留存清理服务单元测试
 *
 * retention.service 经 CJS require 链加载 memory-store.service（实例化即打开真实
 * store.db,且原生 better-sqlite3 无法被 vi.mock 拦截）。沿用 auth.service.test.js
 * 的 require.cache 注入思路:在首次 require retention.service 之前,把 memory-store
 * 替换为 stub,保证测试 hermetic。config 为单例对象,purge/sweep 都在调用期读取,
 * 测试直接改写 config.privacy / config.observability 并在结束后还原。
 */

// 管理员口令固定走环境变量,避免加载真实 config 时生成随机密码文件
process.env.ADMIN_USERNAME = 'admin';
process.env.ADMIN_PASSWORD = 'test-admin-password-123';

// 在 require retention.service 之前注入 stub,避免打开真实 store.db
const memoryStoreId = require.resolve('../src/services/memory/memory-store.service');
require.cache[memoryStoreId] = {
  id: memoryStoreId,
  filename: memoryStoreId,
  loaded: true,
  exports: { redis: {}, conversationStore: {} },
};

const { purgeRunEventLog, purgeShareSnapshots, purgeExpiredConversations, sweepOnce } = require('../src/services/privacy/retention.service');
const config = require('../src/config');

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-09-27T00:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();

let tempDir;
const originalPrivacy = { ...config.privacy };
const originalObservability = { ...config.observability };

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'privacy-retention-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  Object.assign(config.privacy, originalPrivacy);
  Object.assign(config.observability, originalObservability);
});

const writeJsonl = (name, lines) => {
  const filePath = join(tempDir, name);
  writeFileSync(filePath, lines.join('\n') + (lines.length ? '\n' : ''), 'utf8');
  return filePath;
};

const createStoreStub = (hashData = {}, keys = []) => {
  const deleted = [];
  return {
    deleted,
    hashKeys: vi.fn(() => keys),
    hgetall: vi.fn(async (key) => hashData[key] ?? null),
    hdel: vi.fn(async (key, field) => { deleted.push(`${key}:${field}`); return 1; }),
  };
};

describe('purgeRunEventLog', () => {
  it('删除留存期外的事件行,保留期内与损坏行原样保留', async () => {
    const oldEvent = { runId: 'run_old', type: 'content', recordedAt: iso(NOW - 40 * DAY_MS) };
    const newEvent = { runId: 'run_new', type: 'content', recordedAt: iso(NOW - 1 * DAY_MS) };
    const boundaryEvent = { runId: 'run_edge', type: 'content', recordedAt: iso(NOW - 30 * DAY_MS) };
    const filePath = writeJsonl('run-events.jsonl', [
      JSON.stringify(oldEvent),
      JSON.stringify(newEvent),
      '{corrupt',
      JSON.stringify(boundaryEvent),
    ]);

    const removed = await purgeRunEventLog(filePath, NOW - 30 * DAY_MS);

    expect(removed).toBe(1);
    const remaining = readFileSync(filePath, 'utf8').trim().split('\n');
    expect(remaining).toHaveLength(3);
    expect(remaining).toContain(JSON.stringify(newEvent));
    expect(remaining).toContain(JSON.stringify(boundaryEvent)); // 恰好到期的保留
    expect(remaining).toContain('{corrupt');
  });

  it('文件不存在时返回 0 且不报错', async () => {
    const removed = await purgeRunEventLog(join(tempDir, 'missing.jsonl'), NOW);
    expect(removed).toBe(0);
  });

  it('没有可清理内容时不重写文件', async () => {
    const filePath = writeJsonl('fresh.jsonl', [JSON.stringify({ runId: 'run_a', recordedAt: iso(NOW) })]);
    const before = readFileSync(filePath, 'utf8');

    const removed = await purgeRunEventLog(filePath, NOW - 30 * DAY_MS);

    expect(removed).toBe(0);
    expect(readFileSync(filePath, 'utf8')).toBe(before);
  });
});

describe('purgeShareSnapshots', () => {
  it('只删除 createdAt 过期的快照字段', async () => {
    const target = createStoreStub({
      'share:snapshots': {
        oldsnap: { code: 'oldsnap', createdAt: iso(NOW - 100 * DAY_MS) },
        freshsnap: { code: 'freshsnap', createdAt: iso(NOW - 1 * DAY_MS) },
        brokensnap: { code: 'brokensnap', createdAt: 'not-a-date' },
      },
    });

    const removed = await purgeShareSnapshots(target, NOW - 90 * DAY_MS);

    expect(removed).toBe(1);
    expect(target.deleted).toEqual(['share:snapshots:oldsnap']);
  });

  it('hash 为空时不删除任何数据', async () => {
    const target = createStoreStub();

    expect(await purgeShareSnapshots(target, NOW)).toBe(0);
    expect(target.hdel).not.toHaveBeenCalled();
  });
});

describe('purgeExpiredConversations', () => {
  it('按 updatedAt 删除过期会话,缺失时回退 createdAt', async () => {
    const target = createStoreStub({
      'conversations:user_a': {
        conv_old: { id: 'conv_old', updatedAt: iso(NOW - 400 * DAY_MS) },
        conv_new: { id: 'conv_new', updatedAt: iso(NOW - 1 * DAY_MS) },
      },
      'conversations:user_b': {
        conv_legacy: { id: 'conv_legacy', createdAt: iso(NOW - 400 * DAY_MS) },
      },
    }, ['conversations:user_a', 'conversations:user_b']);

    const removed = await purgeExpiredConversations(target, NOW - 365 * DAY_MS);

    expect(removed).toBe(2);
    expect(target.deleted).toEqual(['conversations:user_a:conv_old', 'conversations:user_b:conv_legacy']);
  });

  it('store 不支持 hashKeys 时安全返回 0', async () => {
    expect(await purgeExpiredConversations({}, NOW)).toBe(0);
  });
});

describe('sweepOnce', () => {
  it('留存期为 0 的类别不清理', async () => {
    const filePath = writeJsonl('skip.jsonl', [JSON.stringify({ runId: 'run_old', recordedAt: iso(NOW - 60 * DAY_MS) })]);
    config.privacy.runEventLogRetentionDays = 0;
    config.privacy.shareSnapshotRetentionDays = 0;
    config.privacy.conversationRetentionDays = 0;
    config.observability.runEventLogPath = filePath;

    const summary = await sweepOnce({ now: NOW });

    expect(summary).toMatchObject({ runEvents: 0, shareSnapshots: 0, conversations: 0, changed: false });
    expect(readFileSync(filePath, 'utf8')).toContain('run_old');
  });

  it('按配置的留存天数清理对应类别并汇总', async () => {
    const filePath = writeJsonl('run-events-sweep.jsonl', [
      JSON.stringify({ runId: 'run_old', recordedAt: iso(NOW - 60 * DAY_MS) }),
      JSON.stringify({ runId: 'run_new', recordedAt: iso(NOW - 1 * DAY_MS) }),
    ]);
    config.privacy.runEventLogRetentionDays = 30;
    config.privacy.shareSnapshotRetentionDays = 90;
    config.privacy.conversationRetentionDays = 0;
    config.observability.runEventLogPath = filePath;
    // sweep 直接使用模块内注入的 redis stub（空对象,hgetall 抛错被吞）,验证 share 类别失败不影响其他类别
    const summary = await sweepOnce({ now: NOW });

    expect(summary.runEvents).toBe(1);
    expect(summary.shareSnapshots).toBe(0);
    expect(summary.conversations).toBe(0);
    expect(summary.changed).toBe(true);
    expect(existsSync(filePath)).toBe(true);
  });
});
