<script setup>
import { computed, onUnmounted, ref, watch } from 'vue';
import { ScanSearch } from 'lucide-vue-next';
import EvidencePanel from './EvidencePanel.vue';
import { reviewAnswerEvidence } from '../../api/campus.js';

const props = defineProps({ report: { type: Object, default: null }, answer: { type: String, default: '' }, sources: { type: Array, default: () => [] }, disabled: Boolean });
const localReport = ref(null);
const busy = ref(false);
const error = ref('');
const selected = ref([]);
const sourceList = computed(() => props.sources.map(source => ({ docId: source.docId || source.id, title: source.title || '未命名来源' }))
  .filter((source, index, all) => source.docId && all.findIndex(item => item.docId === source.docId) === index));
watch(sourceList, list => { selected.value = list.slice(0, 8).map(source => source.docId); }, { immediate: true });
let requestSeq = 0;
watch([() => props.answer, () => props.sources, () => props.disabled], () => {
  requestSeq++;
  localReport.value = null;
  busy.value = false;
  error.value = '';
});
onUnmounted(() => { requestSeq++; });
const currentReport = computed(() => props.report && !props.report.contentOmitted ? props.report : localReport.value);
async function review() {
  if (busy.value || props.disabled || !selected.value.length || selected.value.length > 8) return;
  const answer = props.answer;
  const seq = ++requestSeq;
  busy.value = true;
  error.value = '';
  try {
    const report = await reviewAnswerEvidence({ answer, sources: selected.value.map(docId => ({ docId })) });
    if (seq === requestSeq && !props.disabled) localReport.value = report;
  } catch (err) { if (seq === requestSeq) error.value = err.message; }
  finally { if (seq === requestSeq) busy.value = false; }
}
</script>

<template>
  <div v-if="!disabled" class="mt-3">
    <EvidencePanel v-if="currentReport" :report="currentReport" compact />
    <details v-else-if="sourceList.length && answer" class="rounded-xl border border-slate-200 bg-slate-50/60 p-3 dark:border-gray-700 dark:bg-gray-900/50">
      <summary class="cursor-pointer text-xs font-semibold text-teal-700 dark:text-teal-300"><ScanSearch :size="14" class="mr-1 inline" />核验这份回答的依据</summary>
      <p class="mt-2 text-xs leading-relaxed text-slate-500 dark:text-gray-400">这份回答没有可用的生成时快照。可选择最多 8 个已发布来源，按当前版本重新核验；不会改写原回答。</p>
      <label v-for="source in sourceList" :key="source.docId" class="mt-2 flex items-center gap-2 text-xs text-slate-600 dark:text-gray-300"><input v-model="selected" type="checkbox" :value="source.docId" class="accent-teal-600" />{{ source.title }}</label>
      <p v-if="error" role="alert" class="mt-2 text-xs text-rose-600 dark:text-rose-300">{{ error }}</p>
      <button type="button" :disabled="busy || !selected.length || selected.length > 8" class="mt-3 rounded-lg bg-teal-700 px-3 py-2 text-xs text-white disabled:opacity-40" @click="review">{{ busy ? '核验中…' : '按当前来源核验' }}</button>
    </details>
  </div>
</template>
