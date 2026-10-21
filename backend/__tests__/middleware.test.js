import { describe, it, expect, beforeEach, vi } from 'vitest';

describe('auth.middleware', () => {
  let authMiddleware, requireAuth, generateToken;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.JWT_SECRET = 'test-jwt-secret-for-unit-tests';
    delete require.cache[require.resolve('../src/config')];
    delete require.cache[require.resolve('../src/middleware/auth.middleware')];
    const mod = require('../src/middleware/auth.middleware');
    authMiddleware = mod.authMiddleware;
    requireAuth = mod.requireAuth;
    generateToken = mod.generateToken;
  });

  it('无 cookie 时设置 userId 为 null', () => {
    const req = { cookies: {} };
    const res = { clearCookie: vi.fn() };
    const next = vi.fn();
    authMiddleware(req, res, next);
    expect(req.userId).toBeNull();
    expect(next).toHaveBeenCalled();
  });

  it('有效 cookie 设置 userId', () => {
    const token = generateToken({ userId: 'u123', username: 'test' });
    const req = { cookies: { auth_token: token } };
    const res = { clearCookie: vi.fn() };
    const next = vi.fn();
    authMiddleware(req, res, next);
    expect(req.userId).toBe('u123');
    expect(req.username).toBe('test');
  });

  it('无效 cookie 设置 userId 为 null 并清除 cookie', () => {
    const req = { cookies: { auth_token: 'invalid.jwt.token' } };
    const res = { clearCookie: vi.fn() };
    const next = vi.fn();
    authMiddleware(req, res, next);
    expect(req.userId).toBeNull();
    expect(res.clearCookie).toHaveBeenCalledWith('auth_token', expect.any(Object));
  });

  it('logout 注销的 token 与改密前签发的 token 被拒绝', () => {
    const { tokenRevocationStore } = require('../src/services/auth/token-revocation.service');
    const jwt = require('jsonwebtoken');
    const userId = `revoke_${Date.now()}`;
    const token = generateToken({ userId, username: 'test' });
    const claims = jwt.decode(token);
    expect(claims.jti).toEqual(expect.any(String));

    const authenticate = (value) => {
      const req = { cookies: { auth_token: value } };
      authMiddleware(req, { clearCookie: vi.fn() }, vi.fn());
      return req.userId;
    };
    expect(authenticate(token)).toBe(userId);

    tokenRevocationStore.revokeToken(claims.jti, claims.exp);
    expect(authenticate(token)).toBeNull();

    const oldToken = jwt.sign({ userId, iat: Math.floor(Date.now() / 1000) - 60 }, process.env.JWT_SECRET, { expiresIn: '1h' });
    expect(authenticate(oldToken)).toBe(userId);
    tokenRevocationStore.revokeAllForUser(userId);
    expect(authenticate(oldToken)).toBeNull();
    expect(authenticate(generateToken({ userId, username: 'test' }))).toBe(userId);
  });

  it('requireAuth 有 userId 放行', () => {
    const next = vi.fn();
    requireAuth({ userId: 'u1' }, {}, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('requireAuth 无 userId 返回 401', () => {
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    requireAuth({ userId: null }, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('generateToken 生成有效 JWT', () => {
    const token = generateToken({ userId: 'u1', username: 'test' });
    expect(typeof token).toBe('string');
    expect(token.split('.')).toHaveLength(3);
  });
});

describe('response utils', () => {
  let successResponse, errorResponse;

  beforeEach(() => {
    delete require.cache[require.resolve('../src/utils/response')];
    const mod = require('../src/utils/response');
    successResponse = mod.successResponse;
    errorResponse = mod.errorResponse;
  });

  it('successResponse', () => {
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    successResponse(res, { x: 1 });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ success: true, message: 'Success', data: { x: 1 } });
  });

  it('errorResponse', () => {
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    errorResponse(res, '未找到', 404);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ success: false, message: '未找到', error: '未找到' });
  });
});
