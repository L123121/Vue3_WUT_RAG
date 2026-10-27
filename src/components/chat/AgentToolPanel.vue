<script setup>
import { ref, computed } from 'vue';

/**
 * Agent 工具调度可视化面板：tool_call / tool_result 列表 + L4 trace 元信息
 * （轮次 / 收尾原因 / 总耗时）。仅当消息携带 toolCalls 时由 MessageBubble 渲染。
 */

const props = defineProps({
  toolCalls: { type: Array, default: () => [] },
  toolResults: { type: Array, default: () => [] },
  agentTrace: { type: Object, default: null },
});

const toolPanelOpen = ref(false);

const toolResultText = (name) => {
  const r = props.toolResults.find((tr) => tr.name === name);
  if (!r) return '执行中...';
  const text = String(r.content || '').replace(/\s+/g, ' ').trim();
  return text.length > 120 ? `${text.slice(0, 120)}…` : text;
};

const finishReasonLabel = computed(() => {
  if (!props.agentTrace) return '';
  const map = {
    direct_answer: '直接回答',
    tool_assisted: '工具辅助回答',
    round_limit: '达到轮次上限',
    no_progress: '无进展强制收尾',
    error: '出错收尾',
  };
  return map[props.agentTrace.finishReason] || props.agentTrace.finishReason;
});

const formatAgentTotalMs = (ms) => {
  const s = Number(ms) / 1000;
  return s >= 10 ? `${s.toFixed(0)}s` : `${s.toFixed(1)}s`;
};
</script>

<template>
  <div class="mt-2 rounded-xl border border-wut-100 dark:border-wut-900/50 bg-wut-50/50 dark:bg-wut-950/20 overflow-hidden">
    <button
      type="button"
      class="w-full flex items-center gap-2 px-3 py-2 text-left text-xs font-medium text-wut-700 dark:text-wut-300 hover:bg-wut-100/50 dark:hover:bg-wut-900/20 transition-colors"
      @click="toolPanelOpen = !toolPanelOpen"
    >
      <span class="w-1.5 h-1.5 rounded-full bg-wut-500 animate-pulse"></span>
      <span>工具调用 {{ toolCalls.length }} 次</span>
      <span class="ml-auto text-wut-400 dark:text-wut-500 transition-transform" :class="toolPanelOpen ? 'rotate-180' : ''">▾</span>
    </button>
    <div v-if="toolPanelOpen" class="px-3 pb-3 space-y-2">
      <!-- Agent L4 trace 元信息：轮次 / 收尾原因 / 总耗时 -->
      <div v-if="agentTrace" class="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-slate-500 dark:text-gray-400">
        <span class="inline-flex items-center gap-1">
          <span class="font-medium text-wut-500 dark:text-wut-400">轮次</span>
          <span class="font-mono">{{ agentTrace.rounds ?? 0 }}</span>
        </span>
        <span class="inline-flex items-center gap-1">
          <span class="font-medium text-wut-500 dark:text-wut-400">收尾</span>
          <span>{{ finishReasonLabel }}</span>
        </span>
        <span class="inline-flex items-center gap-1">
          <span class="font-medium text-wut-500 dark:text-wut-400">耗时</span>
          <span class="font-mono">{{ formatAgentTotalMs(agentTrace.totalMs) }}</span>
        </span>
      </div>
      <div v-for="(tc, i) in toolCalls" :key="i" class="rounded-lg bg-white/70 dark:bg-gray-900/40 border border-wut-100/70 dark:border-wut-900/40 px-2.5 py-2">
        <div class="flex items-center gap-2 text-[11px]">
          <span class="font-mono font-semibold text-wut-700 dark:text-wut-300">{{ tc.name }}</span>
          <span class="ml-auto text-slate-400 dark:text-gray-500">
            {{ tc.arguments && Object.keys(tc.arguments).length ? JSON.stringify(tc.arguments).slice(0, 60) : '无参数' }}
          </span>
        </div>
        <div class="mt-1 text-[11px] text-slate-600 dark:text-gray-400 leading-relaxed break-all">{{ toolResultText(tc.name) }}</div>
      </div>
    </div>
  </div>
</template>
