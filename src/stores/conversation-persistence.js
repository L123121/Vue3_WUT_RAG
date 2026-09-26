// ==================== 会话持久化与后端同步 ====================
// 从 conversation.store.js 拆出：localStorage 防抖保存、后端消息同步（fire-and-forget）、
// beforeunload 刷盘与 30s 自动保存等模块级生命周期。
//
// 后端同步设计原则：
// - 非阻塞：后端同步失败不影响本地使用（localStorage 兜底）
// - 防抖：500ms 合并连续写入，避免流式每帧都发请求
// - 静默失败：catch 不弹 toast，仅 console.warn 留痕
// - 仅同步会话消息，不覆盖 title（title 由 renameConversation 单独管理）

import {
  saveCache,
  saveIncremental,
} from '../utils/conversationCache.js';
import { saveConversationMessages as apiSaveMessages } from '../api/conversations.js';
import { useAuthStore } from './auth.store.js';
import { useToastStore } from './toast.store.js';
import { reportError } from '../utils/errorHandler.js';
import { createLocalConversation } from '../utils/chatHelpers.js';

export const CURRENT_CONVERSATION_KEY = 'chat_current_conversation_id';

// 间接持有最近一次 store 实例的状态 getter（定时器/外部调用场景无法直接访问实例）
const latestStoreRef = { value: null };

let saveTimer = null;
let backendSyncTimer = null;
let lastSyncFailureToastAt = 0;

// 模块级单例：beforeunload 监听 + 自动保存定时器
// store 可能在 HMR/测试中被多次实例化，用模块级变量保证只注册一次，
// 并提供 dispose 以便测试 / 应用卸载时清理，避免内存与监听器泄漏。
let beforeUnloadRegistered = false;
let autoSaveTimer = null;

// 缓存按用户隔离：写入时带上当前登录用户的 id（游客为 guest 命名空间），
// 避免切号时读到别人的缓存，也让「未同步消息」能留在所属账号名下等下次登录迁移
export const currentCacheUserId = () => {
  try {
    return latestStoreRef.value?.userId ?? null;
  } catch {
    return null;
  }
};

// 同步失败提示：30s 内最多弹一次，避免后端重启期间连环弹窗
const notifySyncFailure = () => {
  const now = Date.now();
  if (now - lastSyncFailureToastAt < 30000) return;
  lastSyncFailureToastAt = now;
  try {
    useToastStore().error('消息同步到云端失败，本条消息已暂存本机，稍后会自动重试');
  } catch {
    // Pinia 未就绪（单测环境等）时忽略
  }
};

const triggerBackendSync = async (targetConvId = null) => {
  // 从模块变量读取最新 store 状态（兼容定时器/外部调用场景）
  const store = latestStoreRef.value;
  if (!store) return true;
  const convId = targetConvId || store.currentConversationId;
  // 本地会话不推后端：等 flushPendingChanges / loadConversations 统一迁移
  if (!convId || convId.startsWith('local_') || convId === 'local') return true;

  // 检查认证状态（直接调用 light 版本避免创建 auth store 实例竞争）
  try {
    const authStore = useAuthStore();
    if (!authStore.isAuthenticated) return true;
  } catch {
    return true; // 未初始化
  }

  const conv = store.conversations.find((c) => c.id === convId);
  if (!conv || !conv.messages || conv.messages.length === 0) return true;

  try {
    const saved = await apiSaveMessages(convId, conv.messages);
    if (!saved) throw new Error('服务端未确认会话消息保存成功');
    return true;
  } catch (e) {
    reportError('BackendSync', e, { convId });
    // 同步失败意味着这些消息的唯一副本还在 localStorage 里，
    // 必须让用户知道，避免误以为已上云后清理浏览器数据导致丢失
    notifySyncFailure();
    return false;
  }
};

const scheduleBackendSync = (delay = 500) => {
  if (backendSyncTimer) clearTimeout(backendSyncTimer);
  backendSyncTimer = setTimeout(() => {
    triggerBackendSync();
    backendSyncTimer = null;
  }, delay);
};

export const scheduleSave = (conversations, currentId, dirtyConvId) => {
  if (!conversations || conversations.length === 0) return; // 重置态：不把空列表写进缓存
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveIncremental(conversations, currentId, dirtyConvId, currentCacheUserId());
    saveTimer = null;
  }, 300);
};

export const flushSave = (conversations, currentId) => {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  saveCache(conversations, currentId, currentCacheUserId());
};

export const clearSaveTimers = () => {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  if (backendSyncTimer) { clearTimeout(backendSyncTimer); backendSyncTimer = null; }
};

export const ensureLocalFallback = (conversationsRef, currentConversationIdRef) => {
  const localConv = createLocalConversation('新会话');
  conversationsRef.value = [localConv];
  currentConversationIdRef.value = localConv.id;
  localStorage.setItem(CURRENT_CONVERSATION_KEY, localConv.id);
  flushSave(conversationsRef.value, currentConversationIdRef.value);
};

const beforeUnloadHandler = () => {
  const store = latestStoreRef.value;
  if (!store) return;
  // 空列表 = 重置/切号后的瞬时状态，写入会把缓存里未同步的消息覆盖掉
  if (store.conversations.length > 0) {
    flushSave(store.conversations, store.currentConversationId);
  }
  if (store.currentConversationId) {
    localStorage.setItem(CURRENT_CONVERSATION_KEY, store.currentConversationId);
  }
};

// 页面刷新/关闭前将未保存的数据刷入 localStorage
// 模块级单次注册：store 可能在 HMR/测试中被多次实例化，
// 用标志位避免重复注册 beforeunload 监听和定时器造成泄漏
const setupBeforeUnload = () => {
  if (beforeUnloadRegistered) return;
  beforeUnloadRegistered = true;
  window.addEventListener('beforeunload', beforeUnloadHandler);
};

// 定时自动保存（每 30 秒，确保聊天气泡的内容在刷新前已完成持久化）
const startAutoSaveTimer = () => {
  if (autoSaveTimer) return;
  autoSaveTimer = setInterval(() => {
    // 定时器在 store 外部，无法直接访问当前实例的 conversations；
    // 通过 latestStoreRef 间接引用最近一次实例化的 store
    const store = latestStoreRef.value;
    if (store && store.conversations.length > 0) {
      flushSave(store.conversations, store.currentConversationId);
    }
  }, 30000);
  if (autoSaveTimer && autoSaveTimer.unref) autoSaveTimer.unref();
};

// store 实例化时调用：注册生命周期监听 + 记录最新实例的状态 getter
export const setupStoreLifecycle = (snapshot) => {
  setupBeforeUnload();
  startAutoSaveTimer();
  latestStoreRef.value = snapshot;
};

// 供测试 / 应用卸载调用：清理模块级定时器与监听
export const disposeConversationStore = () => {
  if (autoSaveTimer) { clearInterval(autoSaveTimer); autoSaveTimer = null; }
  clearSaveTimers();
  if (beforeUnloadRegistered && typeof window !== 'undefined') {
    window.removeEventListener('beforeunload', beforeUnloadHandler);
    beforeUnloadRegistered = false;
  }
  latestStoreRef.value = null;
};

export { triggerBackendSync, scheduleBackendSync };
