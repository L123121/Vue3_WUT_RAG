import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import {
  fetchConversations,
  createConversation as apiCreateConversation,
  fetchConversation,
  renameConversation as apiRenameConversation,
  deleteConversation as apiDeleteConversation,
  saveConversationMessages as apiSaveMessages,
} from '../api/conversations.js';
import { useAuthStore } from './auth.store.js';
import { useToastStore } from './toast.store.js';
// 顶层 import 但只在函数体内调用（惰性）：与 message.store → useStreaming → 本模块
// 存在模块循环，运行时调用时各模块均已初始化完毕
import { useMessageStore } from './message.store.js';
import { reportError } from '../utils/errorHandler.js';
import {
  normalizeMessages,
  createWelcomeMessage,
  createLocalConversation,
  getMessageText,
} from '../utils/chatHelpers.js';
import { mergeMessageLists } from '../utils/messageFragments.js';
import {
  loadCache,
  saveCache,
  saveIncremental,
  clearCache,
  cleanupLegacyKeys,
} from '../utils/conversationCache.js';

const CURRENT_CONVERSATION_KEY = 'chat_current_conversation_id';

// ==================== 消息索引（加速查找） ====================
// messagesMap: messageId -> { conversationId, message }
// 纯索引结构，非响应式（避免深层依赖追踪开销），O(1) 按 ID 查找消息
const messagesMap = new Map();

function _registerMessage(convId, msg) {
  if (msg?.id) messagesMap.set(msg.id, { conversationId: convId, message: msg });
}

function _registerConversationMessages(convId, messages) {
  for (const msg of messages) _registerMessage(convId, msg);
}

function _unregisterMessage(msgId) {
  messagesMap.delete(msgId);
}

function _unregisterConversationMessages(convId) {
  for (const [id, entry] of messagesMap) {
    if (entry.conversationId === convId) messagesMap.delete(id);
  }
}

function _rebuildMessagesMap(conversations) {
  messagesMap.clear();
  for (const conv of conversations) {
    for (const msg of (conv.messages || [])) {
      _registerMessage(conv.id, msg);
    }
  }
}

// ==================== 统一缓存管理 ====================
// 使用 conversationCache.js 统一管理 localStorage 持久化
// 增量保存：300ms 防抖，只写发生变更的会话

let saveTimer = null;
let backendSyncTimer = null;
let loadingPromise = null; // loadConversations 并发保护：缓存 in-flight promise
let loadGeneration = 0; // 账号切换时使旧的异步加载结果失效

// ==================== 后端消息同步 ====================
// 在每次 localStorage 保存时，连带将消息推送到后端 API，
// 实现多端同步 + 安全存储（敏感内容不在 localStorage 停留）。
//
// 设计原则：
// - 非阻塞：后端同步失败不影响本地使用（localStorage 兜底）
// - 防抖：500ms 合并连续写入，避免流式每帧都发请求
// - 静默失败：catch 不弹 toast，仅 console.warn 留痕
// - 仅同步会话消息，不覆盖 title（title 由 renameConversation 单独管理）
const _triggerBackendSync = async (targetConvId = null) => {
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
    _notifySyncFailure();
    return false;
  }
};

const _scheduleBackendSync = (delay = 500) => {
  if (backendSyncTimer) clearTimeout(backendSyncTimer);
  backendSyncTimer = setTimeout(() => {
    _triggerBackendSync();
    backendSyncTimer = null;
  }, delay);
};

// 缓存按用户隔离：写入时带上当前登录用户的 id（游客为 guest 命名空间），
// 避免切号时读到别人的缓存，也让「未同步消息」能留在所属账号名下等下次登录迁移
const currentCacheUserId = () => {
  try {
    return latestStoreRef.value?.userId ?? null;
  } catch {
    return null;
  }
};

// 同步失败提示：30s 内最多弹一次，避免后端重启期间连环弹窗
let lastSyncFailureToastAt = 0;
const _notifySyncFailure = () => {
  const now = Date.now();
  if (now - lastSyncFailureToastAt < 30000) return;
  lastSyncFailureToastAt = now;
  try {
    useToastStore().error('消息同步到云端失败，本条消息已暂存本机，稍后会自动重试');
  } catch {
    // Pinia 未就绪（单测环境等）时忽略
  }
};

