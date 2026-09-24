<script setup>
import { ref, watch, nextTick, onMounted, computed } from 'vue';
// 改用普通滚动容器，避免 DynamicScroller 虚拟滚动导致的流式跳动
import { RefreshCw } from 'lucide-vue-next';
import { useMessageStore } from '../../stores/message.store.js';
import { getMessageFragmentSignature } from '../../utils/messageFragments.js';
import MessageBubble from './MessageBubble.vue';

const props = defineProps({
  messages: { type: Array, default: () => [] },
  isLoading: Boolean,
  currentStreamingId: { type: String, default: '' },
  // agent 决策草稿：仅流式中的气泡展示，tool_call 后收起、done 后转正
  decisionDraft: { type: String, default: '' },
});

const emit = defineEmits(['copy', 'focus-input']);
const msgStore = useMessageStore();
const scrollerRef = ref(null);

const AUTO_SCROLL_THRESHOLD = 150;
const shouldAutoScroll = ref(true);

const getScrollContainer = () => scrollerRef.value || null;

const isNearBottom = () => {
  const el = getScrollContainer();
  if (!el) return true;
  const { scrollTop, scrollHeight, clientHeight } = el;
  return scrollHeight - scrollTop - clientHeight <= AUTO_SCROLL_THRESHOLD;
};

const scrollToBottom = async (force = false) => {
  if (!force && !shouldAutoScroll.value) return;
  await nextTick();
  const el = getScrollContainer();
  if (el) {
    el.scrollTop = el.scrollHeight;
  }
};

const handleScroll = () => {
  if (isNearBottom()) {
    shouldAutoScroll.value = true;
  } else {
    shouldAutoScroll.value = false;
  }
};

const handleCopy = (text) => emit('copy', text);

// 预计算每条消息对应的「上一条用户消息」：模板逐行回溯是 O(N²)，
// 流式期间 messages 数组每帧都被替换，历史长时 vnode diff 开销被放大 N 倍
const previousUserMessageById = computed(() => {
  const map = new Map();
  let lastUser = null;
  for (const item of props.messages) {
    map.set(item.id, lastUser);
    if (item.role === 'user') lastUser = item;
  }
  return map;
});

// Reconnection state
const reconnectProgress = computed(() => {
  if (!msgStore.isReconnecting) return 0;
  return Math.min((msgStore.reconnectAttempt / 3) * 100, 100);
});

// 流式进行中、但 AI 消息尚未收到第一个 chunk（内容为空）时显示 typing 占位
const showTypingIndicator = computed(() => {
  if (!props.isLoading || !props.currentStreamingId) return false;
  const msg = props.messages.find((item) => item.id === props.currentStreamingId);
  if (msg) return false;
  return true;
});

// 新消息时自动滚到底
watch(() => props.messages.length, () => {
  scrollToBottom();
});

// 流式内容变化时自动滚底 + 通知 DynamicScroller 重新计算高度
watch(() => {
  if (props.currentStreamingId) {
    const msg = props.messages.find((item) => item.id === props.currentStreamingId);
    return [
      msg?.text?.length || 0,
      msg?.sources?.length || 0,
      getMessageFragmentSignature(msg),
    ];
  }
  return [0, 0, ''];
}, () => {
  scrollToBottom();
});

onMounted(() => {
  scrollToBottom(true);
});

defineExpose({ scrollToBottom, shouldAutoScroll });
</script>

