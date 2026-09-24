<script setup>
import { ref, computed, nextTick } from 'vue';
import { useRouter } from 'vue-router';
import { User, Bot, RotateCcw } from 'lucide-vue-next';
import { useMessageStore } from '../../stores/message.store.js';
import { useAuthStore } from '../../stores/auth.store.js';
import MessageActions from './MessageActions.vue';
import MessageFragmentRenderer from './MessageFragmentRenderer.vue';
import CitationPopup from './CitationPopup.vue';

/**
 * 单条消息气泡：容器/头像/正文渲染 + 徽标（路由、溯源、用量、追问）+ 编辑态。
 * 交互动作（反馈/语音/复制/收藏/分叉）拆至 MessageActions，
 * 工具面板拆至 AgentToolPanel，引用弹窗拆至 CitationPopup。
 */

const props = defineProps({
  message: {
    type: Object,
    required: true,
  },
  questionMessage: {
    type: Object,
    default: null,
  },
  // agent 决策草稿（仅流式中的气泡传入）：实时展示模型的决策思考文本
  decisionDraft: {
    type: String,
    default: '',
  },
});

const emit = defineEmits(['copy', 'focus-input']);
const router = useRouter();
const msgStore = useMessageStore();
const authStore = useAuthStore();

const userAvatar = computed(() => authStore.user?.avatar || '');

const isUser = computed(() => props.message.role === 'user');
const isModel = computed(() => props.message.role === 'model');
const isError = computed(() => props.message.isError === true);
const canRetry = computed(() => props.message.canRetry === true);

const isStreaming = computed(() => msgStore.currentStreamingId === props.message.id);


// 行内引用弹窗：状态在父级（依赖 message.sources），弹窗本体拆至 CitationPopup
const citationPopup = ref(null); // { source: {...}, index: number } | null
const showCitation = (index) => {
  const sources = props.message.sources || [];
  const source = sources[index - 1];
  if (source) {
    citationPopup.value = { source, index };
  }
};

const messageText = computed(() => props.message.content ?? props.message.text ?? '');

const copyCode = (code) => {
  navigator.clipboard.writeText(code)
    .then(() => emit('copy', code))
    .catch(() => emit('copy', code)); // 复制失败也通知外层（toast 兜底）
};

const retryMessage = (msgId) => {
  msgStore.retryMessage(msgId);
};

const openImage = (url) => {
  window.open(url, '_blank');
};

const sendFollowup = (text) => {
  if (!text || msgStore.isLoading) return;
  msgStore.sendMessage(text);
};

const navigateKnowledge = () => {
  router.push('/knowledge');
};

const onAvatarError = (e) => {
  e.target.style.display = 'none';
};

const bubbleClasses = computed(() => {
  if (isUser.value) {
    return 'bg-wut-600 text-white rounded-2xl rounded-tr-sm';
  }
  if (isError.value) {
    return 'bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 border border-red-100 dark:border-red-800/50 rounded-2xl rounded-tl-sm';
  }
  return 'bg-white dark:bg-gray-800 text-slate-700 dark:text-gray-200 border border-slate-100 dark:border-gray-700 rounded-2xl rounded-tl-sm';
});

const avatarClasses = computed(() => {
  if (isUser.value) {
    return 'bg-wut-100 dark:bg-wut-900/30';
  }
  return 'bg-wut-600 shadow-wut-500/30';
});

const timeClasses = computed(() => {
  return isUser.value ? 'text-wut-100' : 'text-slate-400 dark:text-gray-500';
});

// ===== 用户消息编辑重发 =====
const editing = ref(false);
const editText = ref('');
const editTextareaRef = ref(null);
const startEdit = () => {
  if (msgStore.isLoading) return;
  editText.value = messageText.value;
  editing.value = true;
  nextTick(() => editTextareaRef.value?.focus());
};
const cancelEdit = () => {
  editing.value = false;
};
const saveEdit = async () => {
  const text = editText.value.trim();
  if (!text || msgStore.isLoading) return;
  editing.value = false;
  await msgStore.editAndResendMessage(props.message.id, text);
};
</script>

