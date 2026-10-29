<script setup>
import { computed, ref, watch } from 'vue';
import { ScanSearch, ChevronDown, ExternalLink, FileQuestion } from 'lucide-vue-next';

const props = defineProps({
  report: { type: Object, default: null },
  compact: Boolean,
  focusClaimId: { type: String, default: '' },
});
const expanded = ref(!props.compact);
const excluded = ref([]);
const search = ref('');
watch(() => props.report, () => { excluded.value = []; });
watch(() => props.focusClaimId, () => { if (props.focusClaimId) expanded.value = true; });
const asList = value => Array.isArray(value) ? value : [];
const sources = computed(() => asList(props.report?.sources));
const matchesFor = claim => asList(props.report?.evidence).filter(item => item.claimId === claim.id && !excluded.value.includes(item.docId));
const allClaims = computed(() => asList(props.report?.claims));
const matchedCount = computed(() => allClaims.value.filter(claim => matchesFor(claim).length).length);
const claims = computed(() => allClaims.value.filter(claim => !search.value || claim.text.includes(search.value)));
const label = claim => {
  const matches = matchesFor(claim);
  if (matches.some(item => item.needsReview)) return '存在差异 · 待核验';
  if (matches.some(item => item.match === 'exact')) return '原文出现';
  return matches.length ? '相关片段 · 待核验' : '未找到对应片段';
};
const toggleSource = id => {
  excluded.value = excluded.value.includes(id) ? excluded.value.filter(value => value !== id) : [...excluded.value, id];
};
const kindLabel = kind => ({ step: '步骤', material: '材料', location: '地点', duration: '耗时', notes: '说明' }[kind] || '结论');
const originLabel = computed(() => ({
  retrieval_snapshot: '本次检索上下文快照',
  plan_creation_snapshot: '创建计划时的已发布来源快照',
  plan_review_snapshot: '用户调整计划或确认变更后的来源快照',
  current_published_sources: '按当前已发布来源复核，不是生成时的上下文',
}[props.report?.origin] || '证据快照'));
</script>

<template>
  <section v-if="report" class="rounded-2xl border border-slate-200 bg-white dark:border-gray-700 dark:bg-gray-900 overflow-hidden" data-testid="evidence-panel">
    <button type="button" class="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-slate-50 dark:hover:bg-gray-800" :aria-expanded="expanded" @click="expanded = !expanded">
      <span class="rounded-lg bg-teal-50 p-2 text-teal-700 dark:bg-teal-900/30 dark:text-teal-300"><ScanSearch :size="18" /></span>
      <span class="flex-1"><span class="block text-sm font-bold text-slate-800 dark:text-white">证据工作台</span><span class="text-xs text-slate-500 dark:text-gray-400">{{ matchedCount }} / {{ allClaims.length }} 条有可查看片段 · 不代表准确率</span></span>
      <ChevronDown :size="16" class="text-slate-400 transition-transform" :class="{ 'rotate-180': expanded }" />
    </button>
    <div v-if="expanded" class="border-t border-slate-100 p-4 space-y-4 dark:border-gray-800">
      <div class="rounded-xl bg-slate-50 p-3 text-xs leading-relaxed text-slate-500 dark:bg-gray-800 dark:text-gray-400">
        <p class="font-semibold text-slate-700 dark:text-gray-200">{{ originLabel }}</p>
        <p class="mt-1">{{ report.notice }}</p>
        <p v-if="report.truncated" class="mt-1 text-amber-700 dark:text-amber-300">内容较长，当前仅展示有界片段，请结合完整原文核验。</p>
      </div>
      <fieldset v-if="sources.length" class="space-y-2">
        <legend class="text-xs font-semibold text-slate-700 dark:text-gray-200">参与核验的来源（取消勾选只重算可见依据，不改写回答）</legend>
        <label v-for="source in sources" :key="`${source.docId}:${source.revision}`" class="flex items-start gap-2 rounded-lg border border-slate-100 p-2 text-xs dark:border-gray-800">
          <input type="checkbox" class="mt-0.5 accent-teal-600" :checked="!excluded.includes(source.docId)" @change="toggleSource(source.docId)" />
          <span class="min-w-0 text-slate-700 dark:text-gray-300">
            <span class="font-medium">{{ source.title }}</span>
            <span v-if="source.simulated" class="ml-2 text-amber-600">演示语料</span>
            <span class="block mt-1 text-slate-500 dark:text-gray-400">版本 {{ source.revision?.slice(0, 8) || '未冻结' }} · 适用范围：{{ source.scope || '未标注' }}</span>
            <span class="block">有效期：{{ source.effectiveFrom || '未标注' }} — {{ source.effectiveUntil || '未标注' }}</span>
          </span>
        </label>
      </fieldset>
      <input v-if="allClaims.length > 5" v-model="search" aria-label="筛选待核验结论" placeholder="筛选结论或步骤…" class="w-full rounded-lg border border-slate-200 bg-transparent px-3 py-2 text-xs dark:border-gray-700 dark:text-gray-200" />
      <div class="space-y-2">
        <details v-for="claim in claims" :key="claim.id" :open="focusClaimId === claim.id" class="rounded-xl border border-slate-200 dark:border-gray-700" :class="{ 'ring-2 ring-teal-200 dark:ring-teal-800': focusClaimId === claim.id }">
          <summary class="cursor-pointer px-3 py-3 text-sm text-slate-700 dark:text-gray-200">
            <span class="mr-2 text-[10px] font-semibold text-slate-400">{{ kindLabel(claim.kind) }}</span>{{ claim.text }}
            <span class="mt-1 block pl-4 text-[11px] text-teal-700 dark:text-teal-300">{{ label(claim) }}</span>
          </summary>
          <div class="px-3 pb-3 space-y-3">
            <p v-if="!matchesFor(claim).length" class="text-xs text-amber-700 dark:text-amber-300"><FileQuestion :size="14" class="inline mr-1" />当前选择下没有匹配片段，不能据此断言该结论错误。</p>
            <article v-for="item in matchesFor(claim)" :key="item.id" class="rounded-lg bg-slate-50 p-3 dark:bg-gray-800">
              <div class="flex items-center justify-between gap-2 text-[11px] text-slate-500 dark:text-gray-400">
                <span>{{ item.title }} · {{ item.revision?.slice(0, 8) || '版本未知' }}</span>
                <router-link :to="{ path: `/wiki/${item.docId}`, query: { q: item.quote.slice(0, 50) } }" class="shrink-0 inline-flex items-center gap-1 text-teal-700 dark:text-teal-300">当前原文 <ExternalLink :size="12" /></router-link>
              </div>
              <blockquote class="mt-2 whitespace-pre-wrap break-words border-l-2 border-teal-300 pl-3 text-xs leading-relaxed text-slate-700 dark:text-gray-200">{{ item.quote }}{{ item.quoteTruncated ? '…（片段截断）' : '' }}</blockquote>
              <p v-if="item.needsReview" class="mt-2 text-xs text-amber-700 dark:text-amber-300">{{ item.reviewReason }}</p>
            </article>
          </div>
        </details>
        <p v-if="!claims.length" class="py-4 text-center text-xs text-slate-400">没有可展示的结论。</p>
      </div>
    </div>
  </section>
</template>
