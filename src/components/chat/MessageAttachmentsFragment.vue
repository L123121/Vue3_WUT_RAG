<script setup>
import { FileText } from 'lucide-vue-next';

defineProps({
  files: { type: Array, default: () => [] },
  isUser: Boolean,
});

const emit = defineEmits(['open-image']);

const fileKey = (file, index) => file?.url || `${file?.name || 'file'}:${index}`;
</script>

<template>
  <div v-if="files.length" class="space-y-1.5 mb-2">
    <div
      v-for="(file, index) in files"
      :key="fileKey(file, index)"
      class="flex items-center gap-2 p-2 rounded-lg"
      :class="isUser ? 'bg-wut-500/20' : 'bg-slate-100 dark:bg-gray-700/50'"
    >
      <img
        v-if="file.isImage"
        :src="file.url"
        :alt="file.name || '图片附件'"
        class="max-w-[200px] max-h-[200px] rounded-lg object-contain cursor-pointer hover:opacity-90 transition-opacity"
        loading="lazy"
        @click="emit('open-image', file.url)"
      />
      <a
        v-else
        :href="file.url"
        target="_blank"
        rel="noopener noreferrer"
        class="flex items-center gap-2 text-xs hover:underline"
        :class="isUser ? 'text-white/80 hover:text-white' : 'text-wut-600 dark:text-wut-400'"
      >
        <span class="text-slate-400 shrink-0"><FileText :size="14" /></span>
        <span class="truncate max-w-[150px]">{{ file.name }}</span>
      </a>
    </div>
  </div>
</template>
