import { describe, it, expect, afterEach } from 'vitest';

/**
 * auth.service 单元测试 — 密码哈希、注册/登录、管理员分支、改密流程
 *
 * auth.service 在模块加载时直接 new Database(backend/data/store.db),无法
 * 用 vi.mock 拦截(原生依赖被 externalize)。这里沿用 quota.middleware.test.js
 * 的 require.cache 思路:在首次 require auth.service 之前,把 better-sqlite3
 * 的模块缓存替换为「内存库工厂」,让测试完全 hermetic,绝不读写真实数据库。
 */

// 管理员口令固定走环境变量,避免 config 在测试中生成随机密码文件
process.env.ADMIN_USERNAME = 'admin';
process.env.ADMIN_PASSWORD = 'test-admin-password-123';

const betterSqlite3Id = require.resolve('better-sqlite3');
const RealDatabase = require(betterSqlite3Id);
const instances = [];
const MockDatabase = function (file) {
  const db = new RealDatabase(':memory:');
  instances.push(db);
  return db;
};
require.cache[betterSqlite3Id] = {
  id: betterSqlite3Id,
  filename: betterSqlite3Id,
  loaded: true,
  exports: MockDatabase,
};

const authService = require('../src/services/auth/auth.service');
const config = require('../src/config');

const testDb = () => instances[0];

// mock 未生效时立刻失败,防止测试写入真实 store.db
if (instances.length === 0) {
  throw new Error('better-sqlite3 内存库替换未生效,拒绝在真实数据库上运行测试');
}

// 密码策略:8-128 位且需同时包含字母和数字(与 assertPasswordPolicy 一致)
const VALID_PASSWORD = 'pass1234';

describe('validateRegistration', () => {
  it.each([
    ['ab', '用户名过短'],
    ['a'.repeat(33), '用户名过长'],
    ['user name', '包含空格'],
    ['用户名', '包含中文'],
  ])('拒绝非法用户名: %s (%s)', (username) => {
    expect(() => authService.validateRegistration({ username, password: VALID_PASSWORD }))
      .toThrowError(expect.objectContaining({ code: 'INVALID_USERNAME' }));
  });

  it.each(['admin', 'root', 'system', '管理员'])('拒绝保留用户名: %s', (username) => {
    expect(() => authService.validateRegistration({ username, password: VALID_PASSWORD }))
      .toThrowError(expect.objectContaining({ code: 'INVALID_USERNAME' }));
  });

  it.each([
    ['1234567', '短于 8 位'],
    ['a'.repeat(129), '长于 128 位'],
    ['12345678', '纯数字'],
    ['abcdefgh', '纯字母'],
    ['', '空密码'],
  ])('拒绝不合规密码: %s (%s)', (password) => {
    expect(() => authService.validateRegistration({ username: 'alice', password }))
      .toThrowError(expect.objectContaining({ code: 'INVALID_PASSWORD' }));
  });

  it('接受合规密码并返回归一化用户名', () => {
    expect(authService.validateRegistration({ username: '  Alice@WHUT  ', password: 'abcd1234' }))
      .toBe('alice@whut');
  });

  it('拒绝超过 32 位的学号', () => {
    expect(() => authService.validateRegistration({ username: 'alice', password: VALID_PASSWORD, studentId: '1'.repeat(33) }))
      .toThrowError(expect.objectContaining({ code: 'INVALID_STUDENT_ID' }));
  });
});

