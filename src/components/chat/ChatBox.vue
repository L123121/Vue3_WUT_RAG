<script setup>
import { ref, watch, nextTick, computed } from 'vue';
import { Send, Wifi, WifiOff, Command, Trash2, Download, Paperclip, X, FileText, Square } from 'lucide-vue-next';
import { useMessageStore } from '../../stores/message.store.js';
import { useToastStore } from '../../stores/toast.store.js';
import { uploadChatFile } from '../../api/chat.js';
import VoiceRecorder from './VoiceRecorder.vue';
import ConfirmDialog from '../common/ConfirmDialog.vue';

const props = defineProps({
  isLoading: Boolean,
  placeholder: { type: String, default: '' },
  isConnected: { type: Boolean, default: true },
  isReconnecting: { type: Boolean, default: false },
  reconnectAttempt: { type: Number, default: 0 },
  conversationId: { type: String, default: '' },
});

const emit = defineEmits(['send', 'error', 'command']);
const msgStore = useMessageStore();
const toast = useToastStore();
const input = ref('');
const textareaRef = ref(null);
const fileInputRef = ref(null);
const debouncedInput = ref('');

// 语音输入状态（由 VoiceRecorder 通过事件暴露）
const voiceRecorderRef = ref(null);
const voiceInterim = ref('');
const voiceError = ref('');

// 文件上传
const selectedFile = ref(null);
const filePreviewUrl = ref('');

const handleFileSelect = (event) => {
  const file = event.target.files[0];
  if (!file) return;
  selectedFile.value = file;
  if (file.type.startsWith('image/')) {
    const reader = new FileReader();
    reader.onload = (e) => { filePreviewUrl.value = e.target.result; };
    reader.readAsDataURL(file);
  } else {
    filePreviewUrl.value = '';
  }
};

const removeFile = () => {
  selectedFile.value = null;
  filePreviewUrl.value = '';
  if (fileInputRef.value) fileInputRef.value.value = '';
};
const showCommands = ref(false);
const selectedCommandIndex = ref(0);
let debounceTimer = null;

const showClearConfirm = ref(false);

const confirmClearMessages = () => {
  showClearConfirm.value = false;
  Promise.resolve(msgStore.clearMessages()).catch((e) => {
    console.error('[ChatBox] 清空会话异常:', e);
  });
};

// 快捷命令列表
const commands = computed(() => [
  { key: '/clear', label: '清空会话', icon: Trash2, action: () => { showClearConfirm.value = true; } },
  { key: '/export', label: '导出对话', icon: Download, action: () => emit('command', 'export') },
]);

// 过滤匹配的命令
const filteredCommands = computed(() => {
  if (!input.value.startsWith('/')) return [];
  const query = input.value.toLowerCase();
  return commands.value.filter(cmd => cmd.key.startsWith(query));
});

// 监听输入，显示命令菜单
watch(input, (val) => {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debouncedInput.value = val;
  }, 150);

  // 显示/隐藏命令菜单
  if (val.startsWith('/') && filteredCommands.value.length > 0) {
    showCommands.value = true;
    selectedCommandIndex.value = 0;
  } else {
    showCommands.value = false;
  }
});

const handleSend = async () => {
  if ((!input.value.trim() && !selectedFile.value) || props.isLoading) return;

  // 如果是命令，执行命令
  if (input.value.startsWith('/')) {
    const matchedCmd = commands.value.find(cmd => cmd.key === input.value.trim());
    if (matchedCmd) {
      matchedCmd.action();
      input.value = '';
      showCommands.value = false;
      return;
    }
  }

  // 先上传文件（如果有）
  let fileData = null;
  if (selectedFile.value) {
    try {
      const res = await uploadChatFile(selectedFile.value, props.conversationId);
      if (res.success) fileData = res.data;
      else { toast.error('文件上传失败'); return; }
    } catch (e) {
      toast.error(e.message || '文件上传失败');
      return;
    }
  }

  const message = input.value.trim();
  input.value = '';
  selectedFile.value = null;
  filePreviewUrl.value = '';
  if (fileInputRef.value) fileInputRef.value.value = '';
  showCommands.value = false;
  emit('send', message, fileData);
  await nextTick();
  textareaRef.value?.focus();
};

const handleKeydown = (event) => {
  // 命令菜单导航
  if (showCommands.value) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      selectedCommandIndex.value = Math.min(selectedCommandIndex.value + 1, filteredCommands.value.length - 1);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      selectedCommandIndex.value = Math.max(selectedCommandIndex.value - 1, 0);
      return;
    }
    if (event.key === 'Tab' || event.key === 'Enter') {
      event.preventDefault();
      selectCommand(filteredCommands.value[selectedCommandIndex.value]);
      return;
    }
    if (event.key === 'Escape') {
      showCommands.value = false;
      return;
    }
  }

  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    handleSend();
  }
};