const scheduleSave = (conversations, currentId, dirtyConvId) => {
  if (!conversations || conversations.length === 0) return; // 重置态：不把空列表写进缓存
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveIncremental(conversations, currentId, dirtyConvId, currentCacheUserId());
    saveTimer = null;
  }, 300);
};

const flushSave = (conversations, currentId) => {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  saveCache(conversations, currentId, currentCacheUserId());
};

const ensureLocalFallback = (conversationsRef, currentConversationIdRef) => {
  const localConv = createLocalConversation('新会话');
  conversationsRef.value = [localConv];
  currentConversationIdRef.value = localConv.id;
  localStorage.setItem(CURRENT_CONVERSATION_KEY, localConv.id);
  flushSave(conversationsRef.value, currentConversationIdRef.value);
};

// 模块级单例：beforeunload 监听 + 自动保存定时器
// store 可能在 HMR/测试中被多次实例化，用模块级变量保证只注册一次，
// 并提供 dispose 以便测试 / 应用卸载时清理，避免内存与监听器泄漏。
let beforeUnloadRegistered = false;
let autoSaveTimer = null;
const latestStoreRef = { value: null }; // 间接持有最近一次 store 实例的状态 getter

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

// 供测试 / 应用卸载调用：清理模块级定时器与监听
export const disposeConversationStore = () => {
  if (autoSaveTimer) { clearInterval(autoSaveTimer); autoSaveTimer = null; }
  if (backendSyncTimer) { clearTimeout(backendSyncTimer); backendSyncTimer = null; }
  if (beforeUnloadRegistered && typeof window !== 'undefined') {
    window.removeEventListener('beforeunload', beforeUnloadHandler);
    beforeUnloadRegistered = false;
  }
  latestStoreRef.value = null;
};

