'use strict';

const { revisionOf } = require('./evidence.service');

const SOURCE_KEY = 'campus:source-snapshots';
const USER_KEY = 'campus:users';
const MAX_SOURCE_CHARS = 200000;
const MAX_VERSIONS = 8;

function campusError(message, status = 400) {
  return Object.assign(new Error(message), { status, statusCode: status });
}

function parseRecord(raw) {
  if (raw && typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch { return null; }
}

function validateId(value, label = '标识') {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,160}$/.test(value) || ['__proto__', 'prototype', 'constructor'].includes(value)) throw campusError(`${label}无效`);
  return value;
}

function diffSnapshots(before, after) {
  if (!before) return { unavailableBaseline: true, added: [], removed: [], fields: [], truncated: false };
  const lines = text => String(text || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const subtract = (left, right) => {
    const counts = new Map();
    for (const line of right) counts.set(line, (counts.get(line) || 0) + 1);
    return left.filter(line => {
      const count = counts.get(line) || 0;
      if (count) { counts.set(line, count - 1); return false; }
      return true;
    });
  };
  const added = subtract(lines(after.text), lines(before.text));
  const removed = subtract(lines(before.text), lines(after.text));
  const changed = [...added, ...removed].join('\n');
  const fields = [
    ['时间', /截止|时间|日期|\d[月日]|\d:\d/],
    ['地点', /地点|地址|校区|场地|楼|教室/],
    ['材料', /材料|附件|复印|证件|申请表/],
    ['条件', /条件|要求|资格|年级|人数/],
    ['费用', /费用|收费|\d+元/],
  ].filter(([, pattern]) => pattern.test(changed)).map(([name]) => name);
  return {
    unavailableBaseline: false,
    added: added.slice(0, 80).map(line => line.slice(0, 1200)),
    removed: removed.slice(0, 80).map(line => line.slice(0, 1200)),
    fields, addedCount: added.length, removedCount: removed.length,
    truncated: before.truncated || after.truncated || added.length > 80 || removed.length > 80 || [...added, ...removed].some(line => line.length > 1200),
    metadataChanged: before.title !== after.title || before.scope !== after.scope || before.effectiveFrom !== after.effectiveFrom || before.effectiveUntil !== after.effectiveUntil,
  };
}

class SourceRadarService {
  constructor({ store, getEntry, clock = () => Date.now() } = {}) {
    this.store = store || require('../memory/memory-store.service').redis;
    this.getEntry = getEntry || (docId => new (require('../wiki/wiki.service').WikiService)().getEntry(docId));
    this.clock = clock;
  }

  async state(docId) {
    return parseRecord(await this.store.hget(SOURCE_KEY, validateId(docId, '来源')));
  }

  async capture(docId) {
    validateId(docId, '来源');
    for (let attempt = 0; attempt < 3; attempt++) {
      const previous = await this.state(docId);
      const entry = await this.getEntry(docId);
      const available = !!entry && entry.visible !== false && !entry.stale && entry.reviewState !== 'stale';
      const now = new Date(this.clock()).toISOString();
      const snapshot = available ? {
        docId, title: String(entry.title || '未命名来源').slice(0, 180),
        revision: String(entry.currentRevision || entry.sourceRevision || revisionOf(entry.body)),
        text: String(entry.body || '').slice(0, MAX_SOURCE_CHARS),
        truncated: String(entry.body || '').length > MAX_SOURCE_CHARS,
        sourceLabel: String(entry.sourceLabel || '').slice(0, 300),
        reviewedAt: entry.updatedAt || null, capturedAt: now,
        effectiveFrom: entry.effectiveFrom || null, effectiveUntil: entry.effectiveUntil || null,
        scope: entry.scope || null, simulated: entry.simulated === true,
      } : null;
      const versions = previous?.versions || [];
      const same = snapshot && versions[0]?.revision === snapshot.revision;
      const next = {
        docId, available, checkedAt: now,
        versions: snapshot ? (same ? [{ ...versions[0], ...snapshot }, ...versions.slice(1)] : [snapshot, ...versions].slice(0, MAX_VERSIONS)) : versions,
      };
      if (await this.store.hcompareAndSet(SOURCE_KEY, docId, previous, next)) return next;
    }
    throw campusError('来源正在更新，请稍后重新检查', 409);
  }

  async published(docId, expectedRevision) {
    const state = await this.capture(docId);
    if (!state.available) throw campusError('该来源未上架、已下架或待重新审核，暂时无法引用', 409);
    const snapshot = state.versions[0];
    if (expectedRevision && snapshot.revision !== expectedRevision) throw campusError('来源版本已变化，请查看最新原文后重新创建任务', 409);
    return snapshot;
  }

  async change(docId, baselineRevision) {
    const state = await this.state(docId);
    if (!state?.available) return { docId, available: false, changed: true, checkedAt: state?.checkedAt || null };
    const latest = state.versions[0];
    const before = state.versions.find(version => version.revision === baselineRevision);
    return {
      docId, title: latest.title, available: true, changed: baselineRevision !== latest.revision,
      revision: latest.revision, previousRevision: baselineRevision,
      checkedAt: state.checkedAt, reviewedAt: latest.reviewedAt,
      effectiveFrom: latest.effectiveFrom, effectiveUntil: latest.effectiveUntil, scope: latest.scope,
      simulated: latest.simulated,
      diff: baselineRevision !== latest.revision ? diffSnapshots(before, latest) : null,
    };
  }

  async checkAll() {
    const users = Object.values(await this.store.hgetall(USER_KEY) || {}).map(parseRecord).filter(Boolean);
    const ids = new Set(users.flatMap(user => [
      ...(user.subscriptions || []).map(item => item.docId),
      ...(user.tasks || []).filter(task => !task.archived).flatMap(task => task.sources.map(source => source.docId)),
    ]));
    let checked = 0;
    let failed = 0;
    for (const docId of ids) {
      try { await this.capture(docId); checked++; } catch { failed++; }
    }
    if (failed) throw campusError(`部分来源检查失败（${failed}），后台将重试`, 503);
    return { checked };
  }
}

let radar;
const getSourceRadar = () => (radar ||= new SourceRadarService());

module.exports = { SourceRadarService, getSourceRadar, SOURCE_KEY, USER_KEY, campusError, parseRecord, validateId, diffSnapshots };
