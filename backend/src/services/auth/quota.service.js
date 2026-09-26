"use strict";

const { redis: store } = require("../memory/memory-store.service");
const config = require("../../config");

class QuotaService {
  constructor() {
    this.cfg = config.quota || {};
  }

  _key(userId) {
    return `quota:usage:${userId || "anonymous"}`;
  }

  _today() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  _limit(userId) {
    if (userId === "admin") return Infinity; // 管理员无配额限制
    if (!userId) return this.cfg.anonymousLimit ?? 20;
    return this.cfg.dailyLimit ?? 100;
  }

  async getUsage(userId) {
    const key = this._key(userId);
    const limit = this._limit(userId);
    const today = this._today();
    const raw = await store.hgetall(key);
    const storedDate = raw?.date;
    const count = parseInt(raw?.count, 10) || 0;
    if (storedDate !== today) {
      return { used: 0, limit, remaining: limit, date: today, resetAt: today + "T23:59:59+08:00" };
    }
    return { used: count, limit, remaining: Math.max(0, limit - count), date: today, resetAt: today + "T23:59:59+08:00" };
  }

  async increment(userId) {
    const key = this._key(userId);
    const today = this._today();
    const raw = await store.hgetall(key);
    const storedDate = raw?.date;
    if (storedDate !== today) {
      await store.hset(key, { date: today, count: 1 });
      return 1;
    }
    const count = (parseInt(raw?.count, 10) || 0) + 1;
    await store.hset(key, { date: today, count });
    return count;
  }

  _usage(count, limit, date) {
    return {
      used: count,
      limit,
      remaining: limit === Infinity ? Infinity : Math.max(0, limit - count),
      date,
      resetAt: date + "T23:59:59+08:00",
    };
  }

  /**
   * 在请求执行前原子预占一个配额槽位。
   * SQLite 使用事务，Redis 使用 Lua，避免并发请求同时通过旧计数。
   */
  async reserve(userId) {
    const key = this._key(userId);
    const today = this._today();
    const limit = this._limit(userId);
    if (limit === Infinity) {
      return { ok: true, usage: this._usage(0, limit, today) };
    }

    const result = await store.reserveDailyQuota(key, today, limit);
    return { ok: result.ok, usage: this._usage(result.count, limit, today) };
  }

  async release(userId) {
    const limit = this._limit(userId);
    const today = this._today();
    if (limit === Infinity) return this._usage(0, limit, today);

    const count = await store.releaseDailyQuota(this._key(userId), today);
    return this._usage(count, limit, today);
  }

  async incrementIfAllowed(userId) {
    return this.reserve(userId);
  }

  async check(userId) {
    const usage = await this.getUsage(userId);
    return { ok: usage.remaining > 0, usage };
  }
}

module.exports = new QuotaService();
