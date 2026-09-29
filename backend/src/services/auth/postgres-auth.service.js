'use strict';

const crypto = require('crypto');
const { promisify } = require('util');
const config = require('../../config');
const { getRepositories } = require('../../repositories/repository-factory');

const scrypt = promisify(crypto.scrypt);
const USERNAME_RE = /^[a-zA-Z0-9_.@-]{3,32}$/;
const PASSWORD_MIN_LENGTH = 8;
const PASSWORD_MAX_LENGTH = 128;
const PASSWORD_LETTER_RE = /[a-zA-Z]/;
const PASSWORD_DIGIT_RE = /\d/;
const BLOCKED_USERNAMES = ['admin', 'root', 'system', 'test', 'guest', 'null', 'undefined', '管理员', '系统', '测试', '客服'];

const normalizeUsername = (value) => String(value || '').trim().toLowerCase();
const publicUser = (row) => row ? ({ id: row.id, username: row.username, name: row.name || row.username, role: row.role || 'user', studentId: row.student_id || row.studentId || '', approved: row.approved !== false, createdAt: row.created_at || row.createdAt }) : null;

function authError(code, message, status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function timingSafeSecretEqual(a, b) {
  const left = crypto.createHash('sha256').update(String(a)).digest();
  const right = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(left, right);
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const key = await scrypt(password, salt, 64);
  return `scrypt$${salt}$${key.toString('hex')}`;
}

async function verifyPassword(password, passwordHash) {
  const [scheme, salt, expectedHex] = String(passwordHash || '').split('$');
  if (scheme !== 'scrypt' || !salt || !expectedHex) return false;
  const expected = Buffer.from(expectedHex, 'hex');
  const actual = await scrypt(password, salt, expected.length);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

class PostgresAuthService {
  constructor(options = {}) { this.users = options.users || getRepositories(options)?.users; }
  assertPasswordPolicy(password) {
    const pwd = String(password || '');
    if (pwd.length < PASSWORD_MIN_LENGTH || pwd.length > PASSWORD_MAX_LENGTH) throw authError('INVALID_PASSWORD', `密码长度需为 ${PASSWORD_MIN_LENGTH}-${PASSWORD_MAX_LENGTH} 位`);
    if (!PASSWORD_LETTER_RE.test(pwd) || !PASSWORD_DIGIT_RE.test(pwd)) throw authError('INVALID_PASSWORD', '密码需同时包含字母和数字');
    return pwd;
  }
  validateRegistration({ username, password, studentId }) {
    const normalized = normalizeUsername(username);
    if (!USERNAME_RE.test(normalized) || BLOCKED_USERNAMES.includes(normalized)) throw authError('INVALID_USERNAME', '用户名需为 3-32 位，可包含字母、数字、下划线、点、横线或 @');
    this.assertPasswordPolicy(password);
    if (studentId && String(studentId).trim().length > 32) throw authError('INVALID_STUDENT_ID', '学号长度不能超过 32 位');
    return normalized;
  }
  async register({ username, password, studentId, inviteCode }) {
    if (!this.users) throw new Error('PostgreSQL 用户仓储不可用');
    if (config.auth.inviteCode && !timingSafeSecretEqual(String(inviteCode || ''), config.auth.inviteCode)) throw authError('INVALID_INVITE_CODE', '邀请码无效，请核对后重试', 403);
    const normalized = this.validateRegistration({ username, password, studentId });
    if (await this.users.findByUsername(normalized)) throw authError('USERNAME_EXISTS', '用户名已存在', 409);
    const row = await this.users.insert({ id: `user_${crypto.randomUUID()}`, username: normalized, name: normalized, password_hash: await hashPassword(password), role: 'user', student_id: studentId ? String(studentId).trim() : '', approved: true, created_at: new Date().toISOString() });
    return publicUser(row);
  }
  async login({ username, password }) {
    if (!username || !password) throw authError('MISSING_CREDENTIALS', '请输入用户名和密码');
    const normalized = normalizeUsername(username);
    if (normalized === normalizeUsername(config.admin.username) && timingSafeSecretEqual(password, config.admin.password)) return { id: 'admin', username: config.admin.username || 'admin', name: '管理员', role: 'admin', studentId: '', approved: true };
    const row = await this.users.findByUsername(normalized);
    if (!row || !(await verifyPassword(password, row.password_hash))) throw authError('INVALID_CREDENTIALS', '用户名或密码错误', 401);
    if (!row.approved) throw authError('ACCOUNT_PENDING', '账号待审核，请联系管理员', 403);
    return publicUser(row);
  }
  async changePassword(userId, currentPassword, newPassword) {
    if (!userId || !currentPassword || !newPassword) throw authError('MISSING_PARAMS', '缺少必要参数');
    if (userId === 'admin') throw authError('ADMIN_NOT_ALLOWED', '管理员密码请在环境变量中修改', 403);
    this.assertPasswordPolicy(newPassword);
    const row = await this.users.findById(userId);
    if (!row) throw authError('USER_NOT_FOUND', '用户不存在', 404);
    if (!(await verifyPassword(currentPassword, row.password_hash))) throw authError('INVALID_CREDENTIALS', '当前密码错误', 401);
    return publicUser(await this.users.updatePassword(userId, await hashPassword(newPassword)));
  }
  async getUserById(userId) {
    if (!userId) return null;
    if (userId === 'admin') return { id: 'admin', username: config.admin.username || 'admin', name: '管理员', role: 'admin', studentId: '', approved: true };
    return publicUser(await this.users.findById(userId));
  }
}

module.exports = { PostgresAuthService };
