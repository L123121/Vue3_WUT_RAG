<script setup>
/**
 * 决策思考草稿：agent 决策阶段实时滚动展示的瞬态文本。
 * 由 MessageFragmentRenderer 合成（不进 message.fragments/缓存），
 * tool_call 后收起、done 后转正为正文。
 */
defineProps({
  text: { type: String, default: '' },
});
</script>

<template>
  <div
    v-if="text"
    class="mb-2 rounded-lg border border-slate-200 dark:border-gray-700 bg-slate-50/80 dark:bg-gray-800/60 px-3 py-2"
    data-testid="decision-draft"
  >
    <div class="flex items-center gap-1.5 mb-1">
      <span class="w-1.5 h-1.5 rounded-full bg-wut-500 animate-pulse"></span>
      <span class="text-[10px] font-medium text-slate-500 dark:text-gray-400">思考中…</span>
    </div>
    <div class="max-h-24 overflow-hidden text-xs text-slate-500 dark:text-gray-400 whitespace-pre-wrap leading-relaxed break-words">{{ text }}</div>
  </div>
</template>
