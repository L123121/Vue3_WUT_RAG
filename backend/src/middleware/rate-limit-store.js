"use strict";

const { MemoryStore } = require('express-rate-limit');
const { getRedisRuntime } = require('../services/runtime/redis-runtime.service');
const { logEvent } = require('../services/observability/observability.service');

// INCR + 首次命中设置窗口过期，原子执行；返回 [命中数, 剩余毫秒]
const INCREMENT_SCRIPT = `
local hits = redis.call('INCR', KEYS[1])
if hits == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then redis.call('PEXPIRE', KEYS[1], ARGV[1]); ttl = tonumber(ARGV[1]) end
return {hits, ttl}
`;

/**
 * 多实例共享的限流计数（express-rate-limit Store 接口）。
 * Redis 出错时退回本实例内存计数：限流退化为"每实例各自限流"，既不放开也不误拦。
 */
class RedisRateLimitStore {
  constructor({ prefix, redis = getRedisRuntime() } = {}) {
    this.prefix = `wut:rl:${prefix}:`;
    this.redis = redis;
    this.localKeys = false;
    this.fallback = new MemoryStore();
    this.windowMs = 60000;
    this._lastWarnAt = 0;
  }

  init(options) {
    this.windowMs = options.windowMs;
    this.fallback.init(options);
  }

  _warn(error) {
    if (Date.now() - this._lastWarnAt < 60000) return;
    this._lastWarnAt = Date.now();
    logEvent('warn', 'rate_limit_redis_fallback', { prefix: this.prefix, error: error.message });
  }

  async increment(key) {
    try {
      const [hits, ttl] = await this.redis.command('EVAL', INCREMENT_SCRIPT, 1, this.prefix + key, this.windowMs);
      return { totalHits: Number(hits), resetTime: new Date(Date.now() + Number(ttl)) };
    } catch (error) {
      this._warn(error);
      return this.fallback.increment(key);
    }
  }

  async decrement(key) {
    try {
      await this.redis.command('DECR', this.prefix + key);
    } catch (error) {
      this._warn(error);
      await this.fallback.decrement(key);
    }
  }

  async resetKey(key) {
    await this.fallback.resetKey(key);
    try {
      await this.redis.command('DEL', this.prefix + key);
    } catch (error) {
      this._warn(error);
    }
  }

  shutdown() {
    this.fallback.shutdown?.();
  }
}

/** 展开进 rateLimit 选项；Redis 未配置时为空对象，沿用默认内存存储（单机行为不变） */
function sharedStoreOption(prefix) {
  const redis = getRedisRuntime();
  return redis.enabled ? { store: new RedisRateLimitStore({ prefix, redis }) } : {};
}

module.exports = { RedisRateLimitStore, sharedStoreOption };
