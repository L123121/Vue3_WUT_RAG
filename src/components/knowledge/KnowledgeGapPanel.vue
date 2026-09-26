<script setup>
import { ref, watch } from 'vue';
import { Shield } from 'lucide-vue-next';
import { useToastStore } from '../../stores/toast.store.js';
import { getOperationsDashboard, createKnowledgeTask } from '../../api/operations.js';

// 知识库缺口看板：复用线上质量审计，回答"该补什么资料"（管理员可见）
const props = defineProps({
  visible: { type: Boolean, default: false },
});

const toast = useToastStore();
const gapSummary = ref(null);
const gapLoading = ref(false);
const gapTaskBusy = ref('');

const loadGapSummary = async () => {
  gapLoading.value = true;
  try {
    const res = await getOperationsDashboard();
    gapSummary.value = res?.data?.riskAudit || null;
  } catch {
    gapSummary.value = null;
  } finally {
    gapLoading.value = false;
  }
};

watch(() => props.visible, (visible) => {
  if (visible && !gapSummary.value) loadGapSummary();
}, { immediate: true });

const createGapTask = async (audit) => {
  if (gapTaskBusy.value) return;
  gapTaskBusy.value = audit.id;
  try {
    const res = await createKnowledgeTask({
      auditId: audit.id,
      title: `补充「${String(audit.question || '').slice(0, 24)}」相关资料`,
      description: `用户询问「${audit.question}」时知识库存在缺口（主题：${audit.topic?.label || '未知'}），建议补充权威来源文档。`,
    });
    if (!res?.success) throw new Error(res?.error || '创建失败');
    toast.success('已创建资料补充任务，可在运营看板跟进');
    audit._taskCreated = true;
  } catch (error) {
    toast.error(error.message || '创建补充任务失败');
  } finally {
    gapTaskBusy.value = '';
  }
};
</script>

<template>
  <div
    v-if="visible"
    class="mb-5 rounded-2xl border border-slate-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-4"
  >
    <div class="flex items-center justify-between mb-3">
      <div class="flex items-center gap-2">
        <Shield :size="15" class="text-wut-600 dark:text-wut-400" />
        <h2 class="text-sm font-bold text-slate-800 dark:text-white">知识库缺口看板</h2>
        <span class="text-[10px] text-slate-400 dark:text-gray-500">基于线上回答质量审计</span>
      </div>
      <button
        @click="loadGapSummary"
        :disabled="gapLoading"
        class="h-7 px-2.5 rounded-lg text-xs text-slate-500 dark:text-gray-400 hover:bg-slate-50 dark:hover:bg-gray-800 transition-colors disabled:opacity-50"
      >
        {{ gapLoading ? '加载中...' : '刷新' }}
      </button>
    </div>

    <div v-if="!gapSummary" class="py-6 text-center text-xs text-slate-400 dark:text-gray-500">
      {{ gapLoading ? '正在加载审计数据...' : '暂无审计数据：用户提问后自动聚合' }}
    </div>
    <template v-else>
      <div class="grid grid-cols-3 gap-3 mb-3">
        <div class="rounded-xl bg-slate-50 dark:bg-gray-800/60 p-3 text-center">
          <div class="text-xl font-black text-slate-800 dark:text-white">{{ gapSummary.totalQuestions }}</div>
          <div class="text-[10px] text-slate-500 dark:text-gray-400">累计审计提问</div>
        </div>
        <div class="rounded-xl bg-amber-50 dark:bg-amber-900/20 p-3 text-center">
          <div class="text-xl font-black text-amber-600 dark:text-amber-300">{{ gapSummary.knowledgeGapCount }}</div>
          <div class="text-[10px] text-amber-700/70 dark:text-amber-300/60">知识缺口</div>
        </div>
        <div class="rounded-xl bg-rose-50 dark:bg-rose-900/20 p-3 text-center">
          <div class="text-xl font-black text-rose-600 dark:text-rose-300">{{ gapSummary.highRiskCount }}</div>
          <div class="text-[10px] text-rose-700/70 dark:text-rose-300/60">高风险回答</div>
        </div>
      </div>

      <div v-if="gapSummary.topTopics?.length" class="flex flex-wrap gap-1.5 mb-3">
        <span
          v-for="topic in gapSummary.topTopics.slice(0, 5)"
          :key="topic.key"
          class="rounded-full bg-slate-100 dark:bg-gray-800 px-2.5 py-1 text-[11px] font-medium text-slate-600 dark:text-gray-300"
        >
          {{ topic.label }} · {{ topic.count }} 次
          <span v-if="topic.gaps" class="text-amber-600 dark:text-amber-400">（缺 {{ topic.gaps }}）</span>
        </span>
      </div>

      <div v-if="gapSummary.highRisk?.length" class="space-y-2">
        <div
          v-for="audit in gapSummary.highRisk.slice(0, 4)"
          :key="audit.id"
          class="flex items-start justify-between gap-3 rounded-xl border border-slate-100 dark:border-gray-800 bg-slate-50/60 dark:bg-gray-800/40 px-3 py-2"
        >
          <div class="min-w-0">
            <p class="truncate text-xs font-medium text-slate-700 dark:text-gray-200">{{ audit.question }}</p>
            <p class="mt-0.5 text-[10px] text-slate-400 dark:text-gray-500">
              {{ audit.topic?.label || '综合咨询' }}
              <span v-if="audit.knowledgeGap" class="text-amber-600 dark:text-amber-400">· 资料缺口</span>
            </p>
          </div>
          <button
            v-if="audit.knowledgeGap && !audit._taskCreated"
            @click="createGapTask(audit)"
            :disabled="gapTaskBusy === audit.id"
            class="shrink-0 rounded-lg border border-wut-200 dark:border-wut-800 px-2.5 py-1.5 text-[11px] font-bold text-wut-600 dark:text-wut-300 hover:bg-wut-50 dark:hover:bg-wut-900/30 disabled:opacity-50 transition-colors"
          >
            {{ gapTaskBusy === audit.id ? '创建中...' : '创建补充任务' }}
          </button>
          <span v-else-if="audit._taskCreated" class="shrink-0 text-[11px] font-bold text-emerald-600 dark:text-emerald-400">已建任务</span>
        </div>
      </div>
    </template>
  </div>
</template>
