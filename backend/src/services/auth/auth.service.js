"use strict";

const crypto = require('crypto');
const { promisify } = require('util');
const path = require('path');
const fs = require('fs');
const config = require('../../config');

const scrypt = promisify(crypto.scrypt);
const USERNAME_RE = /^[a-zA-Z0-9_.@-]{3,32}$/;
const PASSWORD_MIN_LENGTH = 8;
const PASSWORD_MAX_LENGTH = 128;
// 复杂度基线：至少同时包含一个字母和一个数字，拒绝纯数字/纯字母弱口令
const PASSWORD_LETTER_RE = /[a-zA-Z]/;
const PASSWORD_DIGIT_RE = /\d/;
const BLOCKED_USERNAMES = [
  'admin', 'root', 'system', 'test', 'guest', 'null', 'undefined',
  '管理员', '系统', '测试', '客服',
];

// ========== SQLite 持久化 ==========
const DATA_DIR = path.join(__dirname, '../../data');
const DB_FILE = path.join(DATA_DIR, 'store.db');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const Database = require('better-sqlite3');
const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name          TEXT NOT NULL DEFAULT '',
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL DEFAULT 'user',
    student_id    TEXT NOT NULL DEFAULT '',
    approved      INTEGER NOT NULL DEFAULT 1,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

const stmt = {
  insert: db.prepare(
    `INSERT INTO users (id, username, name, password_hash, role, student_id, approved, created_at)
     VALUES (@id, @username, @name, @password_hash, @role, @student_id, @approved, @created_at)`
  ),
  byUsername: db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE'),
  byId: db.prepare('SELECT * FROM users WHERE id = ?'),
  updatePassword: db.prepare('UPDATE users SET password_hash = ? WHERE id = ?'),
};

function normalizeUsername(username) {
  return String(username || '').trim().toLowerCase();
}

function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    name: row.name || row.username,
    role: row.role || 'user',
    studentId: row.student_id || '',
    approved: !!row.approved,
    createdAt: row.created_at,
  };
}