<template>
  <div class="flex-1 min-h-0 flex flex-col overflow-hidden">
    <!-- Messages with simple scroll (no virtual scrolling) -->
    <div
      v-if="messages.length > 0"
      ref="scrollerRef"
      class="flex-1 min-h-0 overflow-y-auto p-4 space-y-4"
      @scroll="handleScroll"
    >
      <div v-for="(item, index) in messages" :key="item.id" :id="`msg-${item.id}`" :data-index="index">
        <MessageBubble
          :message="item"
          :question-message="previousUserMessageById.get(item.id)"
          :decision-draft="item.id === currentStreamingId ? decisionDraft : ''"
          @copy="handleCopy"
          @focus-input="emit('focus-input')"
        />
      </div>
    </div>

    <!-- Skeleton: initial loading state -->
    <div v-else-if="isLoading" class="flex-1 flex flex-col p-4 space-y-6">
      <!-- AI message skeleton -->
      <div class="flex items-start gap-2">
        <div class="w-8 h-8 rounded-full skeleton-shimmer bg-slate-200 dark:bg-gray-700 shrink-0"></div>
        <div class="flex-1 space-y-2.5 bg-white dark:bg-gray-800 rounded-2xl rounded-tl-sm border border-slate-100 dark:border-gray-700 p-4">
          <div class="h-3 skeleton-shimmer bg-slate-200 dark:bg-gray-700 rounded w-3/4"></div>
          <div class="h-3 skeleton-shimmer bg-slate-200 dark:bg-gray-700 rounded w-1/2" style="animation-delay: 0.1s"></div>
          <div class="h-3 skeleton-shimmer bg-slate-200 dark:bg-gray-700 rounded w-5/6" style="animation-delay: 0.2s"></div>
        </div>
      </div>
      <!-- User message skeleton (right aligned) -->
      <div class="flex items-start gap-2 justify-end">
        <div class="space-y-2.5 bg-wut-100 dark:bg-wut-900/20 rounded-2xl rounded-tr-sm p-4 w-1/3">
          <div class="h-3 skeleton-shimmer bg-wut-200 dark:bg-wut-800/40 rounded w-full"></div>
          <div class="h-3 skeleton-shimmer bg-wut-200 dark:bg-wut-800/40 rounded w-2/3" style="animation-delay: 0.15s"></div>
        </div>
        <div class="w-8 h-8 rounded-full skeleton-shimmer bg-wut-100 dark:bg-wut-900/30 shrink-0"></div>
      </div>
      <!-- Another AI skeleton -->
      <div class="flex items-start gap-2">
        <div class="w-8 h-8 rounded-full skeleton-shimmer bg-slate-200 dark:bg-gray-700 shrink-0" style="animation-delay: 0.2s"></div>
        <div class="flex-1 space-y-2.5 bg-white dark:bg-gray-800 rounded-2xl rounded-tl-sm border border-slate-100 dark:border-gray-700 p-4">
          <div class="h-3 skeleton-shimmer bg-slate-200 dark:bg-gray-700 rounded w-2/3" style="animation-delay: 0.3s"></div>
          <div class="h-3 skeleton-shimmer bg-slate-200 dark:bg-gray-700 rounded w-4/5" style="animation-delay: 0.4s"></div>
        </div>
      </div>
    </div>

    <!-- Typing indicator：流式进行中且首字节尚未到达时显示 -->
    <div v-if="showTypingIndicator" class="flex justify-start px-4 pb-4">
      <div class="flex items-center ml-10 bg-white dark:bg-gray-800 px-4 py-3 rounded-2xl rounded-tl-none border border-slate-100 dark:border-gray-700 shadow-sm">
        <div class="flex items-center gap-1 mr-2">
          <span class="w-1.5 h-1.5 rounded-full bg-wut-500 animate-bounce" style="animation-delay: 0s"></span>
          <span class="w-1.5 h-1.5 rounded-full bg-wut-500 animate-bounce" style="animation-delay: 0.15s"></span>
          <span class="w-1.5 h-1.5 rounded-full bg-wut-500 animate-bounce" style="animation-delay: 0.3s"></span>
        </div>
        <span class="text-xs text-slate-500 dark:text-gray-400">思考中...</span>
      </div>
    </div>

    <!-- Reconnection overlay -->
    <Transition name="reconnect">
      <div v-if="msgStore.isReconnecting" class="absolute bottom-24 left-1/2 -translate-x-1/2 z-20">
        <div class="flex items-center gap-2.5 bg-amber-50 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-800 rounded-full px-4 py-2 shadow-lg backdrop-blur-sm">
          <RefreshCw :size="14" class="text-amber-600 dark:text-amber-400 animate-spin" />
          <span class="text-xs font-medium text-amber-700 dark:text-amber-300">
            正在重连 ({{ msgStore.reconnectAttempt }}/3)
          </span>
          <div class="w-16 h-1.5 bg-amber-200 dark:bg-amber-800 rounded-full overflow-hidden">
            <div class="h-full bg-amber-500 rounded-full transition-all duration-500" :style="{ width: reconnectProgress + '%' }"></div>
          </div>
        </div>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
/* Skeleton shimmer effect */
.skeleton-shimmer {
  position: relative;
  overflow: hidden;
}

.skeleton-shimmer::after {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(
    90deg,
    transparent 0%,
    rgba(255, 255, 255, 0.4) 50%,
    transparent 100%
  );
  animation: shimmer 1.8s ease-in-out infinite;
}

:root.dark .skeleton-shimmer::after {
  background: linear-gradient(
    90deg,
    transparent 0%,
    rgba(255, 255, 255, 0.08) 50%,
    transparent 100%
  );
}

@keyframes shimmer {
  0% {
    transform: translateX(-100%);
  }
  100% {
    transform: translateX(100%);
  }
}

/* Reconnection toast animation */
.reconnect-enter-active,
.reconnect-leave-active {
  transition: all 0.3s ease;
}

.reconnect-enter-from,
.reconnect-leave-to {
  opacity: 0;
  transform: translate(-50%, 20px);
}
</style>