export const useConversationStore = defineStore('conversation', () => {
  let authStore = null;

  const getAuthStore = () => {
    if (!authStore) authStore = useAuthStore();
    return authStore;
  };

  const conversations = ref([]);
  const currentConversationId = ref(localStorage.getItem(CURRENT_CONVERSATION_KEY) || '');
  const isLoaded = ref(false);

  const currentConversation = computed(() =>
    conversations.value.find((c) => c.id === currentConversationId.value)
  );

  const sortedConversations = computed(() =>
    [...conversations.value].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
  );

  const isLocalSession = (id) => !id || id === 'local' || id.startsWith('local_');

  // 惰性获取消息 store（conversation ↔ message 存在模块循环，运行时各模块已就绪）
  const tryMessageStore = () => {
    try { return useMessageStore(); } catch { return null; }
  };

  // 有流式进行中时按需中止：
  // - 切换会话：旧流若指向其他会话，中止以避免旧流继续写旧会话、currentStreamingId 错配
  // - 删除会话：流式目标正是被删会话时中止
  const abortStreamFor = (condition) => {
    const messageStore = tryMessageStore();
    if (messageStore?.isLoading && condition(messageStore)) {
      messageStore.abortCurrentRequest();
    }
  };

  /**
   * 将调用方就地创建的本地会话（local_ 前缀）收入列表并置为当前会话，
   * 同时完成持久化。供 useStreaming 等无法走 createConversation 的场景使用
   * （后端可能可用但 store 尚未加载，必须保持本地会话）。
   */
  const adoptLocalConversation = (conv) => {
    if (!conv?.id || conversations.value.some((c) => c.id === conv.id)) return;
    conversations.value.push(conv);
    currentConversationId.value = conv.id;
    localStorage.setItem(CURRENT_CONVERSATION_KEY, conv.id);
    _registerMessage(conv.id, conv.messages?.[0]);
    flushSave(conversations.value, conv.id);
  };

  const isBackendAvailable = () => {
    const auth = getAuthStore();
    return auth.isAuthenticated;
  };

  const persistLocalConversation = async (conversation) => {
    let created = null;
    try {
      created = await apiCreateConversation(conversation.title || '新会话');
      const messages = Array.isArray(conversation.messages) ? conversation.messages : [];
      if (messages.length > 0) {
        const saved = await apiSaveMessages(created.id, messages);
        if (!saved) throw new Error('本地会话消息迁移失败');
      }
      return { ...created, messages };
    } catch (error) {
      if (created?.id) {
        try { await apiDeleteConversation(created.id); } catch {}
      }
      throw error;
    }
  };

  const migrateLocalConversations = async (localConversations) => {
    const replacements = new Map();
    let allSucceeded = true;

    for (const conversation of localConversations) {
      try {
        const persisted = await persistLocalConversation(conversation);
        replacements.set(conversation.id, persisted);
      } catch (error) {
        allSucceeded = false;
        reportError('ConversationMigration', error, { conversationId: conversation.id });
      }
    }

    return { replacements, allSucceeded };
  };

  const restoreCachedState = (cached) => {
    const cachedConversations = Array.isArray(cached?.conversations) ? cached.conversations : [];
    if (cachedConversations.length === 0) return false;

    conversations.value = cachedConversations.map((conversation) => ({
      ...conversation,
      messages: normalizeMessages(conversation.messages || []),
    }));
    const preferredId = cached.currentId || currentConversationId.value;
    currentConversationId.value = cachedConversations.some((conv) => conv.id === preferredId)
      ? preferredId
      : cachedConversations[0].id;
    localStorage.setItem(CURRENT_CONVERSATION_KEY, currentConversationId.value);
    return true;
  };

  const loadConversations = async () => {
    // 并发保护：如果已有正在加载的请求，复用同一个 promise
    if (loadingPromise) return loadingPromise;

    const generation = loadGeneration;
    const request = (async () => {
      const cached = loadCache(currentCacheUserId());
      const hasCachedConversations = restoreCachedState(cached);

      if (!isBackendAvailable()) {
        if (!hasCachedConversations && conversations.value.length === 0) {
          ensureLocalFallback(conversations, currentConversationId);
        }
        isLoaded.value = true;
        _rebuildMessagesMap(conversations.value);
        return;
      }

      if (cached) console.debug(`[Cache] 找到缓存: ${cached.conversations?.length || 0} 个会话, currentId=${cached.currentId?.substring(0, 20)}`);
      else console.warn('[Cache] 缓存为空或版本不匹配');

      try {
        const data = await fetchConversations();
        if (generation !== loadGeneration) return;

        // null 表示请求失败：保留缓存；空数组表示服务端确实没有会话。
        if (data === null) {
          if (conversations.value.length === 0) {
            ensureLocalFallback(conversations, currentConversationId);
          }
          isLoaded.value = true;
          _rebuildMessagesMap(conversations.value);
          return;
        }

        const cachedConversations = Array.isArray(cached?.conversations) ? cached.conversations : [];
        const cachedById = new Map(cachedConversations.map((conv) => [conv.id, conv]));
        const serverIds = new Set(data.map(c => c.id));
        const serverConvs = data.map((conv) => ({
          ...conv,
          messages: mergeMessageLists(
            cachedById.get(conv.id)?.messages || [],
            conv.messages || [],
          ),
        }));
        // 只保留真正的 local_ 会话；失效的 conv_ 说明服务端已删除，不能重新合并回来。
        const localOnly = cachedConversations.filter((conv) =>
          isLocalSession(conv.id) && !serverIds.has(conv.id)
        );
        const migration = await migrateLocalConversations(localOnly);
        const migratedLocal = localOnly.map((conv) => migration.replacements.get(conv.id) || conv);
        conversations.value = [...serverConvs, ...migratedLocal];

        const migratedCurrent = migration.replacements.get(currentConversationId.value);
        if (migratedCurrent) currentConversationId.value = migratedCurrent.id;

        if (conversations.value.length === 0) {
          try {
            const serverConv = await apiCreateConversation('新会话');
            conversations.value = [{ ...serverConv, messages: [createWelcomeMessage()] }];
          } catch (error) {
            reportError('createInitialConversation', error);
            const localConv = createLocalConversation('新会话');
            conversations.value = [localConv];
          }
        }

        if (!conversations.value.some((conv) => conv.id === currentConversationId.value)) {
          currentConversationId.value = conversations.value[0].id;
        }

        localStorage.setItem(CURRENT_CONVERSATION_KEY, currentConversationId.value);
        isLoaded.value = true;
        cleanupLegacyKeys();
        _rebuildMessagesMap(conversations.value);
        flushSave(conversations.value, currentConversationId.value);
      } catch (error) {
        if (generation !== loadGeneration) return;
        reportError('loadConversations', error);
        if (conversations.value.length === 0) {
          ensureLocalFallback(conversations, currentConversationId);
        }
        isLoaded.value = true;
        _rebuildMessagesMap(conversations.value);
      }
    })();

    loadingPromise = request;
    request.then(
      () => { if (loadingPromise === request) loadingPromise = null; },
      () => { if (loadingPromise === request) loadingPromise = null; }
    );
    return request;
  };

  // 从统一缓存恢复消息（兼容旧版备份迁移）
  const createConversation = async (title) => {
    if (!isBackendAvailable()) {
      const localConv = createLocalConversation(title, conversations.value.length);
      conversations.value.unshift(localConv);
      currentConversationId.value = localConv.id;
      localStorage.setItem(CURRENT_CONVERSATION_KEY, localConv.id);
      _registerMessage(localConv.id, localConv.messages?.[0]);
      return localConv.id;
    }

    try {
      const conv = await apiCreateConversation(title || `新会话 ${conversations.value.length + 1}`);
      const welcomeMsg = createWelcomeMessage();
      conversations.value.unshift({ ...conv, messages: [welcomeMsg] });
      currentConversationId.value = conv.id;
      localStorage.setItem(CURRENT_CONVERSATION_KEY, conv.id);
      _registerMessage(conv.id, welcomeMsg);
      flushSave(conversations.value, conv.id);
      return conv.id;
    } catch (error) {
      console.error('创建会话失败:', error);
      const localConv = createLocalConversation(title, conversations.value.length);
      conversations.value.unshift(localConv);
      currentConversationId.value = localConv.id;
      localStorage.setItem(CURRENT_CONVERSATION_KEY, localConv.id);
      _registerMessage(localConv.id, localConv.messages?.[0]);
      return localConv.id;
    }
  };

  const switchConversation = async (id) => {
    if (!conversations.value.some((c) => c.id === id)) return;
    // 切换前若仍有指向其他会话的活跃流式，先中止，避免旧流继续往旧会话写消息
    abortStreamFor((messageStore) =>
      messageStore.activeStreamingConversationId && messageStore.activeStreamingConversationId !== id
    );
    currentConversationId.value = id;
    localStorage.setItem(CURRENT_CONVERSATION_KEY, id);

    const conv = conversations.value.find((c) => c.id === id);
    if (!isLocalSession(id) && isBackendAvailable()) {
      await loadConversationMessages(id);
    } else if (conv && (!conv.messages || conv.messages.length === 0)) {
      conv.messages = [createWelcomeMessage()];
      _registerConversationMessages(id, conv.messages);
    }
    flushSave(conversations.value, id);
  };

  const loadConversationMessages = async (conversationId) => {
    if (isLocalSession(conversationId) || !isBackendAvailable()) return;

    try {
      const conv = await fetchConversation(conversationId);
      // 竞态条件防护：加载完成后验证当前会话是否已切换
      if (currentConversationId.value !== conversationId) return;
      const index = conversations.value.findIndex((c) => c.id === conversationId);
      if (index !== -1 && conv) {
        const fetched = normalizeMessages(conv.messages);
        // 本地列表可能包含同步失败期间未上传的消息，服务端也可能有其他端新增消息；
        // 按消息列表长度选择主序列，并对同 ID 消息保留更丰富的 Fragment 记录。
        const local = normalizeMessages(conversations.value[index].messages || []);
        const merged = mergeMessageLists(local, fetched);
        conversations.value[index].messages = merged.length > 0 ? merged : [createWelcomeMessage()];
        conversations.value[index].title = conv.title;
        // 消息整体替换，重建该会话的索引
        _unregisterConversationMessages(conversationId);
        _registerConversationMessages(conversationId, conversations.value[index].messages);
        flushSave(conversations.value, currentConversationId.value);
        // 本地比服务端长 = 有同步失败期间积压的消息，此时刚登录成功、后端可用，立即补传
        if (local.length > fetched.length) {
          _triggerBackendSync(conversationId);
        }
      }
    } catch (error) {
      reportError('loadConversationMessages', error, { conversationId });
    }
  };

  /**
   * 将后端返回的分叉会话并入本地列表并切换（消息已在后端复制好）
   * @returns {string|null} 新会话 id
   */
  const importForkedConversation = (conv) => {
    if (!conv?.id) return null;
    if (!conversations.value.some((c) => c.id === conv.id)) {
      const messages = normalizeMessages(conv.messages || []);
      conversations.value.push({ ...conv, messages });
      _registerConversationMessages(conv.id, messages);
      flushSave(conversations.value, currentConversationId.value);
    }
    return conv.id;
  };

  const renameConversation = async (id, title) => {
    const trimmedTitle = title.trim();
    if (!trimmedTitle) return;

    const conv = conversations.value.find((c) => c.id === id);
    if (conv) conv.title = trimmedTitle;
    if (!isLocalSession(id) && isBackendAvailable()) {
      try {
        await apiRenameConversation(id, trimmedTitle);
      } catch (error) {
        console.error('重命名会话失败:', error);
      }
    }
    scheduleSave(conversations.value, currentConversationId.value, id);
  };

  const deleteConversation = async (id) => {
    const targetIndex = conversations.value.findIndex((c) => c.id === id);
    if (targetIndex === -1) return;

    // 如果正在删除的会话有流式传输，先中止
    abortStreamFor((messageStore) => messageStore.activeStreamingConversationId === id);

    conversations.value.splice(targetIndex, 1);
    // 删除会话时同步清理该会话的消息索引
    _unregisterConversationMessages(id);

    if (!isLocalSession(id) && isBackendAvailable()) {
      try {
        await apiDeleteConversation(id);
      } catch (error) {
        console.error('删除会话失败:', error);
      }
    }

    if (currentConversationId.value === id) {
      if (conversations.value.length === 0) {
        await createConversation('默认会话');
      } else {
        currentConversationId.value = conversations.value[Math.max(0, targetIndex - 1)]?.id || conversations.value[0].id;
      }
    }

    // 同步删除 localStorage 中的缓存，防止刷新后恢复已删除会话
    flushSave(conversations.value, currentConversationId.value);
  };

  // 去除 markdown 标记符号，用于预览文本显示
  const stripMarkdown = (text) => {
    if (!text) return '';
    return text
      // 加粗/斜体/删除线：**text**、*text*、__text__、~~text~~
      .replace(/(\*{1,3}|_{1,3}|~~)(.+?)\1/g, '$2')
      // 行内代码：`text`
      .replace(/`([^`]+)`/g, '$1')
      // 标题标记：### text → text
      .replace(/^#{1,6}\s+/gm, '')
      // 列表标记：- text、* text、+ text、1. text
      .replace(/^[\s]*[-*+]\s+/gm, '')
      .replace(/^[\s]*\d+\.\s+/gm, '')
      // 引用标记：> text
      .replace(/^>\s+/gm, '')
      // 链接： [text](url) → text
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      // 图片： ![alt](url) → alt
      .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
      // 清理多余空格和换行
      .replace(/\s+/g, ' ')
      .trim();
  };

  const getLastMessagePreview = (conversation) => {
    const lastMessage = [...(conversation.messages || [])]
      .reverse()
      .find((m) => m.id !== 'welcome' && getMessageText(m));
    if (!lastMessage) return '点击开始新对话';
    const text = stripMarkdown(getMessageText(lastMessage));
    return text.length > 22 ? `${text.slice(0, 22)}...` : text;
  };

  // 统一消息文本读取（优先 content，降级 text）— 已从 chatHelpers 导入

  // ========== 统一 localStorage 持久化 ==========

  // 流式进行中跳过后端全量同步：半截消息会随每个 500ms token 停顿反复 PUT
  // 整个会话（内容线性增长、每次都是立即过期的中间态）；收尾（done/error/abort）
  // 会以 immediate=true 补一次权威同步。其他会话的变更不受影响，照常防抖同步
  const _isStreamingConversation = (conv) => {
    try {
      const streamingConvId = useMessageStore().activeStreamingConversationId;
      return !!streamingConvId && (!conv || conv.id === streamingConvId);
    } catch {
      return false; // store 未就绪按非流式处理
    }
  };

  const scheduleSaveCache = (immediate = false, targetConvId = null) => {
    const conv = currentConversation.value;
    if (immediate) {
      flushSave(conversations.value, currentConversationId.value);
      _triggerBackendSync(targetConvId); // 立即同步到后端（fire-and-forget）
    } else {
      scheduleSave(conversations.value, currentConversationId.value, conv?.id);
      if (!_isStreamingConversation(conv)) {
        _scheduleBackendSync(500); // 防抖同步到后端
      }
    }
  };

  const flushPendingChanges = async () => {
    abortStreamFor(() => true);
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    if (backendSyncTimer) { clearTimeout(backendSyncTimer); backendSyncTimer = null; }

    flushSave(conversations.value, currentConversationId.value);

    if (isBackendAvailable()) {
      const localConversations = conversations.value.filter((conv) => isLocalSession(conv.id));
      if (localConversations.length > 0) {
        const migration = await migrateLocalConversations(localConversations);
        conversations.value = conversations.value.map((conv) => migration.replacements.get(conv.id) || conv);

        const migratedCurrent = migration.replacements.get(currentConversationId.value);
        if (migratedCurrent) currentConversationId.value = migratedCurrent.id;

        _rebuildMessagesMap(conversations.value);
        flushSave(conversations.value, currentConversationId.value);
        if (!migration.allSucceeded) return false;
      }
    }

    return _triggerBackendSync();
  };

  const resetConversationState = () => {
    abortStreamFor(() => true);
    loadGeneration += 1;
    loadingPromise = null;
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    if (backendSyncTimer) { clearTimeout(backendSyncTimer); backendSyncTimer = null; }
    conversations.value = [];
    currentConversationId.value = '';
    isLoaded.value = false;
    messagesMap.clear();
    localStorage.removeItem(CURRENT_CONVERSATION_KEY);
    // ⚠️ 故意不删除会话缓存（chat_cache:<userId>）：里面可能留着同步失败期间
    // 未上传的消息（唯一副本）。登录/切号后各自的缓存留在各自命名空间，
    // 下次 loadConversations 会迁移 local_ 会话并按需补传消息。
    // 只有确认同步成功的登出流程才允许调 clearPersistedCache() 清理。
  };

  // 清空当前用户的会话缓存（含旧版全局 key）。
  // 仅在「已确认后端同步成功」的登出流程调用；登录/401 路径禁止调用。
  const clearPersistedCache = () => {
    let userId = null;
    try { userId = getAuthStore().user?.id || null; } catch { /* 未初始化 */ }
    clearCache(userId);
    localStorage.removeItem(CURRENT_CONVERSATION_KEY);
  };

  // 页面刷新/关闭前将未保存的数据刷入 localStorage
  // 模块级单次注册：store 可能在 HMR/测试中被多次实例化，
  // 用标志位避免重复注册 beforeunload 监听和定时器造成泄漏
  const setupBeforeUnload = () => {
    if (beforeUnloadRegistered) return;
    beforeUnloadRegistered = true;
    window.addEventListener('beforeunload', beforeUnloadHandler);
  };
  setupBeforeUnload();

  // 定时自动保存（每 30 秒，确保聊天气泡的内容在刷新前已完成持久化）
  if (!autoSaveTimer) {
    autoSaveTimer = setInterval(() => {
      // 定时器在 store 外部，无法直接访问当前实例的 conversations；
      // 通过 latestStoreRef 间接引用最近一次实例化的 store
      const store = latestStoreRef.value;
      if (store && store.conversations.length > 0) {
        flushSave(store.conversations, store.currentConversationId);
      }
    }, 30000);
    if (autoSaveTimer && autoSaveTimer.unref) autoSaveTimer.unref();
  }
  latestStoreRef.value = {
    get conversations() { return conversations.value; },
    get currentConversationId() { return currentConversationId.value; },
    get userId() {
      try { return getAuthStore().user?.id || null; } catch { return null; }
    },
  };

  return {
    conversations,
    currentConversationId,
    currentConversation,
    sortedConversations,
    isLoaded,
    loadConversations,
    loadConversationMessages,
    createConversation,
    switchConversation,
    adoptLocalConversation,
    importForkedConversation,
    renameConversation,
    deleteConversation,
    getLastMessagePreview,
    isLocalSession,
    isBackendAvailable,
    scheduleSaveCache,
    flushPendingChanges,
    resetConversationState,
    clearPersistedCache,
    // 消息索引 API（O(1) 按 ID 查找，供外部修改消息后同步）
    getMessage: (id) => messagesMap.get(id) || null,
    registerMessage: _registerMessage,
    unregisterMessage: _unregisterMessage,
    rebuildMessagesMap: () => _rebuildMessagesMap(conversations.value),
  };
});