<template>
  <div :class="['flex', isUser ? 'justify-end' : 'justify-start', 'group']">
    <div :class="['flex max-w-[85%] md:max-w-[75%]', isUser ? 'flex-row-reverse' : 'flex-row', 'items-start gap-2']">
      <!-- Avatar -->
      <div :class="['w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 shadow-sm overflow-hidden', avatarClasses]">
        <img v-if="isUser && userAvatar" :src="userAvatar" alt="用户头像" class="w-full h-full object-cover bg-white" @error="onAvatarError" />
        <User v-if="isUser && !userAvatar" :size="14" class="text-wut-600 dark:text-wut-400" />
        <Bot v-else :size="15" class="text-white" />
      </div>

      <!-- Message content -->
      <div :class="['px-5 py-3.5 shadow-sm text-sm leading-relaxed relative max-w-full overflow-hidden', bubbleClasses]">
        <!-- Retry button for user messages -->
        <button
          v-if="isUser && canRetry"
          class="retry-btn absolute -right-2 -top-2 flex items-center gap-1 bg-orange-500 hover:bg-orange-600 text-white px-2 py-1 rounded-full text-xs shadow-lg transition-all duration-200 cursor-pointer"
          @click="retryMessage(message.id)"
          :title="'重新发送'"
        >
          <RotateCcw :size="12" />
          <span>重发</span>
        </button>

        <MessageFragmentRenderer
          :message="message"
          :is-streaming="isStreaming"
          :is-input-disabled="msgStore.isLoading"
          :suppress-text="isUser && editing"
          :decision-draft="decisionDraft"
          @citation-click="showCitation"
          @copy-code="copyCode"
          @send-followup="sendFollowup"
          @open-image="openImage"
          @focus-input="emit('focus-input')"
          @navigate-knowledge="navigateKnowledge"
        />

        <!-- 用户消息编辑态：修改后重发（复用 retry 通道，替换原回复） -->
        <div v-if="isUser && editing" class="w-full min-w-[220px]">
          <textarea
            ref="editTextareaRef"
            v-model="editText"
            rows="3"
            class="w-full rounded-lg border border-wut-200 dark:border-wut-700 bg-white dark:bg-gray-800 text-slate-800 dark:text-gray-100 text-sm p-2 outline-none focus:ring-2 focus:ring-wut-300 dark:focus:ring-wut-800 resize-y"
            @keydown.enter.exact.prevent="saveEdit"
            @keydown.esc.prevent="cancelEdit"
          ></textarea>
          <div class="mt-1.5 flex items-center justify-end gap-2">
            <button
              type="button"
              class="px-2.5 py-1 rounded-lg text-xs text-slate-500 dark:text-gray-400 hover:bg-white/15 transition-colors"
              @click="cancelEdit"
            >取消</button>
            <button
              type="button"
              :disabled="!editText.trim() || msgStore.isLoading"
              class="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-bold bg-white text-wut-700 hover:bg-wut-50 disabled:opacity-50 transition-colors"
              @click="saveEdit"
            >
              保存并重发
            </button>
          </div>
        </div>
        <!-- Footer with time and actions（反馈/语音/复制/收藏/编辑/分叉） -->
        <MessageActions
          :message="message"
          :question-message="questionMessage"
          :message-text="messageText"
          :is-user="isUser"
          :is-model="isModel"
          :is-error="isError"
          :is-streaming="isStreaming"
          :time-classes="timeClasses"
          :editing="editing"
          @copy="(text) => emit('copy', text)"
          @start-edit="startEdit"
        />
      </div>
    </div>

    <!-- 行内引用弹窗 -->
    <CitationPopup :popup="citationPopup" @close="citationPopup = null" />
  </div>
</template>

<style scoped>
/* 行内引用深色模式 */
:deep(.citation:hover) {
  background: #c7d2fe !important;
  box-shadow: 0 1px 3px rgba(79, 70, 229, 0.3);
}
:root.dark :deep(.citation) {
  background: #1e1b4b !important;
  color: #a5b4fc !important;
  border-color: #312e81 !important;
}
:root.dark :deep(.citation:hover) {
  background: #312e81 !important;
  box-shadow: 0 1px 3px rgba(99, 102, 241, 0.3);
}
</style>
