<script setup>
import { RotateCcw, BookOpen } from 'lucide-vue-next';

const emit = defineEmits(['focus-input', 'navigate-knowledge']);
</script>

<template>
  <div class="mt-3 rounded-xl border border-amber-200 dark:border-amber-800/60 bg-amber-50 dark:bg-amber-900/20 p-3">
    <p class="text-xs font-medium text-amber-800 dark:text-amber-300">没有检索到足够可靠的资料</p>
    <p class="mt-1 text-xs text-amber-700/80 dark:text-amber-400/80 leading-relaxed">
      可以换个问法（更具体、包含更多关键词），或去知识库查看相关文档后再提问。
    </p>
    <div class="mt-2 flex items-center gap-2">
      <button
        type="button"
        class="inline-flex items-center gap-1.5 h-7 px-3 rounded-lg text-xs font-medium bg-amber-600 text-white hover:bg-amber-700 transition-colors"
        @click="emit('focus-input')"
      >
        <RotateCcw :size="12" />
        换个问法
      </button>
      <button
        type="button"
        class="inline-flex items-center gap-1.5 h-7 px-3 rounded-lg text-xs font-medium border border-amber-300 dark:border-amber-700 text-amber-700 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-900/30 transition-colors"
        @click="emit('navigate-knowledge')"
      >
        <BookOpen :size="12" />
        去知识库
      </button>
    </div>
  </div>
</template>