const selectCommand = (cmd) => {
  input.value = cmd.key + ' ';
  showCommands.value = false;
  textareaRef.value?.focus();
};

const executeCommand = (cmd) => {
  cmd.action();
  input.value = '';
  showCommands.value = false;
};

// 语音输入状态（由 VoiceRecorder 通过事件暴露）
// voiceRecorderRef 在文件顶部第 30 行已声明
const handleTranscript = (text) => {
  input.value += text;
};
const handleVoiceInterim = (text) => {
  voiceInterim.value = text;
};
const handleVoiceError = (message) => {
  voiceError.value = message;
  emit('error', message);
};

defineExpose({
  focus: () => textareaRef.value?.focus(),
  clear: () => { input.value = ''; },
});
</script>

<template>
  <div class="p-2 bg-white dark:bg-gray-900 border-t border-slate-100 dark:border-gray-800 z-10">
    <!-- 连接状态提示（优化版：更明显） -->
    <Transition name="slide-down">
      <div v-if="!isConnected || isReconnecting" class="mb-2 p-2 rounded-lg flex items-center justify-center gap-2 text-xs font-medium animate-pulse-subtle"
        :class="isReconnecting ? 'bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800' : 'bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800'">
        <div class="relative">
          <WifiOff v-if="!isConnected" :size="14" class="text-red-500" />
          <Wifi v-else :size="14" class="text-yellow-500 animate-pulse" />
          <!-- 重连动画圆环 -->
          <svg v-if="isReconnecting" class="absolute inset-0 animate-spin-slow" viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2" stroke-dasharray="31.4" stroke-dashoffset="10" class="text-yellow-400" />
          </svg>
        </div>
        <span :class="isReconnecting ? 'text-yellow-700 dark:text-yellow-300' : 'text-red-600 dark:text-red-400'">
          <template v-if="isReconnecting">
            正在重连中... ({{ reconnectAttempt }})
          </template>
          <template v-else>
            连接已断开
          </template>
        </span>
      </div>
    </Transition>

    <!-- 文件预览 -->
    <div v-if="selectedFile" class="flex items-center gap-2 px-3 py-2 mb-1 bg-slate-50 dark:bg-gray-800 rounded-lg border border-slate-200 dark:border-gray-700">
      <img v-if="filePreviewUrl && selectedFile.type.startsWith('image/')"
        :src="filePreviewUrl" class="h-10 w-10 rounded object-cover border border-slate-200 dark:border-gray-600" />
      <FileText v-else :size="18" class="text-slate-400 shrink-0" />
      <span class="text-xs text-slate-600 dark:text-gray-300 truncate flex-1">{{ selectedFile.name }}</span>
      <button @click="removeFile" class="shrink-0 p-1 rounded text-slate-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors">
        <X :size="14" />
      </button>
    </div>

    <div class="relative flex items-center gap-1.5 bg-slate-100 dark:bg-gray-800 rounded-xl p-1.5 border border-transparent focus-within:border-wut-300 dark:focus-within:border-wut-700 focus-within:bg-white dark:focus-within:bg-gray-800 focus-within:ring-2 focus-within:ring-blue-100 dark:focus-within:ring-blue-900/20 transition-all duration-300">
      <!-- 快捷命令菜单 -->
      <Transition name="command-menu">
        <div v-if="showCommands" class="absolute bottom-full left-0 mb-2 w-64 max-w-[calc(100vw-2rem)] bg-white dark:bg-gray-800 rounded-xl shadow-xl border border-slate-200 dark:border-gray-700 overflow-hidden z-20">
          <div class="px-3 py-2 bg-slate-50 dark:bg-gray-900 border-b border-slate-100 dark:border-gray-700">
            <div class="flex items-center gap-2 text-xs text-slate-500 dark:text-gray-400">
              <Command :size="12" />
              <span>快捷命令</span>
            </div>
          </div>
          <div class="py-1">
            <button
              v-for="(cmd, index) in filteredCommands"
              :key="cmd.key"
              @click="executeCommand(cmd)"
              :class="[
                'w-full px-3 py-2 flex items-center gap-3 text-left transition-colors',
                index === selectedCommandIndex
                  ? 'bg-wut-50 dark:bg-wut-900/30 text-wut-600 dark:text-wut-400'
                  : 'hover:bg-slate-50 dark:hover:bg-gray-700 text-slate-700 dark:text-gray-200'
              ]"
            >
              <component :is="cmd.icon" :size="16" class="text-slate-400 dark:text-gray-500" />
              <div class="flex-1 min-w-0">
                <div class="text-sm font-medium">{{ cmd.key }}</div>
                <div class="text-xs text-slate-400 dark:text-gray-500">{{ cmd.label }}</div>
              </div>
            </button>
          </div>
          <div class="px-3 py-1.5 bg-slate-50 dark:bg-gray-900 border-t border-slate-100 dark:border-gray-700 flex items-center gap-3 text-[10px] text-slate-400 dark:text-gray-500">
            <span>↑↓ 导航</span>
            <span>Tab 选择</span>
            <span>Esc 关闭</span>
          </div>
        </div>
      </Transition>

      <!-- 语音识别 interim 预览 + 错误提示 -->
      <Transition name="slide-down">
        <div v-if="voiceInterim || voiceError" class="mb-1 px-2 py-1 rounded-lg text-xs flex items-center gap-2"
          :class="voiceError ? 'bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400' : 'bg-wut-50 dark:bg-wut-900/20 text-wut-600 dark:text-wut-300'">
          <span v-if="voiceError" class="font-medium">⚠</span>
          <span v-else class="inline-block h-1.5 w-1.5 rounded-full bg-wut-500 animate-pulse"></span>
          <span class="truncate">{{ voiceError || voiceInterim }}</span>
          <span v-if="!voiceError" class="text-slate-400 dark:text-slate-500 ml-auto shrink-0">识别中…</span>
        </div>
      </Transition>

      <textarea
        ref="textareaRef"
        v-model="input"
        @keydown="handleKeydown"
        :placeholder="placeholder || '输入您的问题...'"
        :disabled="isLoading"
        :aria-label="placeholder || '输入您的问题...'"
        rows="1"
        class="w-full bg-transparent text-slate-800 dark:text-white placeholder:text-slate-400 dark:placeholder:text-gray-500 border-none focus:ring-0 px-1 py-1.5 outline-none resize-none max-h-24 text-sm disabled:opacity-50"
        style="min-height: 32px;"
      ></textarea>

      <!-- 文件选取 -->
      <input ref="fileInputRef" type="file" accept="image/*,.pdf,.docx,.doc,.pptx,.txt,.md" class="hidden" @change="handleFileSelect" />
      <button
        @click="fileInputRef?.click()"
        :disabled="isLoading"
        class="shrink-0 h-8 w-8 rounded-lg inline-flex items-center justify-center text-slate-400 hover:text-wut-600 hover:bg-wut-50 dark:hover:bg-wut-900/20 disabled:opacity-50 transition-colors"
        title="上传文件"
      >
        <Paperclip :size="16" />
      </button>

      <VoiceRecorder
        ref="voiceRecorderRef"
        :disabled="isLoading"
        @transcript="handleTranscript"
        @interim="handleVoiceInterim"
        @error="handleVoiceError"
      />

      <button
        v-if="isLoading"
        @click="msgStore.abortCurrentRequest()"
        title="停止生成"
        class="p-2 rounded-lg transition-all duration-300 shrink-0 bg-red-100 text-red-500 hover:bg-red-200 dark:bg-red-900/40 dark:text-red-400 dark:hover:bg-red-900/60"
      >
        <Square :size="16" class="fill-current" />
      </button>
      <button
        v-else
        @click="handleSend"
        :disabled="(!input.trim() && !selectedFile) || !isConnected"
        :class="[
          'p-2 rounded-lg transition-all duration-300 shrink-0',
          !input.trim() || !isConnected ? 'bg-slate-200 text-slate-400 dark:bg-gray-700 dark:text-gray-500 cursor-not-allowed' : 'bg-wut-600 text-white hover:bg-wut-700 shadow-md shadow-wut-500/20 active:scale-95'
        ]"
      >
        <Send :size="16" />
      </button>
    </div>
  </div>

  <ConfirmDialog
    :show="showClearConfirm"
    title="清空会话"
    message="确定要清空当前会话吗？此操作不可撤销。"
    confirm-text="确认清空"
    cancel-text="取消"
    :danger="true"
    @confirm="confirmClearMessages"
    @cancel="showClearConfirm = false"
  />
</template>

<style scoped>
/* 滑入动画 */
.slide-down-enter-active,
.slide-down-leave-active {
  transition: all 0.3s ease;
}

.slide-down-enter-from,
.slide-down-leave-to {
  opacity: 0;
  transform: translateY(-10px);
}

/* 缓慢旋转动画 */
.animate-spin-slow {
  animation: spin 2s linear infinite;
}

@keyframes spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}

/* 微弱脉冲动画 */
.animate-pulse-subtle {
  animation: pulse-subtle 2s ease-in-out infinite;
}

@keyframes pulse-subtle {
  0%, 100% {
    opacity: 1;
  }
  50% {
    opacity: 0.85;
  }
}

/* 命令菜单动画 */
.command-menu-enter-active,
.command-menu-leave-active {
  transition: all 0.2s ease;
}

.command-menu-enter-from,
.command-menu-leave-to {
  opacity: 0;
  transform: translateY(8px);
}
</style>