describe('register + login 往返', () => {
  it('注册返回的公开用户对象不泄露 password_hash', async () => {
    const user = await authService.register({ username: 'alice', password: 'secret123' });

    expect(user.username).toBe('alice');
    expect(user.role).toBe('user');
    expect(user).not.toHaveProperty('password_hash');
    expect(user).not.toHaveProperty('passwordHash');
  });

  it('正确密码可登录', async () => {
    await authService.register({ username: 'bob', password: 'secret123' });
    const user = await authService.login({ username: 'bob', password: 'secret123' });

    expect(user.username).toBe('bob');
    expect(user.approved).toBe(true);
  });

  it('同一密码两次注册产生不同盐值', async () => {
    await authService.register({ username: 'salt_a', password: 'secret123' });
    await authService.register({ username: 'salt_b', password: 'secret123' });

    const hashes = testDb()
      .prepare("SELECT username, password_hash FROM users WHERE username IN ('salt_a', 'salt_b') ORDER BY username")
      .all()
      .map((row) => row.password_hash);

    expect(hashes).toHaveLength(2);
    expect(hashes[0]).toMatch(/^scrypt\$[0-9a-f]{32}\$/);
    expect(hashes[0]).not.toBe(hashes[1]);
  });

  it('用户名大小写不敏感判重(COLLATE NOCASE)', async () => {
    await authService.register({ username: 'carol', password: 'secret123' });

    await expect(authService.register({ username: 'CAROL', password: 'secret123' }))
      .rejects.toMatchObject({ code: 'USERNAME_EXISTS', status: 409 });
  });

  it('未知用户登录返回 401', async () => {
    await expect(authService.login({ username: 'nobody', password: 'secret123' }))
      .rejects.toMatchObject({ code: 'INVALID_CREDENTIALS', status: 401 });
  });

  it('密码错误返回 401', async () => {
    await authService.register({ username: 'dave', password: 'secret123' });

    await expect(authService.login({ username: 'dave', password: 'wrong-pass' }))
      .rejects.toMatchObject({ code: 'INVALID_CREDENTIALS', status: 401 });
  });

  it('缺少用户名或密码直接拒绝', async () => {
    await expect(authService.login({ username: '', password: 'x' }))
      .rejects.toMatchObject({ code: 'MISSING_CREDENTIALS' });
    await expect(authService.login({ username: 'dave', password: '' }))
      .rejects.toMatchObject({ code: 'MISSING_CREDENTIALS' });
  });

  it('账号未审核时登录返回 403', async () => {
    await authService.register({ username: 'pending_user', password: 'secret123' });
    testDb().prepare('UPDATE users SET approved = 0 WHERE username = ?').run('pending_user');

    await expect(authService.login({ username: 'pending_user', password: 'secret123' }))
      .rejects.toMatchObject({ code: 'ACCOUNT_PENDING', status: 403 });
  });

  it('存储格式损坏的密码哈希按验证失败处理,不抛异常', async () => {
    testDb().prepare(
      "INSERT INTO users (id, username, name, password_hash) VALUES ('user_broken', 'broken_hash', 'broken_hash', 'md5$aa$bb')"
    ).run();

    await expect(authService.login({ username: 'broken_hash', password: 'anything' }))
      .rejects.toMatchObject({ code: 'INVALID_CREDENTIALS', status: 401 });
  });
});

describe('邀请码校验（AUTH_INVITE_CODE）', () => {
  afterEach(() => {
    config.auth.inviteCode = '';
  });

  it('未配置邀请码时开放注册', async () => {
    config.auth.inviteCode = '';

    const user = await authService.register({ username: 'no_invite', password: VALID_PASSWORD });

    expect(user.username).toBe('no_invite');
  });

  it('配置邀请码后,错误或缺失的邀请码被拒绝且不落库', async () => {
    config.auth.inviteCode = 'secret-invite';

    await expect(authService.register({ username: 'iv_wrong', password: VALID_PASSWORD, inviteCode: 'wrong-code' }))
      .rejects.toMatchObject({ code: 'INVALID_INVITE_CODE', status: 403 });
    await expect(authService.register({ username: 'iv_missing', password: VALID_PASSWORD }))
      .rejects.toMatchObject({ code: 'INVALID_INVITE_CODE', status: 403 });

    const rows = testDb().prepare("SELECT COUNT(*) AS cnt FROM users WHERE username LIKE 'iv_%'").get();
    expect(rows.cnt).toBe(0);
  });

  it('配置邀请码后携带正确邀请码可注册', async () => {
    config.auth.inviteCode = 'secret-invite';

    const user = await authService.register({ username: 'iv_ok', password: VALID_PASSWORD, inviteCode: 'secret-invite' });

    expect(user.username).toBe('iv_ok');
  });
});

