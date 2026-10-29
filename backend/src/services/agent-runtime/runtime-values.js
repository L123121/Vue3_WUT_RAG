'use strict';

const crypto = require('crypto');
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const LIMITS = Object.freeze({ steps: 12, attempts: 3, calls: 36, resumes: 6, events: 480, resultBytes: 32768, lifetimeMs: 7 * 86400000 });
const TERMINAL = new Set(['completed', 'cancelled', 'expired']);

function runtimeError(message, code = 'INVALID_REQUEST', status = 400) {
  return Object.assign(new Error(message), { code, status, statusCode: status });
}
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
const digest = value => crypto.createHash('sha256').update(stable(value)).digest('hex');
const copy = value => JSON.parse(JSON.stringify(value));
function identifier(value, label = '标识') {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,160}$/.test(value) || FORBIDDEN_KEYS.has(value)) throw runtimeError(`${label}无效`);
  return value;
}
function shortText(value, max, label, optional = false) {
  if (optional && (value === undefined || value === null)) return '';
  if (typeof value !== 'string' || value.length > max || (!optional && !value.trim())) throw runtimeError(`${label}必须为不超过 ${max} 字的文本`);
  return value.trim();
}
function safeJson(value, depth = 0) {
  if (depth > 10) throw runtimeError('数据嵌套过深');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (Array.isArray(value)) {
    if (value.length > 80) throw runtimeError('数组过长');
    value.forEach(item => safeJson(item, depth + 1));
    return;
  }
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const keys = Object.keys(value);
    if (keys.length > 40) throw runtimeError('对象字段过多');
    for (const key of keys) {
      if (FORBIDDEN_KEYS.has(key)) throw runtimeError('包含禁止的属性名');
      safeJson(value[key], depth + 1);
    }
    return;
  }
  throw runtimeError('只允许有限的 JSON 数据');
}
function references(value, found = []) {
  if (!value || typeof value !== 'object') return found;
  if (Object.hasOwn(value, '$from')) {
    if (Object.keys(value).some(key => !['$from', 'path'].includes(key))) throw runtimeError('结果引用包含未知字段');
    identifier(value.$from, '依赖节点');
    if (!Array.isArray(value.path) || value.path.length > 8 || value.path.some(key => (typeof key !== 'string' && !Number.isInteger(key)) || FORBIDDEN_KEYS.has(String(key)) || String(key).length > 80)) throw runtimeError('结果引用路径无效');
    found.push(value.$from);
  } else Object.values(value).forEach(item => references(item, found));
  return found;
}
function resolveInput(value, steps) {
  if (!value || typeof value !== 'object') return value;
  if (Object.hasOwn(value, '$from')) {
    const source = steps.find(step => step.id === value.$from);
    if (!source || source.status !== 'succeeded') throw runtimeError('依赖结果尚未完成', 'DEPENDENCY_UNAVAILABLE', 409);
    let result = source.result;
    for (const key of value.path) {
      if (result == null || !Object.hasOwn(result, key) || FORBIDDEN_KEYS.has(String(key))) throw runtimeError('依赖结果中没有指定字段', 'DEPENDENCY_VALUE_MISSING', 409);
      result = result[key];
    }
    return copy(result);
  }
  if (Array.isArray(value)) return value.map(item => resolveInput(item, steps));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveInput(item, steps)]));
}
function publicStep(step) {
  const { id, label, tool, toolVersion, input, dependsOn, notBefore, status, attempts, result, resultHash, error, approval, durationMs, retryAt } = step;
  return { id, label, tool, toolVersion, input, dependsOn, notBefore, status, attempts, result, resultHash, error, approval, durationMs, retryAt };
}
function runHeader(run) {
  return {
    id: run.id, title: run.title, goal: run.goal, status: run.status, version: run.version,
    planVersion: run.planVersion, planHash: run.planHash, createdAt: run.createdAt, updatedAt: run.updatedAt,
    expiresAt: run.expiresAt, availableAt: run.availableAt, calls: run.calls, maxCalls: run.maxCalls,
    resumes: run.resumes, error: run.error || null, checkpointSeq: run.checkpointSeq || 0,
  };
}
const publicRun = run => ({ ...runHeader(run), steps: run.steps.map(publicStep) });
function event(run, type, changedSteps = [], details = {}, now = Date.now()) {
  if (run.events.length >= LIMITS.events) throw runtimeError('执行事件已达上限，请新建计划', 'EVENT_LIMIT', 409);
  run.updatedAt = now;
  run.version++;
  const seq = (run.events.at(-1)?.seq || 0) + 1;
  if (type === 'step.succeeded') run.checkpointSeq = seq;
  run.events.push({ seq, type, at: now, details, patch: { run: runHeader(run), steps: changedSteps.map(publicStep).map(copy) } });
}
function replay(events, through = Infinity) {
  let state = null;
  for (const item of events) {
    if (item.seq > through) break;
    state = { ...(state || { steps: [] }), ...item.patch.run };
    if (item.type === 'plan.updated') state.steps = [];
    for (const step of item.patch.steps) {
      const index = state.steps.findIndex(previous => previous.id === step.id);
      if (index < 0) state.steps.push(copy(step));
      else state.steps[index] = copy(step);
    }
  }
  return state;
}

module.exports = { LIMITS, TERMINAL, runtimeError, stable, digest, copy, identifier, shortText, safeJson, references, resolveInput, publicStep, publicRun, runHeader, event, replay };
