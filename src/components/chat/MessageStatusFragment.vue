<script setup>
import { computed } from 'vue';

const props = defineProps({
  variant: { type: String, required: true },
  decision: { type: Object, default: null },
  intent: { type: Object, default: null },
  grounding: { type: Object, default: null },
  usage: { type: Object, default: null },
  followups: { type: Array, default: () => [] },
  isModel: Boolean,
  isError: Boolean,
  isStreaming: Boolean,
  isInputDisabled: Boolean,
});

const emit = defineEmits(['send-followup']);

const decisionLabel = computed(() => {
  const decision = props.decision;
  if (!decision) return '';
  if (decision.fallback || decision.status === 'fallback') {
    return `路由决策降级：${decision.fallbackReason || decision.error || '未知原因'}`;
  }
  if (decision.applied || decision.status === 'applied') {
    const confidence = Number(decision.confidence);
    const pct = Number.isFinite(confidence) ? ` · 置信 ${Math.round(confidence * 100)}%` : '';
    return `AI 路由决策${pct}`;
  }
  return '';
});

const decisionBadgeClass = computed(() => (
  (props.decision?.fallback || props.decision?.status === 'fallback')
    ? 'bg-amber-50/80 dark:bg-amber-900/20 border-amber-100 dark:border-amber-800/40 text-amber-600 dark:text-amber-300'
    : 'bg-wut-50/80 dark:bg-wut-900/20 border-wut-100 dark:border-wut-800/40 text-wut-600 dark:text-wut-300'
));

const intentLabel = computed(() => {
  const map = {
    rag: '自动路由：知识库检索',
    chat: '自动路由：普通对话',
    agent: '自动路由：多步任务',
  };
  return map[props.intent?.route] || '';
});

const groundingLabel = computed(() => {
  if (!props.grounding) return '';
  const pct = Math.round(Number(props.grounding.coverage || 0) * 100);
  const levelMap = { high: '溯源良好', medium: '部分溯源', low: '低溯源' };
  return `已溯源 ${pct}% · ${levelMap[props.grounding.level] || props.grounding.level || '未知'}`;
});

const groundingBadgeClass = computed(() => {
  if (props.grounding?.level === 'high') {
    return 'bg-emerald-50/80 dark:bg-emerald-900/20 border-emerald-100 dark:border-emerald-800/40 text-emerald-600 dark:text-emerald-300';
  }
  if (props.grounding?.level === 'medium') {
    return 'bg-amber-50/80 dark:bg-amber-900/20 border-amber-100 dark:border-amber-800/40 text-amber-600 dark:text-amber-300';
  }
  return 'bg-red-50/80 dark:bg-red-900/20 border-red-100 dark:border-red-800/40 text-red-600 dark:text-red-300';
});

const usageLabel = computed(() => {
  const usage = props.usage;
  if (!usage) return '';
  const prompt = usage.prompt_tokens ?? usage.input_tokens ?? usage.promptTokens;
  const completion = usage.completion_tokens ?? usage.output_tokens ?? usage.completionTokens;
  if (!Number.isFinite(Number(prompt)) && !Number.isFinite(Number(completion))) return '';
  const total = usage.total_tokens ?? (Number(prompt || 0) + Number(completion || 0));
  const parts = [];
  if (Number.isFinite(Number(prompt))) parts.push(`输入 ${prompt}`);
  if (Number.isFinite(Number(completion))) parts.push(`输出 ${completion}`);
  if (Number.isFinite(Number(total))) parts.push(`共 ${total}`);
  return `${parts.join(' · ')} tokens`;
});
</script>

<template>
  <div
    v-if="variant === 'decision-badge' && isModel && !isError && decisionLabel"
    class="mt-2 inline-flex items-center gap-1 rounded-full border px-2 py-0.5"
    :class="decisionBadgeClass"
  >
    <span class="text-[10px] font-medium">{{ decisionLabel }}</span>
  </div>

  <div
    v-else-if="variant === 'intent-badge' && isModel && !isError && intentLabel"
    class="mt-2 inline-flex items-center gap-1 rounded-full bg-wut-50/80 dark:bg-wut-900/20 border border-wut-100 dark:border-wut-800/40 px-2 py-0.5"
  >
    <span class="w-1.5 h-1.5 rounded-full bg-wut-500"></span>
    <span class="text-[10px] font-medium text-wut-600 dark:text-wut-300">{{ intentLabel }}</span>
  </div>

  <div
    v-else-if="variant === 'grounding-badge' && isModel && !isError && !isStreaming && grounding"
    :title="`共 ${grounding.totalSentences} 句，其中 ${grounding.unsupportedCount} 句未在引用资料中找到依据`"
    class="mt-2 inline-flex items-center gap-1 rounded-full border px-2 py-0.5"
    :class="groundingBadgeClass"
  >
    <span class="text-[10px] font-medium">{{ groundingLabel }}</span>
  </div>

  <div
    v-else-if="variant === 'usage' && isModel && !isError && !isStreaming && usageLabel"
    class="mt-1 text-[10px] text-slate-400 dark:text-gray-500"
    title="本次回答的 token 消耗（模型服务返回口径）"
  >
    {{ usageLabel }}
  </div>

  <div
    v-else-if="variant === 'followups' && isModel && !isError && !isStreaming && followups.length"
    class="mt-2 flex flex-wrap gap-1.5"
  >
    <button
      v-for="item in followups"
      :key="item.text"
      type="button"
      :disabled="isInputDisabled"
      class="inline-flex items-center gap-1 rounded-full border border-wut-100 bg-wut-50/60 px-2.5 py-1 text-[11px] font-medium text-wut-600 transition hover:border-wut-300 hover:bg-wut-100 disabled:opacity-50 dark:border-wut-800/50 dark:bg-wut-900/20 dark:text-wut-300 dark:hover:border-wut-700 dark:hover:bg-wut-900/40"
      :title="item.from === 'heading' ? '来自引用文档的章节' : '来自引用文档'"
      @click="emit('send-followup', item.text)"
    >
      <span class="text-wut-400 dark:text-wut-500">↳</span>
      {{ item.text }}
    </button>
  </div>
</template>