describe('管理员登录分支', () => {
  it('正确的环境变量口令返回管理员身份', async () => {
    const admin = await authService.login({ username: 'admin', password: 'test-admin-password-123' });

    expect(admin.role).toBe('admin');
    expect(admin.id).toBe('admin');
    expect(admin.approved).toBe(true);
  });

  it('管理员用户名大小写不敏感', async () => {
    const admin = await authService.login({ username: 'ADMIN', password: 'test-admin-password-123' });

    expect(admin.role).toBe('admin');
  });

  it('管理员口令错误时不会落入用户表误登录', async () => {
    await expect(authService.login({ username: 'admin', password: 'wrong-admin-pass' }))
      .rejects.toMatchObject({ code: 'INVALID_CREDENTIALS', status: 401 });
  });
});

describe('changePassword', () => {
  it('缺少参数、新密码不合规、目标为管理员分别被拒', async () => {
    await expect(authService.changePassword('', 'a', 'b'))
      .rejects.toMatchObject({ code: 'MISSING_PARAMS' });
    await expect(authService.changePassword('user_x', 'current1', '12345'))
      .rejects.toMatchObject({ code: 'INVALID_PASSWORD' });
    await expect(authService.changePassword('user_x', 'current1', 'abcdefgh'))
      .rejects.toMatchObject({ code: 'INVALID_PASSWORD' });
    await expect(authService.changePassword('admin', 'current1', '12345678'))
      .rejects.toMatchObject({ code: 'ADMIN_NOT_ALLOWED', status: 403 });
  });

  it('当前密码错误返回 401,用户不存在返回 404', async () => {
    await authService.register({ username: 'erin', password: 'secret123' });
    const user = await authService.login({ username: 'erin', password: 'secret123' });

    await expect(authService.changePassword(user.id, 'wrong-pass', 'newpass123'))
      .rejects.toMatchObject({ code: 'INVALID_CREDENTIALS', status: 401 });
    await expect(authService.changePassword('user_missing', 'whatever', 'newpass123'))
      .rejects.toMatchObject({ code: 'USER_NOT_FOUND', status: 404 });
  });

  it('改密成功后新密码可登录、旧密码失效', async () => {
    await authService.register({ username: 'frank', password: 'oldpass123' });
    const user = await authService.login({ username: 'frank', password: 'oldpass123' });

    await authService.changePassword(user.id, 'oldpass123', 'newpass456');

    await expect(authService.login({ username: 'frank', password: 'oldpass123' }))
      .rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
    const after = await authService.login({ username: 'frank', password: 'newpass456' });
    expect(after.username).toBe('frank');
  });
});

describe('getUserById', () => {
  it('空 id 返回 null,未知 id 返回 null', async () => {
    expect(await authService.getUserById('')).toBeNull();
    expect(await authService.getUserById('user_missing')).toBeNull();
  });

  it('admin 短路返回管理员身份', async () => {
    const admin = await authService.getUserById('admin');
    expect(admin.role).toBe('admin');
  });

  it('普通用户返回公开字段映射', async () => {
    await authService.register({ username: 'grace', password: 'secret123', studentId: '20231234' });
    const user = await authService.login({ username: 'grace', password: 'secret123' });
    const fetched = await authService.getUserById(user.id);

    expect(fetched).toMatchObject({ username: 'grace', studentId: '20231234', role: 'user' });
    expect(fetched).not.toHaveProperty('password_hash');
  });
});
