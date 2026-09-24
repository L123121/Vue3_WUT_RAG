'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../config');

const RUN_ID_RE = /^run_[a-zA-Z0-9_.:-]{8,160}$/;
const sanitizeRunId = (value) => {
  const runId = String(value || '').trim();
  return RUN_ID_RE.test(runId) ? runId : '';
};

const sanitizeValue = (value, depth = 0) => {
  if (depth > 4) return '[nested]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return value.length > 8000 ? `${value.slice(0, 8000)}…` : value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => sanitizeValue(item, depth + 1));
  if (typeof value === 'object') {
    const result = {};
    for (const [key, item] of Object.entries(value)) {
      if (/token|secret|password|cookie|authorization|api.?key/i.test(key)) continue;
      result[key] = sanitizeValue(item, depth + 1);
    }
    return result;
  }
  return String(value).slice(0, 300);
};

const getDefaultOptions = () => ({
  enabled: config.observability?.runEventLogEnabled === true,
  includeContent: config.observability?.runEventLogIncludeContent === true,
  filePath: config.observability?.runEventLogPath || path.join(__dirname, '..', '..', 'data', 'run-events.jsonl'),
  maxBytes: config.observability?.runEventLogMaxBytes || 32 * 1024 * 1024,
  maxRuns: config.observability?.runEventLogMaxRuns || 500,
  maxEventsPerRun: config.observability?.runEventLogMaxEventsPerRun || 1000,
});

const normalizeEvent = (event, options = {}) => {
  const type = String(event?.type || '').slice(0, 120);
  const data = sanitizeValue(event?.data && typeof event.data === 'object' ? event.data : {});
  if (type === 'message.delta' && options.includeContent !== true && typeof data.content === 'string') {
    data.contentLength = data.content.length;
    data.content = '';
    data.contentOmitted = true;
  }
  return {
    v: 1,
    runId: sanitizeRunId(event?.runId),
    attempt: Number.isInteger(event?.attempt) ? event.attempt : 0,
    seq: Number.isInteger(event?.seq) ? event.seq : 0,
    type,
    traceId: String(event?.traceId || '').slice(0, 160),
    data,
    recordedAt: new Date().toISOString(),
  };
};

const parseLines = (raw) => String(raw || '').split('\n').filter(Boolean).map((line) => {
  try { return JSON.parse(line); } catch { return null; }
}).filter((event) => event && sanitizeRunId(event.runId));

const ensurePrivateDir = async (filePath) => {
  const directory = path.dirname(path.resolve(filePath));
  await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.promises.chmod(directory, 0o700).catch(() => {});
};

const createRunEventLog = (overrides = {}) => {
  const options = { ...getDefaultOptions(), ...overrides };
  const pending = [];
  let flushTimer = null;
  let activeFlush = null;

  const compactFile = async () => {
    const stat = await fs.promises.stat(options.filePath).catch(() => null);
    if (!stat || stat.size <= options.maxBytes) return;
    const events = parseLines(await fs.promises.readFile(options.filePath, 'utf8'));
    const runIds = new Set();
    const counts = new Map();
    const kept = [];
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (!runIds.has(event.runId) && runIds.size >= options.maxRuns) continue;
      runIds.add(event.runId);
      const count = counts.get(event.runId) || 0;
      if (count >= options.maxEventsPerRun) continue;
      counts.set(event.runId, count + 1);
      kept.push(event);
    }
    kept.reverse();
    const temporary = `${options.filePath}.${process.pid}.tmp`;
    await fs.promises.writeFile(temporary, kept.map((event) => JSON.stringify(event)).join('\n') + (kept.length ? '\n' : ''), { encoding: 'utf8', mode: 0o600 });
    await fs.promises.rename(temporary, options.filePath);
    await fs.promises.chmod(options.filePath, 0o600).catch(() => {});
  };

  const flushQueue = async () => {
    if (activeFlush) return activeFlush;
    activeFlush = (async () => {
      while (pending.length) {
        const batch = pending.splice(0, pending.length);
        try {
          await ensurePrivateDir(options.filePath);
          await fs.promises.appendFile(
            options.filePath,
            `${batch.map((item) => JSON.stringify(item.event)).join('\n')}\n`,
            { encoding: 'utf8', mode: 0o600 },
          );
          await fs.promises.chmod(options.filePath, 0o600).catch(() => {});
          await compactFile();
          batch.forEach((item) => item.resolve(true));
        } catch {
          batch.forEach((item) => item.resolve(false));
        }
      }
    })();
    try {
      await activeFlush;
    } finally {
      activeFlush = null;
      if (pending.length) scheduleFlush();
    }
    return true;
  };

  const scheduleFlush = () => {
    if (flushTimer || activeFlush) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void flushQueue();
    }, 0);
    flushTimer.unref?.();
  };

  const record = (event) => {
    if (!options.enabled) return Promise.resolve(false);
    const normalized = normalizeEvent(event, options);
    if (!normalized.runId || !normalized.type) return Promise.resolve(false);
    return new Promise((resolve) => {
      pending.push({ event: normalized, resolve });
      scheduleFlush();
    });
  };

  const read = async (runId) => {
    const normalizedRunId = sanitizeRunId(runId);
    if (!normalizedRunId || !options.enabled) return [];
    await flushQueue();
    const raw = await fs.promises.readFile(options.filePath, 'utf8').catch(() => '');
    return parseLines(raw).filter((event) => event.runId === normalizedRunId)
      .sort((a, b) => (a.attempt - b.attempt) || (a.seq - b.seq));
  };

  return { record, read, options };
};

const defaultLog = createRunEventLog();

module.exports = {
  createRunEventLog,
  normalizeEvent,
  normalizeRunId: sanitizeRunId,
  recordRunEvent: (event) => defaultLog.record(event),
  readRunEvents: (runId) => defaultLog.read(runId),
};
