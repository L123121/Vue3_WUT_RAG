const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const config = require('../config');
const { tokenRevocationStore } = require('../services/auth/token-revocation.service');

const COOKIE_NAME = 'auth_token';

/**
 * JWT 鉴权中间件
 * 从 httpOnly cookie 中提取 token，验证后注入 req.userId
 * 如果没有 token，不报错，只是 req.userId 为 null（允许匿名访问部分接口）
 */
const authMiddleware = (req, res, next) => {
  const token = req.cookies?.[COOKIE_NAME];

  if (!token) {
    req.userId = null;
    req.username = null;
    req.role = null;
    return next();
  }

  try {
    const decoded = jwt.verify(token, config.jwt.secret);
    if (tokenRevocationStore.isRevoked(decoded)) throw new Error('token revoked');
    req.tokenClaims = decoded;
    req.userId = decoded.userId || decoded.id || null;
    req.username = decoded.username || null;
    req.role = decoded.role || null;
  } catch {
    // Token 无效或过期，清除坏 cookie（secure 标志需与设置时一致）
    const isProd = process.env.NODE_ENV === 'production';
    res.clearCookie(COOKIE_NAME, { httpOnly: true, sameSite: 'lax', secure: isProd, path: '/' });
    req.userId = null;
    req.username = null;
    req.role = null;
  }

  next();
};

/**
 * 强制鉴权中间件 — 必须有有效 token
 */
const requireAuth = (req, res, next) => {
  if (!req.userId) {
    return res.status(401).json({
      success: false,
      message: '请先登录',
    });
  }
  next();
};

/**
 * 生成 JWT token
 */
const generateToken = (payload) => {
  return jwt.sign(payload, config.jwt.secret, {
    expiresIn: config.jwt.expiresIn,
    jwtid: crypto.randomUUID(),
  });
};

/**
 * 管理员鉴权中间件 — 必须为 admin 角色
 */
const requireAdmin = (req, res, next) => {
  if (!req.userId) {
    return res.status(401).json({ success: false, message: '请先登录' });
  }
  if (req.role !== 'admin') {
    return res.status(403).json({ success: false, message: '权限不足，仅管理员可执行此操作' });
  }
  next();
};

module.exports = { authMiddleware, requireAuth, requireAdmin, generateToken, COOKIE_NAME };
