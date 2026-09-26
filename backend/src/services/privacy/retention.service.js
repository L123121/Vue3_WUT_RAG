'use strict';

/**
 * 隐私留存清理服务
 *
 * 周期性清理到期留存的数据，配合 config.privacy 的留存天数配置使用：
 * - run-events.jsonl 回放日志（recordedAt 早于留存期的事件行被清除）
 * - 分享快照（share:snapshots hash 中 createdAt 过期的字段，留存期 > 0 时启用）
 * - 过期会话（conversations:* 中 updatedAt 过期的会话，留存期 > 0 时启用）
 *
 * 用户内容类（分享快照、会话）默认留存期为 0（不自动删除），只有站点显式
 * 配置留存天数后 sweeper 才会触碰；运维诊断类（RunEvent 日志）默认 30 天。
 */

const fs = require('fs');
const config = require('../../config');
const { logEvent } = require('../observability/observability.service');
const { redis: store } = require('../memory/memory-store.service');

// 与 routes/share.routes.js 的 SNAPSHOT_KEY 保持一致
const SHARE_SNAPSHOT_KEY = 'share:snapshots';
const CONVERSATION_KEY_PATTERN = 'conversations:%';
const DAY_MS = 24 * 60 * 60 * 1000;

const parseTimestamp = (value) => {
  if (value === null || value === undefined) return NaN;
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : NaN;
};

/**
 * 清理 RunEvent JSONL 日志：删除 recordedAt 早于 cutoffMs 的事件行。
 * 原子写（tmp + rename），与 run-event-log.service 的压缩逻辑互不破坏。
 * @returns {Promise<number>} 清除的事件行数
 */
async function purgeRunEventLog(filePath = config.observability?.runEventLogPath, cutoffMs = 0) {
  if (!filePath) return 0;
  const stat = await fs.promises.stat(filePath).catch(() => null);
  if (!stat) return 0;

  const raw = await fs.promises.readFile(filePath, 'utf8');
  const keptLines = [];
  let removed = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      const recordedAt = parseTimestamp(event?.recordedAt);
      if (Number.isFinite(recordedAt) && recordedAt < cutoffMs) {
        removed += 1;
        continue;
      }
    } catch {
      // 损坏行没有可信时间戳，保守保留，交给 run-event-log 的压缩逻辑处理
    }
    keptLines.push(line);
  }

  if (removed > 0) {
    const temporary = `${filePath}.${process.pid}.tmp`;
    await fs.promises.writeFile(temporary, keptLines.join('\n') + (keptLines.length ? '\n' : ''), { encoding: 'utf8', mode: 0o600 });
    await fs.promises.rename(temporary, filePath);
  }
  return removed;
}

/**
 * 清理过期分享快照：createdAt 早于 cutoffMs 的字段逐个 hdel。
 * @returns {Promise<number>} 清除的快照数
 */
async function purgeShareSnapshots(target = store, cutoffMs = 0) {
  const snapshots = await target.hgetall(SHARE_SNAPSHOT_KEY);
  if (!snapshots) return 0;

  let removed = 0;
  for (const [code, snapshot] of Object.entries(snapshots)) {
    const createdAt = parseTimestamp(snapshot?.createdAt);
    if (Number.isFinite(createdAt) && createdAt < cutoffMs) {
      await target.hdel(SHARE_SNAPSHOT_KEY, code);
      removed += 1;
    }
  }
  return removed;
}

/**
 * 清理过期会话：遍历 conversations:* 的每个用户 hash，
 * updatedAt 早于 cutoffMs 的会话连同全部消息一起删除。
 * @returns {Promise<number>} 清除的会话数
 */
async function purgeExpiredConversations(target = store, cutoffMs = 0) {
  const keys = typeof target.hashKeys === 'function' ? target.hashKeys(CONVERSATION_KEY_PATTERN) : [];
  if (!keys.length) return 0;

  let removed = 0;
  for (const key of keys) {
    const conversations = await target.hgetall(key);
    if (!conversations) continue;
    for (const [conversationId, conversation] of Object.entries(conversations)) {
      const updatedAt = parseTimestamp(conversation?.updatedAt) || parseTimestamp(conversation?.createdAt);
      if (Number.isFinite(updatedAt) && updatedAt < cutoffMs) {
        await target.hdel(key, conversationId);
        removed += 1;
      }
    }
  }
  return removed;
}

/**
 * 执行一轮留存清理，返回各类数据的清除数量。
 * 留存期配置为 0 的类别直接跳过。
 */
async function sweepOnce({ now = Date.now() } = {}) {
  const privacy = config.privacy || {};
  const summary = { runEvents: 0, shareSnapshots: 0, conversations: 0, changed: false };

  if ((privacy.runEventLogRetentionDays || 0) > 0) {
    const cutoff = now - privacy.runEventLogRetentionDays * DAY_MS;
    summary.runEvents = await purgeRunEventLog(config.observability?.runEventLogPath, cutoff).catch((error) => {
      logEvent('warn', 'privacy_retention_run_events_failed', { error: error.message });
      return 0;
    });
  }

  if ((privacy.shareSnapshotRetentionDays || 0) > 0) {
    const cutoff = now - privacy.shareSnapshotRetentionDays * DAY_MS;
    summary.shareSnapshots = await purgeShareSnapshots(store, cutoff).catch((error) => {
      logEvent('warn', 'privacy_retention_share_snapshots_failed', { error: error.message });
      return 0;
    });
  }

  if ((privacy.conversationRetentionDays || 0) > 0) {
    const cutoff = now - privacy.conversationRetentionDays * DAY_MS;
    summary.conversations = await purgeExpiredConversations(store, cutoff).catch((error) => {
      logEvent('warn', 'privacy_retention_conversations_failed', { error: error.message });
      return 0;
    });
  }

  summary.changed = summary.runEvents > 0 || summary.shareSnapshots > 0 || summary.conversations > 0;
  if (summary.changed) {
    logEvent('info', 'privacy_retention_swept', summary);
  }
  return summary;
}

let sweepTimer = null;

/**
 * 启动留存清理任务：启动 1 分钟后先跑一轮，之后按 sweepIntervalMs（默认每天）周期执行。
 */
function startRetentionSweeper() {
  if (sweepTimer) return;
  const intervalMs = config.privacy?.sweepIntervalMs || 24 * 60 * 60 * 1000;
  const initial = setTimeout(() => {
    void sweepOnce();
    sweepTimer = setInterval(() => { void sweepOnce(); }, intervalMs);
    sweepTimer.unref?.();
  }, 60 * 1000);
  initial.unref?.();
  sweepTimer = initial;
}

function stopRetentionSweeper() {
  if (!sweepTimer) return;
  clearTimeout(sweepTimer);
  clearInterval(sweepTimer);
  sweepTimer = null;
}

module.exports = {
  purgeRunEventLog,
  purgeShareSnapshots,
  purgeExpiredConversations,
  sweepOnce,
  startRetentionSweeper,
  stopRetentionSweeper,
};
