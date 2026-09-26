"use strict";

const { logEvent } = require('../observability/observability.service');

const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, '../../data');
const DB_FILE = path.join(DATA_DIR, 'store.db');
const LEGACY_FILE = path.join(DATA_DIR, 'store.json');

/**
 * SQLiteStore — 基于 better-sqlite3 的持久化存储（唯一实现）
 *
 * 提供 hash / set / list 三种数据结构的 Redis 风格接口，数据即时持久化（无需 debounce save）。
 */
class SQLiteStore {
  constructor() {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }

    const exists = fs.existsSync(DB_FILE);
    const Database = require('better-sqlite3');
    this._db = new Database(DB_FILE);

    // WAL 模式：读不阻塞写，性能好
    this._db.pragma('journal_mode = WAL');
    this._db.pragma('synchronous = NORMAL');
    this._db.pragma('foreign_keys = ON');

    this._initSchema();

    // 预编译常用 statement
    this._stmt = {
      // set
      sadd: this._db.prepare('INSERT OR IGNORE INTO sets (key, member) VALUES (?, ?)'),
      srem: this._db.prepare('DELETE FROM sets WHERE key = ? AND member = ?'),
      smembers: this._db.prepare('SELECT member FROM sets WHERE key = ? ORDER BY rowid'),
      scard: this._db.prepare('SELECT COUNT(*) AS cnt FROM sets WHERE key = ?'),
      sismember: this._db.prepare('SELECT 1 FROM sets WHERE key = ? AND member = ?'),
      // hash
      hset: this._db.prepare(
        'INSERT INTO hash (key, field, value) VALUES (?, ?, ?) ' +
        'ON CONFLICT(key, field) DO UPDATE SET value = excluded.value'
      ),
      hgetall: this._db.prepare('SELECT field, value FROM hash WHERE key = ? ORDER BY rowid'),
      hget: this._db.prepare('SELECT value FROM hash WHERE key = ? AND field = ?'),
      hdel: this._db.prepare('DELETE FROM hash WHERE key = ? AND field = ?'),
      hdelAll: this._db.prepare('DELETE FROM hash WHERE key = ?'),
      // list
      rpush: this._db.prepare('INSERT INTO list (key, idx, value) VALUES (?, ?, ?)'),
      lrange: this._db.prepare('SELECT value FROM list WHERE key = ? AND idx >= ? AND idx <= ? ORDER BY idx'),
      llen: this._db.prepare('SELECT COUNT(*) AS cnt FROM list WHERE key = ?'),
      ltrimBefore: this._db.prepare('DELETE FROM list WHERE key = ? AND idx < ?'),
      ltrimRange: this._db.prepare('DELETE FROM list WHERE key = ? AND (idx < ? OR idx > ?)'),
      maxIdx: this._db.prepare('SELECT COALESCE(MAX(idx), -1) AS m FROM list WHERE key = ?'),
      // 通用
      delHash: this._db.prepare('DELETE FROM hash WHERE key = ?'),
      delSet: this._db.prepare('DELETE FROM sets WHERE key = ?'),
      delList: this._db.prepare('DELETE FROM list WHERE key = ?'),
    };

