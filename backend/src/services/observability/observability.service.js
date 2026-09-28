"use strict";

const crypto = require('crypto');
const { isSensitiveKey } = require('../../utils/sensitive-keys');

function createTraceId(prefix = 'req') {
  const id = typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : crypto.randomBytes(16).toString('hex');
  return `${prefix}_${id}`;
}

function createRunId() {
  return createTraceId('run');
}

function sanitizeTraceId(value) {
  const traceId = String(value || '').trim();
  if (!traceId || traceId.length > 128) return null;
  return /^[a-zA-Z0-9_.:-]+$/.test(traceId) ? traceId : null;
}

function truncateText(value, maxLength = 300) {
  if (value === undefined || value === null) return '';
  const text = String(value);
  return text.length > maxLength ? `${text.substring(0, maxLength)}...` : text;
}

function sanitizeError(err) {
  const message = err?.message || err || '';
  return truncateText(String(message).replace(/https?:\/\/[^\s]+/g, '[url]'), 300);
}

function sanitizeValue(value, maxLength = 300) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return truncateText(value, maxLength);
  if (Array.isArray(value)) return value.slice(0, 20).map(item => sanitizeValue(item, 120));
  if (typeof value === 'object') {
    const sanitized = {};
    for (const [key, item] of Object.entries(value)) {
      // 敏感键策略与 run-event-log 回放共用同一份（utils/sensitive-keys.js），
      // 此前两处正则漂移导致同一字段日志里隐藏、回放里明文
      if (isSensitiveKey(key)) continue;
      sanitized[key] = sanitizeValue(item, 120);
    }
    return sanitized;
  }
  return truncateText(String(value), maxLength);
}

function compactPayload(payload = {}) {
  const result = {};
  for (const [key, value] of Object.entries(payload)) {
    const sanitized = sanitizeValue(value);
    if (sanitized !== undefined) result[key] = sanitized;
  }
  return result;
}

function logEvent(level, event, payload = {}) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    event,
    ...compactPayload(payload),
  };

  const line = `[Observability] ${JSON.stringify(entry)}`;
  if (level === 'error') return console.error(line);
  if (level === 'warn') return console.warn(line);
  return console.log(line);
}

module.exports = {
  compactPayload,
  createRunId,
  createTraceId,
  logEvent,
  sanitizeError,
  sanitizeTraceId,
  truncateText,
};
