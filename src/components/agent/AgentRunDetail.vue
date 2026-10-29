<script setup>
import { computed, ref, watch } from 'vue';
import { Play, Pause, RotateCcw, Square, GitBranch, CheckCircle2, ShieldCheck, History, Download, Trash2 } from 'lucide-vue-next';
import MarkdownRenderer from '../chat/MarkdownRenderer.vue';
import { agentStatusLabel, canResumeAgent, isAgentTerminal, formatAgentTime } from '../../utils/agentRunLabels.js';

const props = defineProps({ run: { type: Object, required: true }, busy: Boolean, readOnly: Boolean, now: { type: Number, default: () => Date.now() } });
const emit = defineEmits(['action', 'approval', 'edit-plan']);
const editor = ref(null);
const editError = ref('');
const approvalReview = ref(null);
const approvalAccepted = ref(false);
watch(() => props.run.id, () => { editor.value = null; approvalReview.value = null; approvalAccepted.value = false; });
watch(() => props.readOnly, () => { approvalReview.value = null; approvalAccepted.value = false; });
const finished = computed(() => props.run.steps.filter(step => step.status === 'succeeded').length);
const reviewStillValid = computed(() => {
  const review = approvalReview.value;
  if (!review || props.readOnly) return false;
  const step = props.run.steps.find(item => item.id === review.stepId);
  return step?.status === 'awaiting_approval' && step.approval?.id === review.id && step.approval?.digest === review.digest && review.expiresAt > props.now;
});
function openApproval(step) {
  approvalReview.value = { ...step.approval, stepId: step.id, tool: step.tool, label: step.label };
  approvalAccepted.value = false;
}
function decide(decision) {
  if (!reviewStillValid.value || (decision === 'approve' && !approvalAccepted.value)) return;
  const review = approvalReview.value;
  emit('approval', review.stepId, { requestId: review.id, digest: review.digest, decision });
  approvalReview.value = null;
}
function editPlan() {
  editor.value = {
    version: props.run.version,
    value: JSON.stringify(props.run.steps.map(({ id, label, tool, input, dependsOn, notBefore }) => ({ id, label, tool, input, dependsOn, notBefore })), null, 2),
  };
  editError.value = '';
}
function savePlan() {
  try {
    const steps = JSON.parse(editor.value.value);
    if (!Array.isArray(steps)) throw new Error('计划必须为步骤数组');
    emit('edit-plan', { version: editor.value.version, steps });
    editor.value = null;
  } catch (error) { editError.value = error.message; }
}
function download(step) {
  const content = step.result?.content;
  if (typeof content !== 'string') return;
  const url = URL.createObjectURL(new Blob([content], { type: 'text/plain;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url; link.download = `agent-${props.run.id.slice(-10)}-${step.id}.txt`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const pretty = value => JSON.stringify(value, null, 2);
const toolNames = { search_published_sources: '检索已发布资料', read_published_source: '读取指定原文', compile_research_brief: '归并来源摘录', save_research_brief: '保存个人产物' };
</script>

<template>
  <article class="min-w-0 space-y-4" data-testid="agent-run-detail">
    <header class="rounded-2xl border border-slate-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-900">
      <div class="flex flex-wrap items-start gap-3">
        <div class="flex-1 min-w-0"><p class="text-[10px] font-bold tracking-[0.2em] text-sky-700 dark:text-sky-400">{{ readOnly ? 'READ-ONLY REPLAY' : 'DURABLE AGENT RUN' }}</p><h2 class="mt-2 break-words text-xl font-bold text-slate-900 dark:text-white">{{ run.title }}</h2><p class="mt-2 text-xs leading-relaxed text-slate-500 dark:text-gray-400">{{ run.goal }}</p></div>
        <span class="rounded-full bg-sky-50 px-3 py-1 text-xs font-semibold text-sky-700 dark:bg-sky-900/20 dark:text-sky-300">{{ agentStatusLabel(run.status) }}</span>
      </div>
      <div class="mt-4 grid grid-cols-3 gap-2 text-xs text-slate-500 dark:text-gray-400"><span>已完成 <b class="text-slate-800 dark:text-gray-100">{{ finished }} / {{ run.steps.length }}</b></span><span>累计调用 <b class="text-slate-800 dark:text-gray-100">{{ run.calls }} / {{ run.maxCalls }}</b></span><span>检查点 <b class="text-slate-800 dark:text-gray-100">#{{ run.checkpointSeq }}</b></span></div>
      <div class="mt-3 h-1.5 rounded-full bg-slate-100 dark:bg-gray-800"><div class="h-full rounded-full bg-sky-500 transition-all" :style="{ width: `${finished / run.steps.length * 100}%` }" /></div>
      <p class="mt-3 text-[11px] text-slate-400">计划 v{{ run.planVersion }} · 恢复 {{ run.resumes }} 次 · 到期 {{ formatAgentTime(run.expiresAt) }}</p>
      <div v-if="!readOnly" class="mt-4 flex flex-wrap gap-2">
        <button v-if="run.status === 'draft'" type="button" :disabled="busy" class="inline-flex items-center gap-1.5 rounded-lg bg-sky-700 px-3 py-2 text-xs font-bold text-white disabled:opacity-40" @click="emit('action', 'start')"><Play :size="14" />确认计划并开始</button>
        <button v-if="run.status === 'draft'" type="button" :disabled="busy" class="rounded-lg border border-slate-200 px-3 py-2 text-xs text-slate-600 dark:border-gray-700 dark:text-gray-300" @click="editPlan">编辑依赖计划</button>
        <button v-if="['running', 'waiting', 'queued', 'awaiting_approval'].includes(run.status)" type="button" :disabled="busy" class="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-xs text-slate-600 dark:border-gray-700 dark:text-gray-300" @click="emit('action', 'pause')"><Pause :size="14" />暂停</button>
        <button v-if="canResumeAgent(run.status)" type="button" :disabled="busy" class="inline-flex items-center gap-1.5 rounded-lg bg-sky-700 px-3 py-2 text-xs font-bold text-white disabled:opacity-40" @click="emit('action', 'resume')"><RotateCcw :size="14" />{{ run.status === 'awaiting_approval' ? '重新请求审批' : '从检查点恢复' }}</button>
        <button v-if="!isAgentTerminal(run.status) && run.status !== 'cancel_requested'" type="button" :disabled="busy" class="inline-flex items-center gap-1.5 rounded-lg border border-rose-200 px-3 py-2 text-xs text-rose-600 dark:border-rose-900 dark:text-rose-300" @click="emit('action', 'cancel')"><Square :size="13" />取消任务</button>
        <button v-if="isAgentTerminal(run.status)" type="button" :disabled="busy" class="ml-auto inline-flex items-center gap-1 rounded-lg px-3 py-2 text-xs text-slate-400" @click="emit('action', 'remove')"><Trash2 :size="13" />删除运行记录</button>
      </div>
      <p v-else class="mt-4 inline-flex items-center gap-2 text-xs font-semibold text-amber-700 dark:text-amber-300"><History :size="14" />历史状态只读，查看事件不会重新调用任何工具。</p>
      <p v-if="run.error" role="alert" class="mt-3 rounded-lg bg-rose-50 p-3 text-xs text-rose-700 dark:bg-rose-900/15 dark:text-rose-300">{{ run.error.message }} <span class="block mt-1 font-mono text-[10px]">{{ run.error.code }}</span></p>
    </header>

    <form v-if="editor && !readOnly && run.status === 'draft'" class="rounded-2xl border border-sky-200 bg-white p-4 dark:border-sky-900 dark:bg-gray-900" @submit.prevent="savePlan">
      <h3 class="text-sm font-bold text-slate-800 dark:text-gray-100">可验证的依赖计划</h3><p class="mt-1 text-xs text-slate-500">只编辑工具参数和 dependsOn 依赖；结果用 $from / path 引用，不能填写任意代码。开始后计划不可原地修改。</p>
      <textarea v-model="editor.value" rows="16" maxlength="32000" aria-label="依赖计划JSON" class="mt-3 w-full rounded-xl border border-slate-200 bg-slate-50 p-3 font-mono text-xs text-slate-700 dark:border-gray-700 dark:bg-gray-950 dark:text-gray-200" />
      <p v-if="editError" role="alert" class="mt-2 text-xs text-rose-600">{{ editError }}</p><button type="submit" :disabled="busy" class="mt-3 rounded-lg bg-sky-700 px-3 py-2 text-xs font-bold text-white">验证并保存草稿</button><button type="button" class="ml-3 text-xs text-slate-500" @click="editor = null">取消编辑</button>
    </form>

    <section v-if="approvalReview && !readOnly" class="rounded-2xl border-2 border-amber-300 bg-amber-50/60 p-5 dark:border-amber-800 dark:bg-amber-900/10" data-testid="agent-approval-review">
      <h3 class="flex items-center gap-2 text-sm font-bold text-amber-900 dark:text-amber-200"><ShieldCheck :size="18" />审批：{{ approvalReview.label }}</h3>
      <p class="mt-2 text-xs leading-relaxed text-amber-800 dark:text-amber-300">仅批准下面这组参数的一次执行，绑定计划、依赖结果和策略版本；失效、失败重试或参数变化都需要重新审批。</p>
      <dl class="mt-3 text-[11px] text-slate-600 dark:text-gray-400"><dt>策略版本 / 过期时间</dt><dd>{{ approvalReview.policyVersion }} / {{ formatAgentTime(approvalReview.expiresAt) }}</dd><dt class="mt-1">操作摘要校验</dt><dd class="break-all font-mono">{{ approvalReview.digest }}</dd></dl>
      <details open class="mt-3"><summary class="text-xs font-semibold text-slate-700 dark:text-gray-300">完整操作参数</summary><pre class="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-white p-3 text-[11px] text-slate-600 dark:bg-gray-950 dark:text-gray-300">{{ pretty(approvalReview.inputPreview) }}</pre></details>
      <label class="mt-4 flex items-start gap-2 text-xs text-slate-700 dark:text-gray-300"><input v-model="approvalAccepted" type="checkbox" :disabled="busy || !reviewStillValid" class="mt-0.5 accent-amber-600" />我已核对操作参数，允许本次执行。</label>
      <p v-if="!reviewStillValid" role="alert" class="mt-2 text-xs text-rose-600 dark:text-rose-300">审批已过期或运行已变化，请刷新并重新请求审批。</p>
      <div class="mt-3 flex flex-wrap gap-2"><button type="button" :disabled="busy || !reviewStillValid || !approvalAccepted" class="rounded-lg bg-amber-700 px-3 py-2 text-xs font-bold text-white disabled:opacity-40" @click="decide('approve')">批准一次执行</button><button type="button" :disabled="busy || !reviewStillValid" class="rounded-lg border border-rose-200 px-3 py-2 text-xs text-rose-700 disabled:opacity-40 dark:border-rose-900 dark:text-rose-300" @click="decide('deny')">拒绝并取消计划</button><button type="button" class="ml-auto text-xs text-slate-500" @click="approvalReview = null">稍后决定</button></div>
    </section>

    <section class="rounded-2xl border border-slate-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
      <h3 class="mb-4 flex items-center gap-2 text-sm font-bold text-slate-800 dark:text-white"><GitBranch :size="17" class="text-sky-600" />计划与执行状态</h3>
      <ol class="space-y-3">
        <li v-for="step in run.steps" :key="step.id" class="rounded-xl border p-3" :class="step.status === 'awaiting_approval' ? 'border-amber-300 bg-amber-50/40 dark:border-amber-900 dark:bg-amber-900/10' : 'border-slate-100 dark:border-gray-800'">
          <div class="flex items-start gap-2"><CheckCircle2 v-if="step.status === 'succeeded'" :size="17" class="mt-0.5 shrink-0 text-teal-600" /><span v-else class="mt-1 h-2 w-2 shrink-0 rounded-full" :class="step.status === 'running' ? 'bg-sky-500 animate-pulse' : 'bg-slate-300'" /><div class="min-w-0 flex-1"><p class="text-sm font-semibold text-slate-800 dark:text-gray-200">{{ step.label }}</p><p class="mt-1 font-mono text-[10px] text-slate-400">{{ step.id }} · {{ toolNames[step.tool] || step.tool }}</p></div><span class="text-[11px] font-medium text-sky-700 dark:text-sky-300">{{ agentStatusLabel(step.status) }}</span></div>
          <p class="mt-2 text-[11px] text-slate-500 dark:text-gray-400">{{ step.dependsOn.length ? `等待：${step.dependsOn.join('、')}` : '无依赖 · 可独立调度' }} · 已尝试 {{ step.attempts }} / 3 次<span v-if="step.durationMs != null"> · {{ step.durationMs }}ms</span></p>
          <p v-if="step.notBefore" class="mt-1 text-[11px] text-slate-400">不早于 {{ formatAgentTime(step.notBefore) }}</p>
          <p v-if="step.error" class="mt-2 break-words text-xs text-rose-600 dark:text-rose-300">{{ step.error.message }}</p>
          <button v-if="!readOnly && step.status === 'awaiting_approval'" type="button" :disabled="busy" class="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-amber-700 px-3 py-2 text-xs font-bold text-white disabled:opacity-40" @click="openApproval(step)"><ShieldCheck :size="13" />审阅操作参数</button>
          <details class="mt-2"><summary class="cursor-pointer text-[11px] text-slate-500">输入与依赖绑定</summary><pre class="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-slate-50 p-2 text-[11px] text-slate-600 dark:bg-gray-950 dark:text-gray-300">{{ pretty(step.input) }}</pre></details>
          <details v-if="step.result" class="mt-2"><summary class="cursor-pointer text-xs font-medium text-teal-700 dark:text-teal-300">查看已持久化结果 <span class="font-mono text-[10px]">{{ step.resultHash?.slice(0, 8) }}</span></summary>
            <div v-if="typeof step.result.content === 'string'" class="mt-3 rounded-xl border border-slate-100 p-3 dark:border-gray-800"><MarkdownRenderer :content="step.result.content" :sources="step.result.sources || []" /><button type="button" class="mt-3 inline-flex items-center gap-1 text-xs text-sky-700 dark:text-sky-300" @click="download(step)"><Download :size="13" />下载文本摘录</button></div>
            <pre v-else class="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-slate-50 p-3 text-[11px] text-slate-600 dark:bg-gray-950 dark:text-gray-300">{{ pretty(step.result) }}</pre>
            <div v-if="step.result.sources?.length" class="mt-2 flex flex-wrap gap-2"><router-link v-for="(source, i) in step.result.sources" :key="`${source.docId}:${i}`" :to="`/wiki/${encodeURIComponent(source.docId)}`" class="rounded-lg border border-slate-200 px-2 py-1 text-[11px] text-sky-700 dark:border-gray-700 dark:text-sky-300">{{ source.title }} · {{ source.revision?.slice(0, 8) }}</router-link></div>
          </details>
        </li>
      </ol>
    </section>
  </article>
</template>
