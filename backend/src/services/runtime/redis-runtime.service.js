'use strict';

/**
 * RedisRuntime — 可选的共享运行时协调层。
 *
 * 本阶段不把业务数据迁到 Redis：SQLite 仍是 Job 的事实来源；Redis 只承担
 * 多实例通知、健康探测和短租约协调。未配置 REDIS_URL 时完全禁用，单机行为不变。
 * 使用 Node 内置 net 实现最小 RESP 客户端，避免为这一过渡层额外引入队列框架。
 */

const net = require('net');
const crypto = require('crypto');
const config = require('../../config');
const { logEvent } = require('../observability/observability.service');

const DEFAULT_TIMEOUT_MS = 1500;
let singleton = null;

function parseRedisUrl(value) {
  if (!value) return null;
  const parsed = new URL(value);
  if (!['redis:', 'rediss:'].includes(parsed.protocol)) throw new Error('REDIS_URL 必须使用 redis:// 或 rediss:// 协议');
  return {
    host: parsed.hostname,
    port: Number(parsed.port || 6379),
    username: parsed.username ? decodeURIComponent(parsed.username) : '',
    password: parsed.password ? decodeURIComponent(parsed.password) : '',
    database: Number.parseInt(parsed.pathname.replace(/^\//, '') || '0', 10) || 0,
    tls: parsed.protocol === 'rediss:',
  };
}

function encodeCommand(parts) {
  const values = parts.map((part) => Buffer.from(String(part)));
  return Buffer.concat([
    Buffer.from(`*${values.length}\r\n`),
    ...values.flatMap((value) => [Buffer.from(`$${value.length}\r\n`), value, Buffer.from('\r\n')]),
  ]);
}

function parseResp(buffer, offset = 0) {
  if (offset >= buffer.length) return null;
  const type = String.fromCharCode(buffer[offset]);
  const lineEnd = buffer.indexOf('\r\n', offset);
  if (lineEnd === -1) return null;
  const line = buffer.slice(offset + 1, lineEnd).toString('utf8');
  const next = lineEnd + 2;
  if (type === '+' || type === ':') return { value: type === ':' ? Number(line) : line, next };
  if (type === '-') throw new Error(`Redis: ${line}`);
  if (type === '$') {
    const length = Number(line);
    if (length === -1) return { value: null, next };
    if (buffer.length < next + length + 2) return null;
    return { value: buffer.slice(next, next + length).toString('utf8'), next: next + length + 2 };
  }
  if (type === '*') {
    const count = Number(line);
    if (count === -1) return { value: null, next };
    const values = [];
    let cursor = next;
    for (let index = 0; index < count; index += 1) {
      const parsed = parseResp(buffer, cursor);
      if (!parsed) return null;
      values.push(parsed.value);
      cursor = parsed.next;
    }
    return { value: values, next: cursor };
  }
  throw new Error(`Redis: 未知 RESP 类型 ${type}`);
}

class RedisRuntime {
  constructor(options = {}) {
    this.url = options.url ?? config.redis?.url ?? '';
    this.timeoutMs = options.timeoutMs ?? config.redis?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.channel = options.channel ?? config.redis?.jobsChannel ?? 'wut:jobs:available';
    this.connection = this.url ? parseRedisUrl(this.url) : null;
    this._health = this.connection
      ? { status: 'starting', enabled: true, lastCheckedAt: null, lastError: null }
      : { status: 'disabled', enabled: false, lastCheckedAt: null, lastError: null };
  }

  get enabled() {
    return Boolean(this.connection);
  }

  getHealth() {
    return { ...this._health };
  }

  async command(...parts) {
    if (!this.connection) throw new Error('Redis 未配置');
    const { host, port, username, password, database, tls } = this.connection;
    const socket = tls ? require('tls').connect({ host, port }) : net.createConnection({ host, port });
    const commands = [];
    if (password) commands.push(username ? ['AUTH', username, password] : ['AUTH', password]);
    if (database) commands.push(['SELECT', database]);
    commands.push(parts);
    const request = Buffer.concat(commands.map(encodeCommand));

    return new Promise((resolve, reject) => {
      let response = Buffer.alloc(0);
      let commandIndex = 0;
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`Redis 请求超时（${this.timeoutMs}ms）`));
      }, this.timeoutMs);
      const finish = (error, value) => {
        clearTimeout(timer);
        socket.destroy();
        if (error) reject(error);
        else resolve(value);
      };
      socket.once('error', (error) => finish(error));
      socket.on('data', (chunk) => {
        response = Buffer.concat([response, chunk]);
        try {
          let cursor = 0;
          let result = null;
          while (commandIndex < commands.length) {
            const parsed = parseResp(response, cursor);
            if (!parsed) return;
            result = parsed.value;
            cursor = parsed.next;
            commandIndex += 1;
          }
          finish(null, result);
        } catch (error) {
          finish(error);
        }
      });
      socket.once('connect', () => socket.write(request));
    });
  }

  async probe() {
    if (!this.enabled) return this.getHealth();
    try {
      const pong = await this.command('PING');
      if (pong !== 'PONG') throw new Error(`Redis PING 返回异常: ${pong}`);
      this._health = { status: 'ready', enabled: true, lastCheckedAt: new Date().toISOString(), lastError: null };
    } catch (error) {
      this._health = { status: 'unavailable', enabled: true, lastCheckedAt: new Date().toISOString(), lastError: error.message };
      logEvent('warn', 'redis_runtime_probe_failed', { error: error.message });
    }
    return this.getHealth();
  }

  async notifyJobsAvailable(data = {}) {
    if (!this.enabled) return false;
    try {
      await this.command('PUBLISH', this.channel, JSON.stringify({ ...data, at: Date.now() }));
      return true;
    } catch (error) {
      this._health = { ...this._health, status: 'unavailable', lastCheckedAt: new Date().toISOString(), lastError: error.message };
      logEvent('warn', 'redis_job_notify_failed', { error: error.message });
      return false;
    }
  }

  async withLease(key, fn, { ttlMs = 30000 } = {}) {
    if (!this.enabled) {
      return {
        acquired: true,
        distributed: false,
        value: await fn({ acquired: true, distributed: false }),
      };
    }
    const token = crypto.randomBytes(16).toString('hex');
    let acquired = false;
    try {
      acquired = await this.command('SET', key, token, 'NX', 'PX', Math.max(ttlMs, 1000)) === 'OK';
      if (!acquired) return { acquired: false, distributed: true, value: null };
      const value = await fn({ acquired: true, distributed: true });
      return { acquired: true, distributed: true, value };
    } finally {
      if (acquired) {
        try {
          await this.command('EVAL', 'if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) else return 0 end', 1, key, token);
        } catch (error) {
          logEvent('warn', 'redis_lease_release_failed', { key, error: error.message });
        }
      }
    }
  }
}

function getRedisRuntime(options) {
  if (options) return new RedisRuntime(options);
  if (!singleton) singleton = new RedisRuntime();
  return singleton;
}

module.exports = { RedisRuntime, getRedisRuntime, parseRedisUrl, encodeCommand, parseResp };