    // 首次启动时从旧 store.json 迁移
    if (!exists && fs.existsSync(LEGACY_FILE)) {
      this._migrateFromLegacy(LEGACY_FILE);
    }
  }

  _initSchema() {
    this._db.exec(`
      CREATE TABLE IF NOT EXISTS hash (
        key   TEXT NOT NULL,
        field TEXT NOT NULL,
        value TEXT,
        PRIMARY KEY (key, field)
      );
      CREATE TABLE IF NOT EXISTS sets (
        key    TEXT NOT NULL,
        member TEXT NOT NULL,
        PRIMARY KEY (key, member)
      );
      CREATE TABLE IF NOT EXISTS list (
        key   TEXT NOT NULL,
        idx   INTEGER NOT NULL,
        value TEXT,
        PRIMARY KEY (key, idx)
      );
    `);
  }

  _migrateFromLegacy(filePath) {
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const json = JSON.parse(raw);
      const { _data, _sets } = json;
      if (!_data && !_sets) return;

      const tx = this._db.transaction(() => {
        let count = 0;
        if (_data) {
          for (const [key, obj] of Object.entries(_data)) {
            if (typeof obj !== 'object' || obj === null) continue;
            for (const [field, value] of Object.entries(obj)) {
              const val = typeof value === 'object' ? JSON.stringify(value) : String(value);
              this._stmt.hset.run(key, field, val);
              count++;
            }
          }
        }
        if (_sets) {
          for (const [key, members] of Object.entries(_sets)) {
            if (!Array.isArray(members)) continue;
            for (const member of members) {
              this._stmt.sadd.run(key, String(member));
            }
          }
        }
        return count;
      });
      const count = tx();
      logEvent('info', 'store_migration_done', { count });
    } catch (e) {
      logEvent('warn', 'store_migration_failed', { message: '迁移旧数据失败（可忽略）', error: e.message });
    }
  }

  // ==================== Set 操作 ====================

  async sadd(key, value) {
    return this._stmt.sadd.run(key, String(value)).changes;
  }

  async srem(key, value) {
    return this._stmt.srem.run(key, String(value)).changes;
  }

  async smembers(key) {
    return this._stmt.smembers.all(key).map(r => r.member);
  }

  async scard(key) {
    return this._stmt.scard.get(key).cnt;
  }

  async sismember(key, value) {
    return !!this._stmt.sismember.get(key, String(value));
  }

  // ==================== Hash 操作 ====================

  async hset(key, ...args) {
    let obj;
    if (args.length === 1 && typeof args[0] === 'object') {
      obj = args[0];
    } else {
      obj = {};
      for (let i = 0; i < args.length; i += 2) {
        obj[args[i]] = args[i + 1];
      }
    }
    const tx = this._db.transaction(() => {
      let changes = 0;
      for (const [field, value] of Object.entries(obj)) {
        const val = typeof value === 'object' ? JSON.stringify(value) : String(value);
        changes += this._stmt.hset.run(key, field, val).changes;
      }
      return changes;
    });
    return tx();
  }

  async hgetall(key) {
    const rows = this._stmt.hgetall.all(key);
    if (rows.length === 0) return null;
    const obj = {};
    for (const r of rows) {
      obj[r.field] = this._tryParse(r.value);
    }
    return obj;
  }

  /**
   * 同步读取整个 hash（供需要原子读-改-写的场景）。
   * better-sqlite3 为同步 API，在 Node 单线程内调用时不会让出执行权，
   * 配合 hsetSync 可实现无竞态的计数操作。
   */
  hgetallSync(key) {
    const rows = this._stmt.hgetall.all(key);
    if (rows.length === 0) return null;
    const obj = {};
    for (const r of rows) {
      obj[r.field] = this._tryParse(r.value);
    }
    return obj;
  }

  /**
   * 同步写入 hash 字段（配合 hgetallSync 使用）
   */
  hsetSync(key, field, value) {
    const val = typeof value === 'object' ? JSON.stringify(value) : String(value);
    return this._stmt.hset.run(key, field, val).changes;
  }

  async reserveDailyQuota(key, date, limit) {
    const reserve = this._db.transaction(() => {
      const raw = this.hgetallSync(key);
      const current = raw?.date === date ? (parseInt(raw.count, 10) || 0) : 0;
      if (current >= limit) return { ok: false, count: current };

      const count = current + 1;
      this.hsetSync(key, 'date', date);
      this.hsetSync(key, 'count', count);
      return { ok: true, count };
    });

    return reserve();
  }

  async releaseDailyQuota(key, date) {
    const release = this._db.transaction(() => {
      const raw = this.hgetallSync(key);
      if (raw?.date !== date) return 0;

      const current = parseInt(raw.count, 10) || 0;
      const count = Math.max(0, current - 1);
      this.hsetSync(key, 'count', count);
      return count;
    });

    return release();
  }

  async hget(key, field) {
    const row = this._stmt.hget.get(key, field);
    return row ? this._tryParse(row.value) : null;
  }

  async hdel(key, field) {
    return this._stmt.hdel.run(key, field).changes;
  }

  // ==================== List 操作 ====================

  async rpush(key, value) {
    const { m } = this._stmt.maxIdx.get(key);
    this._stmt.rpush.run(key, m + 1, String(value));
    return m + 2; // 返回新长度
  }

  /**
   * 将 Redis 风格区间（支持负索引，-1 表示末尾）规范化为 [start, end] 正索引。
   * 区间为空时返回 null。
   */
  _normalizeRange(len, start, end) {
    if (len <= 0) return null;
    const toPos = (i) => (i < 0 ? Math.max(len + i, 0) : i);
    const s = toPos(start);
    if (s >= len) return null;
    const e = Math.min(end === -1 ? len - 1 : toPos(end), len - 1);
    if (s > e) return null;
    return [s, e];
  }

  async lrange(key, start, end) {
    const len = await this.llen(key);
    const range = this._normalizeRange(len, start, end);
    if (!range) return [];
    return this._stmt.lrange.all(key, range[0], range[1]).map(r => r.value);
  }

  async llen(key) {
    return this._stmt.llen.get(key).cnt;
  }

  async ltrim(key, start, end) {
    const len = await this.llen(key);
    const range = this._normalizeRange(len, start, end);
    if (!range) {
      this._stmt.delList.run(key); // 区间为空：清空整个列表
      return;
    }
    this._stmt.ltrimRange.run(key, range[0], range[1]);
  }

  // ==================== 通用 ====================

  async del(key) {
    let c = 0;
    c += this._stmt.delHash.run(key).changes;
    c += this._stmt.delSet.run(key).changes;
    c += this._stmt.delList.run(key).changes;
    return c;
  }

  async expire() { /* SQLite 不需要 TTL */ }

  // ==================== Pipeline ====================

  pipeline() {
    const ops = [];
    const self = this;
    return {
      sadd: (k, v) => ops.push(['sadd', [k, v]]),
      srem: (k, v) => ops.push(['srem', [k, v]]),
      smembers: (k) => ops.push(['smembers', [k]]),
      scard: (k) => ops.push(['scard', [k]]),
      hset: (k, ...args) => ops.push(['hset', [k, ...args]]),
      hdel: (k, f) => ops.push(['hdel', [k, f]]),
      hgetall: (k) => ops.push(['hgetall', [k]]),
      hget: (k, f) => ops.push(['hget', [k, f]]),
      rpush: (k, v) => ops.push(['rpush', [k, v]]),
      lrange: (k, start, end) => ops.push(['lrange', [k, start, end]]),
      llen: (k) => ops.push(['llen', [k]]),
      ltrim: (k, start, end) => ops.push(['ltrim', [k, start, end]]),
      del: (k) => ops.push(['del', [k]]),
      expire: () => {},
      exec: async () => {
        const results = [];
        const tx = self._db.transaction(() => {
          for (const [cmd, args] of ops) {
            try {
              const method = self['_' + cmd];
              if (method) {
                results.push([null, method.apply(self, args)]);
              }
            } catch (e) {
              results.push([e, null]);
            }
          }
        });
        tx();
        return results;
      },
    };
  }

  // ==================== 内部同步实现（供 pipeline 使用） ====================

  _sadd(key, value) { return this._stmt.sadd.run(key, String(value)).changes; }
  _srem(key, value) { return this._stmt.srem.run(key, String(value)).changes; }
  _smembers(key) { return this._stmt.smembers.all(key).map(r => r.member); }
  _scard(key) { return this._stmt.scard.get(key).cnt; }

  _hset(key, ...args) {
    let obj;
    if (args.length === 1 && typeof args[0] === 'object') {
      obj = args[0];
    } else {
      obj = {};
      for (let i = 0; i < args.length; i += 2) obj[args[i]] = args[i + 1];
    }
    let changes = 0;
    for (const [field, value] of Object.entries(obj)) {
      const val = typeof value === 'object' ? JSON.stringify(value) : String(value);
      changes += this._stmt.hset.run(key, field, val).changes;
    }
    return changes;
  }

  _hgetall(key) {
    const rows = this._stmt.hgetall.all(key);
    if (rows.length === 0) return null;
    const obj = {};
    for (const r of rows) obj[r.field] = this._tryParse(r.value);
    return obj;
  }

  _hget(key, field) {
    const row = this._stmt.hget.get(key, field);
    return row ? this._tryParse(row.value) : null;
  }

  _hdel(key, field) { return this._stmt.hdel.run(key, field).changes; }

  _del(key) {
    let c = 0;
    c += this._stmt.delHash.run(key).changes;
    c += this._stmt.delSet.run(key).changes;
    c += this._stmt.delList.run(key).changes;
    return c;
  }

  // ==================== 工具 ====================

  /** 尝试 JSON 解析，失败则返回原字符串 */
  _tryParse(value) {
    if (value === null || value === undefined) return null;
    try { return JSON.parse(value); } catch { return value; }
  }

  get status() { return 'ready'; }
}

