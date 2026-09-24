<script setup>
import { ref, watch, computed, onMounted, onBeforeUnmount } from 'vue';
import { useConversationStore } from '../stores/conversation.store.js';
import { useMessageStore } from '../stores/message.store.js';
import { useToastStore } from '../stores/toast.store.js';
import { useFavoritesStore } from '../stores/favorites.store.js';
import { Bot, Eraser, Download, ClipboardCopy, FileText, FileCode2, Share2, BookOpen, GraduationCap, Landmark, Library, Volume2, VolumeX } from 'lucide-vue-next';
import MessageList from '../components/chat/MessageList.vue';
import ChatBox from '../components/chat/ChatBox.vue';
import ConfirmDialog from '../components/common/ConfirmDialog.vue';
import MobileMenuButton from '../components/layout/MobileMenuButton.vue';
import { useSpeechPlayer } from '../composables/useSpeechPlayer.js';
import { useConversationExport } from '../composables/useConversationExport.js';
import { useChatScroll } from '../composables/useChatScroll.js';
import { buildStarterQuestions } from '../utils/starterQuestions.js';
import { getDocuments } from '../api/rag.js';

const conversationStore = useConversationStore();
const messageStore = useMessageStore();
const toast = useToastStore();
const favoritesStore = useFavoritesStore();
const speechPlayer = useSpeechPlayer();
const autoSpeak = ref(localStorage.getItem('chat_auto_speak') === 'true');
const { messageListRef, chatBoxRef, focusChatInput, scrollToBottom, scrollToFavoritedMessage } = useChatScroll(favoritesStore);
const { showExportMenu, copyConversationAsText, exportConversation, exportConversationAsHtml, shareConversation } = useConversationExport(conversationStore, toast);

// 当前会话消息列表（模板中自动解包，脚本内需 .value）
const messages = computed(() => conversationStore.currentConversation?.messages || []);

// 空状态示例问题：优先从知识库文档动态生成（按类别打散取多样主题），拉取失败退回静态兜底
const exampleQuestions = ref([
  { icon: Landmark, text: '校园卡丢了怎么补办？' },
  { icon: Library, text: '图书馆期末周几点闭馆？' },
  { icon: GraduationCap, text: '推免保研需要准备哪些材料？' },
  { icon: BookOpen, text: '大二专业课复习怎么规划？' },
]);

onMounted(async () => {
  try {
    const res = await getDocuments();
    const documents = res?.data?.documents || res?.data || [];
    const dynamic = buildStarterQuestions(documents, 4);
    if (dynamic.length >= 3) {
      exampleQuestions.value = dynamic.map((item) => ({ icon: BookOpen, text: item.text }));
    }
  } catch {
    // 知识库不可用时保持静态兜底，不打扰用户
  }
});

watch(() => favoritesStore.pendingScrollMessageId, (id) => {
  scrollToFavoritedMessage(id);
});

const currentTitle = computed(() => conversationStore.currentConversation?.title || 'AI 助手');
const effectiveMessageCount = computed(() => messages.value.filter((msg) => msg.id !== 'welcome' && msg.text?.trim()).length);
const canClear = computed(() => effectiveMessageCount.value > 0 && !messageStore.isLoading);

const showClearConfirm = ref(false);

const confirmClear = () => {
  showClearConfirm.value = false;
  Promise.resolve(messageStore.clearMessages()).catch((e) => {
    console.error('[AIChat] 清空会话异常:', e);
  });
};

// V2.0：对话模式由后端意图识别自动路由，前端不再手动切换 RAG

const handleSend = async (message, fileData = null) => {
  speechPlayer.stop();
  try {
    await messageStore.sendMessage(message, null, fileData);
    if (autoSpeak.value) {
      const reply = [...messages.value].reverse().find((item) => item.role === 'model' && !item.isError && item.text?.trim());
      if (reply) {
        void speechPlayer.play(reply.id, reply.text)
          .then((result) => {
            if (result?.truncated) toast.warning('回答较长，本次仅朗读前 4000 字');
          })
          .catch((speechError) => {
            if (speechError?.name === 'AbortError') return;
            console.error('[AIChat] 自动朗读失败:', speechError);
            toast.warning(speechError?.message || '回答已生成，但自动朗读失败');
          });
      }
    }
  } catch (e) {
    console.error('[AIChat] 发送失败:', e);
    toast.error(e?.message || '发送失败，请检查网络后重试');
  }
  scrollToBottom();
};

const toggleAutoSpeak = () => {
  autoSpeak.value = !autoSpeak.value;
  localStorage.setItem('chat_auto_speak', String(autoSpeak.value));
  if (!autoSpeak.value) speechPlayer.stop();
  toast.success(autoSpeak.value ? '已开启 AI 自动朗读' : '已关闭 AI 自动朗读');
};

const handleError = (message) => {
  toast.error(message);
};

const handleCopy = () => {
  toast.success('内容已复制到剪贴板');
};

// 导出对话
const handleCommand = (command) => {
  if (command === 'export') {
    exportConversation();
  }
};

