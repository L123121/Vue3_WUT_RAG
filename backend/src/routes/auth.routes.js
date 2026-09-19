/**
 * 认证路由 — 注册、登录、登出、修改密码、当前用户
 */
const express = require('express');
const rateLimit = require('express-rate-limit');
const authService = require('../services/auth.service');
const { COOKIE_NAME, requireAuth, generateToken } = require('../middleware/auth.middleware');
const { logEvent } = require('../services/observability.service');

const router = express.Router();

const setAuthCookie = (req, res, token) => {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: req.protocol === 'https' || req.headers['x-forwarded-proto'] === 'https',
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: '/',
  });
};

const sendAuthError = (res, error, fallback = '认证失败') => {
  return res.status(error.status || 500).json({
    success: false,
    code: error.code || 'AUTH_ERROR',
    message: error.message || fallback,
  });
};

// 注册限流：每小时最多 3 次
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  message: { success: false, code: 'RATE_LIMIT', message: '注册过于频繁，请稍后再试' },
  standardHeaders: true,
  legacyHeaders: false,
});

// 登录限流：每分钟最多 10 次，防暴力破解
const loginLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { success: false, code: 'RATE_LIMIT', message: '登录尝试过于频繁，请稍后再试' },
  standardHeaders: true,
  legacyHeaders: false,
});

// POST /api/auth/register
router.post('/register', registerLimiter, async (req, res) => {
  try {
    const user = await authService.register(req.body || {});
    const token = generateToken({ userId: user.id, username: user.username, role: user.role });
    setAuthCookie(req, res, token);
    res.status(201).json({ success: true, message: '注册成功', data: { user } });
  } catch (error) {
    logEvent('error', 'auth_register_failed', { error: error.message });
    sendAuthError(res, error, '注册失败');
  }
});

// POST /api/auth/login
router.post('/login', loginLimiter, async (req, res) => {
  try {
    const user = await authService.login(req.body || {});
    const token = generateToken({ userId: user.id, username: user.username, role: user.role });
    setAuthCookie(req, res, token);
    res.json({ success: true, message: '登录成功', data: { user } });
  } catch (error) {
    logEvent('error', 'auth_login_failed', { error: error.message });
    sendAuthError(res, error, '登录失败');
  }
});

// POST /api/auth/change-password
router.post('/change-password', requireAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    const user = await authService.changePassword(req.userId, currentPassword, newPassword);
    res.json({ success: true, message: '密码修改成功', data: { user } });
  } catch (error) {
    logEvent('error', 'auth_password_change_failed', { error: error.message });
    sendAuthError(res, error, '密码修改失败');
  }
});

// GET /api/auth/me
router.get('/me', async (req, res) => {
  try {
    if (!req.userId) {
      return res.status(401).json({ success: false, code: 'UNAUTHENTICATED', message: '请先登录' });
    }
    const user = await authService.getUserById(req.userId);
    if (!user) {
      return res.status(401).json({ success: false, code: 'USER_NOT_FOUND', message: '登录已过期，请重新登录' });
    }
    res.json({ success: true, data: { user } });
  } catch (error) {
    logEvent('error', 'auth_me_failed', { error: error.message });
    sendAuthError(res, error, '获取用户信息失败');
  }
});

// POST /api/auth/logout
router.post('/logout', (req, res) => {
  // secure 标志需与设置时一致（setAuthCookie），否则 HTTPS 下 Secure cookie 无法清除
  const isSecure = req.protocol === 'https' || req.headers['x-forwarded-proto'] === 'https';
  res.clearCookie(COOKIE_NAME, { httpOnly: true, sameSite: 'lax', secure: isSecure, path: '/', maxAge: 0 });
  res.json({ success: true, message: '已退出登录' });
});

module.exports = { router, setAuthCookie };

