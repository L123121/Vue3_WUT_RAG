"use strict";

const fs = require('fs');
const path = require('path');
const { getDatabasePath } = require('../../db/migration-runner');

const PURGE_INTERVAL_MS = 60 * 60 * 1000;

/**
 * JWT 撤销表：
 * - revoked_tokens：单个 token（jti）在自然过期前被注销（logout）
 * - user_token_cutoffs：用户级截止时间，iat 早于它的 token 全部失效（改密码 / 强制下线）
 * 鉴权中间件是同步的，better-sqlite3 同步查询主键单行，开销在微秒级。
 */
class TokenRevocationStore {
  constructor(options = {}) {
    this.dbPath = options.dbPath || getDatabasePath();
    this._db = null;
    this._lastPurgeAt = 0;
  }

  _open() {
    if (this._db) return this._db;
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    const Database = require('better-sqlite3');
    const db = new Database(this.dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
    db.exec(`
      CREATE TABLE IF NOT EXISTS revoked_tokens (
        jti TEXT PRIMARY KEY,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_revoked_tokens_expires ON revoked_tokens (expires_at);
      CREATE TABLE IF NOT EXISTS user_token_cutoffs (
        user_id TEXT PRIMARY KEY,
        not_before INTEGER NOT NULL
      );
    `);
    this._stmt = {
      revoke: db.prepare('INSERT OR REPLACE INTO revoked_tokens (jti, expires_at) VALUES (?, ?)'),
      isRevoked: db.prepare('SELECT 1 FROM revoked_tokens WHERE jti = ?'),
      setCutoff: db.prepare('INSERT OR REPLACE INTO user_token_cutoffs (user_id, not_before) VALUES (?, ?)'),
      getCutoff: db.prepare('SELECT not_before FROM user_token_cutoffs WHERE user_id = ?'),
      purge: db.prepare('DELETE FROM revoked_tokens WHERE expires_at < ?'),
    };
    this._db = db;
    return db;
  }

  /** 注销单个 token；exp 为 JWT 的秒级过期时间，过期后记录可清理 */
  revokeToken(jti, exp) {
    if (!jti) return;
    this._open();
    const nowSec = Math.floor(Date.now() / 1000);
    this._stmt.revoke.run(String(jti), Number.isFinite(exp) ? exp : nowSec + 7 * 24 * 3600);
    this._maybePurge(nowSec);
  }

  /** 使该用户此刻之前签发的全部 token 失效 */
  revokeAllForUser(userId) {
    if (!userId) return;
    this._open();
    this._stmt.setCutoff.run(String(userId), Math.floor(Date.now() / 1000));
  }

  /** decoded 为 jwt.verify 结果 */
  isRevoked(decoded) {
    if (!decoded) return true;
    this._open();
    if (decoded.jti && this._stmt.isRevoked.get(String(decoded.jti))) return true;
    const userId = decoded.userId || decoded.id;
    if (!userId) return false;
    const cutoff = this._stmt.getCutoff.get(String(userId));
    // iat 为秒级；同一秒内改密后重新签发的 token 视为有效
    return Boolean(cutoff && Number(decoded.iat) < cutoff.not_before);
  }

  _maybePurge(nowSec) {
    if (Date.now() - this._lastPurgeAt < PURGE_INTERVAL_MS) return;
    this._lastPurgeAt = Date.now();
    this._stmt.purge.run(nowSec);
  }

  close() {
    this._db?.close();
    this._db = null;
  }
}

const tokenRevocationStore = new TokenRevocationStore();

module.exports = { TokenRevocationStore, tokenRevocationStore };