const initializeChat = async () => {
  await conversationStore.loadConversations();

  // 没有消息备份，走正常加载流程
  if (conversationStore.currentConversationId) {
    await conversationStore.loadConversationMessages(conversationStore.currentConversationId);
  }
  await scrollToBottom();
};

watch(() => messages.value.length, scrollToBottom);
watch(() => conversationStore.currentConversationId, scrollToBottom);
onMounted(() => {
  // Pinia store 跨路由切换保持存活。
  // 只有首次加载（页面刷新）才需要从 localStorage/后端拉数据，
  // 切换标签页回来时 store 里的消息仍然存在，无需重新加载。
  if (!conversationStore.isLoaded) {
    initializeChat();
  }
});
onBeforeUnmount(() => speechPlayer.stop());
</script>

<template>
  <div class="flex flex-col h-full bg-white dark:bg-gray-900 overflow-hidden relative">
    <div class="absolute inset-0 opacity-[0.03] dark:opacity-[0.05] pointer-events-none" style="background-image: radial-gradient(circle at 2px 2px, gray 1px, transparent 0); background-size: 24px 24px;"></div>

    <!-- 顶部标题栏 -->
    <div class="bg-white/90 dark:bg-gray-900/90 backdrop-blur-sm p-4 border-b border-slate-200 dark:border-gray-700 flex items-center justify-between z-10 gap-3 shrink-0">
      <div class="flex items-center min-w-0">
        <MobileMenuButton />
        <div class="w-9 h-9 rounded-xl bg-wut-600 flex items-center justify-center mr-3 shadow-lg shadow-wut-500/20 text-white">
          <Bot :size="20" />
        </div>
        <div class="min-w-0">
          <h3 class="font-bold text-slate-800 dark:text-white text-sm truncate">{{ currentTitle }}</h3>
          <div class="flex items-center mt-0.5">
            <span class="w-1.5 h-1.5 rounded-full bg-wut-500 mr-1.5 animate-pulse"></span>
            <span class="text-[10px] font-medium text-slate-500 dark:text-gray-400 uppercase tracking-wide">AI 助手</span>
            <span class="mx-1 text-slate-300 dark:text-gray-600">·</span>
            <span class="text-[10px] text-slate-500 dark:text-gray-400">{{ effectiveMessageCount }} 条消息</span>
          </div>
        </div>
      </div>
      <div class="flex items-center gap-1.5 relative">
        <button
          type="button"
          @click="toggleAutoSpeak"
          :class="[
            'h-9 px-2.5 rounded-lg inline-flex items-center gap-1.5 text-xs font-medium transition-colors duration-200',
            autoSpeak
              ? 'bg-wut-50 dark:bg-wut-900/30 text-wut-700 dark:text-wut-300'
              : 'text-slate-400 hover:text-slate-600 dark:hover:text-gray-200 hover:bg-slate-100 dark:hover:bg-gray-800'
          ]"
          :title="autoSpeak ? '关闭 AI 自动朗读' : '开启 AI 自动朗读'"
          :aria-pressed="autoSpeak"
        >
          <Volume2 v-if="autoSpeak" :size="17" />
          <VolumeX v-else :size="17" />
          <span class="hidden sm:inline">{{ autoSpeak ? '自动朗读' : '静音回复' }}</span>
        </button>
        <!-- 导出/复制下拉菜单 -->
        <div class="relative">
          <button
            @click="showExportMenu = !showExportMenu"
            class="p-2 rounded-lg transition-colors duration-200 text-slate-400 hover:text-slate-600 dark:hover:text-gray-200 hover:bg-slate-100 dark:hover:bg-gray-800"
            :title="'导出或复制对话'"
            aria-label="导出对话"
          >
            <Download :size="18" />
          </button>
          <Transition name="export-menu">
            <div
              v-if="showExportMenu"
              class="absolute right-0 top-full mt-1 w-48 bg-white dark:bg-gray-800 rounded-xl shadow-xl border border-slate-200 dark:border-gray-700 overflow-hidden z-20 py-1"
            >
              <button
                @click="copyConversationAsText"
                class="w-full flex items-center gap-2.5 px-3.5 py-2.5 text-sm text-slate-700 dark:text-gray-300 hover:bg-slate-50 dark:hover:bg-gray-700 transition-colors"
              >
                <ClipboardCopy :size="14" class="text-slate-400 shrink-0" />
                <span>复制为纯文本</span>
              </button>
              <button
                @click="exportConversation"
                class="w-full flex items-center gap-2.5 px-3.5 py-2.5 text-sm text-slate-700 dark:text-gray-300 hover:bg-slate-50 dark:hover:bg-gray-700 transition-colors"
              >
                <FileText :size="14" class="text-slate-400 shrink-0" />
                <span>导出 Markdown</span>
              </button>
              <button
                @click="exportConversationAsHtml"
                class="w-full flex items-center gap-2.5 px-3.5 py-2.5 text-sm text-slate-700 dark:text-gray-300 hover:bg-slate-50 dark:hover:bg-gray-700 transition-colors"
              >
                <FileCode2 :size="14" class="text-slate-400 shrink-0" />
                <span>导出 HTML</span>
              </button>
              <div class="my-1 border-t border-slate-100 dark:border-gray-700"></div>
              <button
                @click="shareConversation"
                class="w-full flex items-center gap-2.5 px-3.5 py-2.5 text-sm text-wut-600 dark:text-wut-400 hover:bg-wut-50 dark:hover:bg-wut-900/20 transition-colors"
              >
                <Share2 :size="14" class="shrink-0" />
                <span>生成分享链接</span>
              </button>
            </div>
          </Transition>
        </div>
        <button
          @click="showClearConfirm = true"
          :disabled="!canClear"
          :class="[
            'p-2 rounded-lg transition-colors duration-200',
            canClear
              ? 'text-slate-400 hover:text-slate-600 dark:hover:text-gray-200 hover:bg-slate-100 dark:hover:bg-gray-800'
              : 'text-slate-300 dark:text-gray-700 cursor-not-allowed'
          ]"
          :title="'清空当前会话'"
        >
          <Eraser :size="18" />
        </button>
      </div>
    </div>

    <!-- 空状态：仅欢迎消息时展示吉祥物 + 示例问题 -->
    <div
      v-if="effectiveMessageCount === 0 && !messageStore.isLoading"
      class="flex-1 min-h-0 overflow-y-auto flex items-center justify-center p-6"
    >
      <div class="w-full max-w-2xl flex flex-col items-center text-center">
        <!-- 吉祥物徽章：武理蓝 + 金色印章 -->
        <div class="relative mb-6">
          <div class="w-20 h-20 rounded-full bg-wut-700 flex items-center justify-center shadow-lg shadow-wut-700/30">
            <Bot :size="36" class="text-white" />
          </div>
          <div class="absolute -bottom-1 -right-1 w-8 h-8 rounded-full bg-wut-gold flex items-center justify-center text-wut-900 text-xs font-black shadow">武</div>
        </div>
        <p class="text-[11px] font-bold tracking-[0.3em] text-wut-600 dark:text-wut-400 uppercase mb-2">WUT CAMPUS AI</p>
        <h2 class="text-2xl font-black text-slate-800 dark:text-white mb-3">你好，我是武理小精灵</h2>
        <p class="text-sm text-slate-500 dark:text-gray-400 max-w-md leading-relaxed mb-8">
          基于武汉理工大学校园知识库的 AI 助手，覆盖选课、考试、图书馆、保研就业等校园指南，随时为你解答。
        </p>
        <!-- 示例问题卡：点击直接提问 -->
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 w-full max-w-xl">
          <button
            v-for="q in exampleQuestions"
            :key="q.text"
            type="button"
            @click="handleSend(q.text)"
            class="group flex items-center gap-3 text-left p-4 rounded-2xl border border-slate-200 dark:border-gray-700 bg-white dark:bg-gray-800 hover:border-wut-300 dark:hover:border-wut-600 hover:shadow-md transition-all duration-200"
          >
            <span class="w-9 h-9 rounded-xl bg-wut-50 dark:bg-wut-900/30 text-wut-600 dark:text-wut-400 flex items-center justify-center shrink-0 group-hover:bg-wut-100 dark:group-hover:bg-wut-900/50 transition-colors">
              <component :is="q.icon" :size="18" />
            </span>
            <span class="text-sm font-medium text-slate-700 dark:text-gray-300 group-hover:text-wut-700 dark:group-hover:text-wut-300 transition-colors">{{ q.text }}</span>
          </button>
        </div>
      </div>
    </div>

    <!-- 消息列表 -->
    <MessageList
      v-else
      ref="messageListRef"
      :messages="messages"
      :is-loading="messageStore.isLoading"
      :current-streaming-id="messageStore.currentStreamingId"
      :decision-draft="messageStore.decisionDraft"
      @copy="handleCopy"
      @focus-input="focusChatInput"
    />

    <!-- 输入框 -->
    <ChatBox
      ref="chatBoxRef"
      :is-loading="messageStore.isLoading"
      :placeholder="'输入您的问题...'"
      :is-connected="messageStore.isConnected"
      :is-reconnecting="messageStore.isReconnecting"
      :reconnect-attempt="messageStore.reconnectAttempt"
      :conversation-id="conversationStore.currentConversationId"
      @send="handleSend"
      @error="handleError"
      @command="handleCommand"
    />
  </div>

  <ConfirmDialog
    :show="showClearConfirm"
    title="清空会话"
    message="确定要清空当前会话吗？此操作不可撤销。"
    confirm-text="确认清空"
    cancel-text="取消"
    :danger="true"
    @confirm="confirmClear"
    @cancel="showClearConfirm = false"
  />
</template>

<style scoped>
/* 导出下拉菜单动画 */
.export-menu-enter-active {
  transition: opacity 0.15s ease-out, transform 0.15s ease-out;
}
.export-menu-leave-active {
  transition: opacity 0.1s ease-in;
}
.export-menu-enter-from,
.export-menu-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}
</style>
