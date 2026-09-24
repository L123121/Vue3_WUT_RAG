<script setup>
import { computed } from 'vue';

const props = defineProps({
  originalType: { type: String, default: 'unknown' },
  data: { type: null, default: null },
});

const preview = computed(() => {
  try {
    const text = JSON.stringify(props.data, null, 2);
    return text && text.length > 2000 ? `${text.slice(0, 2000)}\n…` : (text || '无附加数据');
  } catch {
    return String(props.data ?? '无附加数据').slice(0, 2000);
  }
});
</script>

<template>
  <details class="mt-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600 dark:border-gray-700 dark:bg-gray-900/40 dark:text-gray-300">
    <summary class="cursor-pointer select-none font-medium">未适配的消息节点：{{ originalType }}</summary>
    <pre class="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words text-[11px] leading-relaxed">{{ preview }}</pre>
  </details>
</template>
