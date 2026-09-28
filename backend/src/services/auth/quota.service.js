"use strict";

const crypto = require("crypto");

const { redis: store } = require("../memory/memory-store.service");
const config = require("../../config");

const ANONYMOUS_SUBJECT = "anonymous";

/**
 * 匿名用户分桶标识。
 *
 * 改动前所有未登录用户共用一个 `quota:usage:anonymous` 桶（每日 20 次），
 * 任意一台机器就能把全站匿名配额耗尽。这里改为按客户端 IP 分桶。
 * 存的不是原始 IP 而是加盐哈希的前 16 位：配额 key 会落到 SQLite/Redis
 * 里，避免明文 IP 进入持久化存储（隐私留存清理也不覆盖这块）。
 */
function anonymousSubject(clientIp) {
  const raw = String(clientIp || "").trim();
  if (!raw) return ANONYMOUS_SUBJECT;
  const digest = crypto.createHash("sha256").update(`anon:${raw}`).digest("hex");
  return `ip:${digest.slice(0, 16)}`;
}

class QuotaService {
  constructor() {
    this.cfg = config.quota || {};
  }

  /**
   * @param {string} userId 登录用户 id；为空表示匿名
   * @param {string} [clientIp] 客户端 IP，仅匿名请求用于分桶
   */
  _key(userId, clientIp) {
    return `quota:usage:${userId || anonymousSubject(clientIp)}`;
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

  async getUsage(userId, clientIp) {
    const key = this._key(userId, clientIp);
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

  async increment(userId, clientIp) {
    const key = this._key(userId, clientIp);
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
  async reserve(userId, clientIp) {
    const key = this._key(userId, clientIp);
    const today = this._today();
    const limit = this._limit(userId);
    if (limit === Infinity) {
      return { ok: true, usage: this._usage(0, limit, today) };
    }

    const result = await store.reserveDailyQuota(key, today, limit);
    return { ok: result.ok, usage: this._usage(result.count, limit, today) };
  }

  async release(userId, clientIp) {
    const limit = this._limit(userId);
    const today = this._today();
    if (limit === Infinity) return this._usage(0, limit, today);

    const count = await store.releaseDailyQuota(this._key(userId, clientIp), today);
    return this._usage(count, limit, today);
  }

  async incrementIfAllowed(userId, clientIp) {
    return this.reserve(userId, clientIp);
  }

  async check(userId, clientIp) {
    const usage = await this.getUsage(userId, clientIp);
    return { ok: usage.remaining > 0, usage };
  }
}

module.exports = new QuotaService();