function createAuthError(code, message, status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

// 环境变量口令的比较走常量时间：先各自 sha256 归一长度（timingSafeEqual 要求等长 Buffer，
// 直接比较原始字符串会因长度差异提前返回而泄露长度信息）
function timingSafeSecretEqual(a, b) {
  const digestA = crypto.createHash('sha256').update(String(a)).digest();
  const digestB = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(digestA, digestB);
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derivedKey = await scrypt(password, salt, 64);
  return `scrypt$${salt}$${derivedKey.toString('hex')}`;
}

async function verifyPassword(password, passwordHash) {
  const [scheme, salt, expectedHex] = String(passwordHash || '').split('$');
  if (scheme !== 'scrypt' || !salt || !expectedHex) return false;

  const expected = Buffer.from(expectedHex, 'hex');
  const actual = await scrypt(password, salt, expected.length);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

class AuthService {
  // 密码策略：长度 8-128，且需同时包含字母和数字（注册与改密共用同一套基线）
  assertPasswordPolicy(password) {
    const pwd = String(password || '');
    if (pwd.length < PASSWORD_MIN_LENGTH || pwd.length > PASSWORD_MAX_LENGTH) {
      throw createAuthError('INVALID_PASSWORD', `密码长度需为 ${PASSWORD_MIN_LENGTH}-${PASSWORD_MAX_LENGTH} 位`);
    }
    if (!PASSWORD_LETTER_RE.test(pwd) || !PASSWORD_DIGIT_RE.test(pwd)) {
      throw createAuthError('INVALID_PASSWORD', '密码需同时包含字母和数字');
    }
    return pwd;
  }

  validateRegistration({ username, password, studentId }) {
    const normalizedUsername = normalizeUsername(username);
    if (!USERNAME_RE.test(normalizedUsername)) {
      throw createAuthError('INVALID_USERNAME', '用户名需为 3-32 位，可包含字母、数字、下划线、点、横线或 @');
    }
    if (BLOCKED_USERNAMES.includes(normalizedUsername)) {
      throw createAuthError('INVALID_USERNAME', '该用户名不可用，请换一个');
    }
    this.assertPasswordPolicy(password);
    if (studentId && String(studentId).trim().length > 32) {
      throw createAuthError('INVALID_STUDENT_ID', '学号长度不能超过 32 位');
    }
    return normalizedUsername;
  }

  async register({ username, password, studentId, inviteCode }) {
    // 部署方设置 AUTH_INVITE_CODE 后注册必须携带正确邀请码（常量时间比较）；未配置时开放注册
    if (config.auth.inviteCode && !timingSafeSecretEqual(String(inviteCode || ''), config.auth.inviteCode)) {
      throw createAuthError('INVALID_INVITE_CODE', '邀请码无效，请核对后重试', 403);
    }
    const normalizedUsername = this.validateRegistration({ username, password, studentId });
    const existing = stmt.byUsername.get(normalizedUsername);
    if (existing) {
      throw createAuthError('USERNAME_EXISTS', '用户名已存在', 409);
    }

    const user = {
      id: `user_${crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(12).toString('hex')}`,
      username: normalizedUsername,
      name: normalizedUsername,
      password_hash: await hashPassword(password),
      role: 'user',
      student_id: studentId ? String(studentId).trim() : '',
      approved: 1,
      created_at: new Date().toISOString(),
    };

    stmt.insert.run(user);
    return publicUser(user);
  }

  async login({ username, password }) {
    const normalizedUsername = normalizeUsername(username);
    if (!normalizedUsername || !password) {
      throw createAuthError('MISSING_CREDENTIALS', '请输入用户名和密码');
    }

    // 管理员账号：通过统一登录入口验证（口令常量时间比较，不走 scrypt 用户表）
    if (normalizedUsername === normalizeUsername(config.admin.username) && timingSafeSecretEqual(password, config.admin.password)) {
      return {
        id: 'admin',
        username: config.admin.username || 'admin',
        name: '管理员',
        role: 'admin',
        studentId: '',
        approved: true,
      };
    }

    const row = stmt.byUsername.get(normalizedUsername);
    if (!row || !(await verifyPassword(password, row.password_hash))) {
      throw createAuthError('INVALID_CREDENTIALS', '用户名或密码错误', 401);
    }
    if (!row.approved) {
      throw createAuthError('ACCOUNT_PENDING', '账号待审核，请联系管理员', 403);
    }

    return publicUser(row);
  }

  async changePassword(userId, currentPassword, newPassword) {
    if (!userId || !currentPassword || !newPassword) {
      throw createAuthError('MISSING_PARAMS', '缺少必要参数');
    }

    // 管理员不允许通过此接口修改密码
    if (userId === 'admin') {
      throw createAuthError('ADMIN_NOT_ALLOWED', '管理员密码请在环境变量中修改', 403);
    }

    this.assertPasswordPolicy(newPassword);

    const row = stmt.byId.get(userId);
    if (!row) {
      throw createAuthError('USER_NOT_FOUND', '用户不存在', 404);
    }
    if (!(await verifyPassword(currentPassword, row.password_hash))) {
      throw createAuthError('INVALID_CREDENTIALS', '当前密码错误', 401);
    }

    const newHash = await hashPassword(newPassword);
    stmt.updatePassword.run(newHash, userId);
    return publicUser({ ...row, password_hash: newHash });
  }

  async getUserById(userId) {
    if (!userId) return null;
    if (userId === 'admin') {
      return {
        id: 'admin',
        username: config.admin.username || 'admin',
        name: '管理员',
        role: 'admin',
        studentId: '',
        approved: true,
      };
    }

    const row = stmt.byId.get(userId);
    return publicUser(row);
  }
}

module.exports = new AuthService();