// ==================== 单例 ====================

const store = new SQLiteStore();
logEvent('info', 'store_backend_sqlite', { message: '使用 SQLite（本地持久化）' });

// ========== 会话管理（不变） ==========

const createConversationId = () =>
  `conv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

class ConversationStore {
  _getKey(userId) { return `conversations:${userId}`; }

  _normalizeConversation(conversation = {}) {
    const now = new Date().toISOString();
    return {
      id: String(conversation.id || createConversationId()),
      title: String(conversation.title || '新会话'),
      messages: Array.isArray(conversation.messages) ? conversation.messages : [],
      createdAt: conversation.createdAt || now,
      updatedAt: conversation.updatedAt || now,
    };
  }

  async getConversations(userId) {
    const all = await store.hgetall(this._getKey(userId));
    if (!all) return [];
    return Object.values(all)
      .map((raw) => {
        try { return this._normalizeConversation(typeof raw === 'string' ? JSON.parse(raw) : raw); }
        catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  }

  async getConversation(userId, conversationId) {
    const raw = await store.hget(this._getKey(userId), String(conversationId));
    if (!raw) return null;
    try { return this._normalizeConversation(typeof raw === 'string' ? JSON.parse(raw) : raw); }
    catch { return null; }
  }

  async createConversation(userId, title = '新会话') {
    const conversation = this._normalizeConversation({
      title: title && String(title).trim() ? String(title).trim() : '新会话',
      messages: [],
    });
    await store.hset(this._getKey(userId), conversation.id, conversation);
    return conversation;
  }

  async saveConversation(userId, conversationId, updates = {}) {
    const existing = await this.getConversation(userId, conversationId);
    if (!existing) return null;
    const next = this._normalizeConversation({
      ...existing,
      ...(updates.title !== undefined ? { title: String(updates.title || '').trim() || existing.title } : {}),
      ...(updates.messages !== undefined ? { messages: Array.isArray(updates.messages) ? updates.messages : existing.messages } : {}),
      updatedAt: new Date().toISOString(),
    });
    await store.hset(this._getKey(userId), next.id, next);
    return next;
  }

  async renameConversation(userId, conversationId, title) {
    return !!(await this.saveConversation(userId, conversationId, { title }));
  }

  async clearMessages(userId, conversationId) {
    return !!(await this.saveConversation(userId, conversationId, { messages: [] }));
  }

  /**
   * 从指定消息处分叉出新会话（复制消息到该条为止，原会话不动）
   * @returns {Promise<Object|null>} 新会话；会话或消息不存在时返回 null
   */
  async forkConversation(userId, conversationId, messageId) {
    const conversation = await this.getConversation(userId, conversationId);
    if (!conversation) return null;
    const messages = Array.isArray(conversation.messages) ? conversation.messages : [];
    const index = messageId
      ? messages.findIndex((m) => m?.id === String(messageId))
      : messages.length - 1;
    if (index === -1) return null;

    const sliced = messages.slice(0, index + 1).map((m) => ({ ...m }));
    const forked = await this.createConversation(userId, `${conversation.title || '会话'}（分叉）`);
    const saved = await this.saveConversation(userId, forked.id, { messages: sliced });
    return saved || { ...forked, messages: sliced };
  }

  async deleteConversation(userId, conversationId) {
    return (await store.hdel(this._getKey(userId), String(conversationId))) > 0;
  }
}

const conversationStore = new ConversationStore();

module.exports = { redis: store, conversationStore };
