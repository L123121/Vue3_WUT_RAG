import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { API_URL } from '../api/client.js';

const USER_KEY = 'user';
const AUTH_REQUEST_TIMEOUT_MS = 130000;

const readStoredUser = () => {
  try {
    return JSON.parse(localStorage.getItem(USER_KEY) || 'null');
  } catch {
    localStorage.removeItem(USER_KEY);
    return null;
  }
};

const createAuthError = ({ code = 'AUTH_ERROR', message = '登录失败，请稍后重试', status = 500 } = {}) => {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
};

const postAuth = async (path, body, timeoutMs = AUTH_REQUEST_TIMEOUT_MS) => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${API_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const data = await response.json().catch(() => null);

    if (!response.ok || !data?.success) {
      throw createAuthError({
        code: data?.code || 'AUTH_ERROR',
        message: data?.message || `HTTP ${response.status}`,
        status: response.status,
      });
    }

    return data;
  } catch (error) {
    if (error.name === 'AbortError') {
      throw createAuthError({
        code: 'LOGIN_TIMEOUT',
        message: '登录超时，教务系统响应过慢，请稍后重试',
        status: 504,
      });
    }

    if (error.code) throw error;

    throw createAuthError({
      code: 'NETWORK_ERROR',
      message: '无法连接到服务器，请确认后端服务已启动',
      status: 0,
    });
  } finally {
    clearTimeout(timeoutId);
  }
};

export const useAuthStore = defineStore('auth', () => {
  const user = ref(readStoredUser());
  const hasCheckedSession = ref(false);

  const isAuthenticated = computed(() => !!user.value);
  const isAdmin = computed(() => user.value?.role === 'admin');

  const setUser = (userData) => {
    user.value = userData || null;
    if (user.value) {
      localStorage.setItem(USER_KEY, JSON.stringify(user.value));
    } else {
      localStorage.removeItem(USER_KEY);
    }
    hasCheckedSession.value = true;
  };

  const finishLogin = (userData) => {
    const nextUser = userData?.role ? userData : { ...userData, role: 'user' };
    setUser(nextUser);
    return nextUser;
  };

  const register = async (username, password, inviteCode) => {
    const uname = String(username || '').trim();
    const pwd = String(password || '');

    if (!uname || !pwd) {
      throw createAuthError({ code: 'MISSING_CREDENTIALS', message: '请输入用户名和密码', status: 400 });
    }

    // 站点配置 AUTH_INVITE_CODE 时后端强制校验；未配置时后端忽略该字段
    const data = await postAuth('/auth/register', {
      username: uname,
      password: pwd,
      ...(inviteCode ? { inviteCode: String(inviteCode).trim() } : {}),
    }, 30000);
    const loggedInUser = data?.data?.user;
    if (!loggedInUser) {
      throw createAuthError({ code: 'INVALID_RESPONSE', message: '注册成功但未获取到用户信息' });
    }

    return finishLogin(loggedInUser);
  };

  const login = async (username, password) => {
    const uname = String(username || '').trim();
    const pwd = String(password || '');

    if (!uname || !pwd) {
      throw createAuthError({ code: 'MISSING_CREDENTIALS', message: '请输入用户名和密码', status: 400 });
    }

    const data = await postAuth('/auth/login', { username: uname, password: pwd }, 30000);
    const loggedInUser = data?.data?.user;
    if (!loggedInUser) {
      throw createAuthError({ code: 'INVALID_RESPONSE', message: '登录成功但未获取到用户信息' });
    }

    return finishLogin(loggedInUser);
  };

  const changePassword = async (currentPassword, newPassword) => {
    const c = String(currentPassword || '');
    const n = String(newPassword || '');

    if (!c || !n) {
      throw createAuthError({ code: 'MISSING_CREDENTIALS', message: '请填写当前密码和新密码', status: 400 });
    }

    return await postAuth('/auth/change-password', { currentPassword: c, newPassword: n }, 30000);
  };

  const fetchCurrentUser = async () => {
    try {
      const response = await fetch(`${API_URL}/auth/me`, {
        method: 'GET',
        credentials: 'include',
      });
      const data = await response.json().catch(() => null);
      if (response.ok && data?.success && data.data?.user) {
        setUser(data.data.user);
        return data.data.user;
      }
      user.value = null;
      localStorage.removeItem(USER_KEY);
      return null;
    } catch {
      user.value = null;
      localStorage.removeItem(USER_KEY);
      return null;
    } finally {
      hasCheckedSession.value = true;
    }
  };

  const logout = async () => {
    user.value = null;
    hasCheckedSession.value = true;
    localStorage.removeItem(USER_KEY);
    // ⚠️ 不在这里清会话缓存：未同步的消息（唯一副本）必须保留到所属用户的
    // 命名空间（chat_cache:<userId>），等下次登录后迁移。清理由登出流程中
    // 确认同步成功后的 conversationStore.clearPersistedCache() 负责。
    localStorage.removeItem('chat_current_conversation_id');
    localStorage.removeItem('chat_cleared_conversations');

    try {
      await fetch(`${API_URL}/auth/logout`, {
        method: 'POST',
        credentials: 'include',
      });
    } catch {
      // 登出请求失败不影响本地清理
    }
  };

  const updateUser = (updates) => {
    if (user.value) {
      user.value = { ...user.value, ...updates };
      localStorage.setItem(USER_KEY, JSON.stringify(user.value));
    }
  };

  return {
    user,
    hasCheckedSession,
    isAuthenticated,
    isAdmin,
    login,       // 账号密码登录（API 方法，管理员也走这里）
    setUser,     // 内部设置登录状态
    register,
    changePassword,
    fetchCurrentUser,
    logout,
    updateUser,
  };
});
