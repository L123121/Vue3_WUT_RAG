import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useAuthStore } from '../stores/auth.store.js';

describe('authStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('starts unauthenticated', () => {
    const store = useAuthStore();
    expect(store.isAuthenticated).toBe(false);
    expect(store.user).toBeNull();
  });

  it('clears authentication but preserves conversation cache on logout', async () => {
    let resolveLogout;
    vi.stubGlobal('fetch', vi.fn(() => new Promise((resolve) => {
      resolveLogout = resolve;
    })));
    const store = useAuthStore();
    store.setUser({ id: 'user-1', name: 'User' });
    localStorage.setItem('chat_cache:user-1', '{"version":1}');
    localStorage.setItem('chat_current_conversation_id', 'conv_private');

    const logoutPromise = store.logout();

    expect(store.isAuthenticated).toBe(false);
    expect(localStorage.getItem('user')).toBeNull();
    expect(localStorage.getItem('chat_current_conversation_id')).toBeNull();
    // 缓存保留：可能有未同步消息的唯一副本，清理由登出流程中
    // 确认同步成功后的 clearPersistedCache 负责
    expect(localStorage.getItem('chat_cache:user-1')).not.toBeNull();

    resolveLogout({ ok: true });
    await logoutPromise;
  });

  // 以下用例曾因依赖后端 API 被 skip（且对的是已废弃的 login({name,studentId}) 内存 API）。
  // 现按现行 auth.store 契约重写：stub fetch 覆盖 postAuth 响应，验证状态与持久化行为。
  describe('登录/登出状态机(mock fetch)', () => {
    const authResponse = (user) => ({
      ok: true,
      status: 200,
      json: async () => ({ success: true, data: { user } }),
    });

    it('logs in with user data', async () => {
      vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(authResponse({ id: 'u1', name: 'Test', studentId: '123' }))));
      const store = useAuthStore();
      const loggedIn = await store.login('Test', '123');

      expect(store.isAuthenticated).toBe(true);
      expect(store.user.name).toBe('Test');
      expect(store.user.studentId).toBe('123');
      // 后端未下发 role 时默认普通用户
      expect(loggedIn.role).toBe('user');
    });

    it('logs out and clears state', async () => {
      vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(authResponse({ id: 'u1', name: 'Test', studentId: '123' }))));
      const store = useAuthStore();
      await store.login('Test', '123');
      await store.logout();

      expect(store.isAuthenticated).toBe(false);
      expect(store.user).toBeNull();
      expect(localStorage.getItem('user')).toBeNull();
    });

    it('updates user profile', async () => {
      vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(authResponse({ id: 'u1', name: 'Old', studentId: '123' }))));
      const store = useAuthStore();
      await store.login('Old', '123');
      store.updateUser({ name: 'New' });

      expect(store.user.name).toBe('New');
    });

    it('persists user to localStorage', async () => {
      vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(authResponse({ id: 'u1', name: 'Test', studentId: '123' }))));
      const store = useAuthStore();
      await store.login('Test', '123');

      const stored = JSON.parse(localStorage.getItem('user'));
      expect(stored.name).toBe('Test');
      expect(stored.role).toBe('user');
    });

    it('does not persist token to localStorage', async () => {
      vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(authResponse({ id: 'u1', name: 'Test', studentId: '123' }))));
      const store = useAuthStore();
      await store.login('Test', '123');

      // 会话凭证走 HttpOnly cookie，localStorage 只存用户资料
      expect(localStorage.getItem('token')).toBeNull();
    });

    it('rejects empty credentials without network call', async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      const store = useAuthStore();

      await expect(store.login('Test', '')).rejects.toMatchObject({ code: 'MISSING_CREDENTIALS' });
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
