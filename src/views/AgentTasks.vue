<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { Bot, Plus, RefreshCw, ShieldCheck, History, GitBranch, AlertCircle } from 'lucide-vue-next';
import MobileMenuButton from '../components/layout/MobileMenuButton.vue';
import ConfirmDialog from '../components/common/ConfirmDialog.vue';
import AgentRunDetail from '../components/agent/AgentRunDetail.vue';
import ToolPolicyPanel from '../components/agent/ToolPolicyPanel.vue';
import { useAuthStore } from '../stores/auth.store.js';
import { useToastStore } from '../stores/toast.store.js';
import * as api from '../api/agentRuns.js';
import { agentStatusLabel, agentEventLabel, formatAgentTime } from '../utils/agentRunLabels.js';

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const toast = useToastStore();
const tab = ref('runs');
const mode = ref('live');
const runs = ref([]);
const selectedId = ref('');
const run = ref(null);
const replayState = ref(null);
const catalog = ref(null);
const workerOnline = ref(false);
const loading = ref(true);
const busy = ref(false);
const error = ref('');
const toolsError = ref('');
const events = ref([]);
const lastSeq = ref(0);
const through = ref(1);
const replayBusy = ref(false);
const confirmation = ref(null);
const showCreate = ref(false);
const form = ref({ goal: '', queries: '图书馆开放时间\n借阅办理材料', persist: true, startAt: '' });
const makeRequestId = () => globalThis.crypto?.randomUUID?.() || `req_${Date.now()}_${Math.random().toString(36).slice(2, 12)}`;
let requestId = makeRequestId();
let loadSequence = 0;
let detailSequence = 0;
let replaySequence = 0;
let eventsSequence = 0;
let refreshing = false;
let disposed = false;
let pollTimer;
const now = ref(Date.now());
const displayedRun = computed(() => mode.value === 'replay' ? replayState.value : run.value);
const approvals = computed(() => runs.value.filter(item => item.status === 'awaiting_approval').length);
const active = computed(() => runs.value.filter(item => ['queued', 'running', 'waiting'].includes(item.status)).length);

async function selectRun(id, navigate = true) {
  const seq = ++detailSequence;
  selectedId.value = id;
  mode.value = 'live'; replayState.value = null; events.value = []; lastSeq.value = 0;
  replaySequence++; eventsSequence++; replayBusy.value = false;
  run.value = null;
  if (navigate) await router.replace({ path: '/agent-tasks', query: id ? { run: id } : {} });
  if (!id || disposed || seq !== detailSequence) return;
  try {
    const value = await api.getAgentRun(id);
    if (!disposed && seq === detailSequence) run.value = value;
  } catch (err) { if (!disposed && seq === detailSequence) error.value = err.message; }
}
async function refresh(silent = false) {
  if (silent && refreshing) return;
  const seq = ++loadSequence;
  refreshing = true;
  if (!silent) loading.value = true;
  try {
    const result = await api.listAgentRuns();
    if (disposed || seq !== loadSequence) return;
    runs.value = result.runs;
    workerOnline.value = result.workerOnline;
    now.value = Date.now();
    error.value = '';
    const requested = String(route.query.run || selectedId.value || '');
    const id = result.runs.some(item => item.id === requested) ? requested : result.runs[0]?.id || '';
    if (id !== selectedId.value || (!run.value && id)) await selectRun(id, false);
    else if (id && mode.value === 'live') {
      const detailSeq = ++detailSequence;
      const detail = await api.getAgentRun(id);
      if (!disposed && detailSeq === detailSequence && id === selectedId.value) run.value = detail;
    }
  } catch (err) { if (!disposed && seq === loadSequence) error.value = err.message; }
  finally { if (!disposed && seq === loadSequence) { loading.value = false; refreshing = false; } }
}
async function loadTools() {
  try { const result = await api.getAgentToolPolicies(); if (!disposed) { catalog.value = result; toolsError.value = ''; } }
  catch (err) { if (!disposed) toolsError.value = err.message; }
}
async function createRun() {
  if (busy.value) return;
  busy.value = true;
  try {
    const value = await api.createAgentRun({ requestId, goal: form.value.goal, queries: form.value.queries.split('\n').map(text => text.trim()).filter(Boolean), persist: form.value.persist, startAt: form.value.startAt ? new Date(form.value.startAt).getTime() : 0 });
    if (disposed) return;
    requestId = makeRequestId();
    showCreate.value = false;
    await selectRun(value.run.id);
    await refresh();
    toast.success('计划草稿已保存，核对后再开始执行');
  } catch (err) { if (!disposed) toast.error(err.message); }
  finally { if (!disposed) busy.value = false; }
}
async function mutate(action, message = '已保存') {
  if (busy.value) return;
  busy.value = true;
  try {
    const value = await action();
    if (disposed) return;
    if (value?.id === selectedId.value) run.value = value;
    toast.success(message);
    await refresh();
  } catch (err) {
    if (!disposed) { toast.error(err.message); if (err.status === 409) await refresh(); }
  } finally { if (!disposed) busy.value = false; }
}
function runAction(action) {
  if (!run.value || mode.value !== 'live') return;
  const { id, version } = run.value;
  const call = { start: api.startAgentRun, pause: api.pauseAgentRun, resume: api.resumeAgentRun, cancel: api.cancelAgentRun, remove: api.removeAgentRun }[action];
  if (!call) return;
  if (['cancel', 'remove'].includes(action)) {
    confirmation.value = { title: action === 'cancel' ? '取消Agent计划' : '删除运行与回放记录', message: action === 'cancel' ? '停止后续步骤，已完成的副作用不会自动撤销。' : '终态运行的检查点、事件和私有产物将被删除。', danger: true, run: () => mutate(() => call(id, version), '操作已完成') };
  } else void mutate(() => call(id, version), action === 'resume' ? '已排队恢复，完成步骤不会重跑' : '运行状态已更新');
}
async function confirmAction() { const value = confirmation.value; confirmation.value = null; await value?.run(); }
const approve = (stepId, input) => {
  if (mode.value !== 'live') return;
  const id = selectedId.value;
  void mutate(() => api.approveAgentStep(id, stepId, input), input.decision === 'approve' ? '已批准一次执行' : '已拒绝该操作');
};
const editPlan = input => { const id = selectedId.value; return mutate(() => api.editAgentPlan(id, input), '依赖计划已验证并保存'); };
async function savePolicy(input) {
  if (busy.value) return;
  busy.value = true;
  try { const result = await api.updateAgentToolPolicy(input); if (!disposed) { catalog.value = result; toast.success('策略已保存，待执行步骤会重新检查'); } }
  catch (err) { if (!disposed) { toast.error(err.message); if (err.status === 409) await loadTools(); } }
  finally { if (!disposed) busy.value = false; }
}
async function loadEvents(reset = false) {
  const id = selectedId.value;
  if (!id || replayBusy.value) return;
  const seq = ++eventsSequence;
  if (reset) { mode.value = 'replay'; replayState.value = null; }
  replayBusy.value = true;
  try {
    const value = await api.getAgentEvents(id, reset ? 0 : events.value.at(-1)?.seq || 0);
    if (disposed || id !== selectedId.value || seq !== eventsSequence) return;
    events.value = reset ? value.events : [...events.value, ...value.events];
    lastSeq.value = value.lastSeq;
    if (reset) { through.value = value.lastSeq || 1; await showReplay(); }
  } catch (err) { if (!disposed && seq === eventsSequence) toast.error(err.message); }
  finally { if (!disposed && seq === eventsSequence) replayBusy.value = false; }
}
async function showReplay() {
  const id = selectedId.value;
  const seq = ++replaySequence;
  try {
    const value = await api.replayAgentRun(id, Number(through.value));
    if (!disposed && id === selectedId.value && seq === replaySequence) { replayState.value = value.state; mode.value = 'replay'; }
  } catch (err) { if (!disposed && seq === replaySequence) toast.error(err.message); }
}
async function returnLive() { replaySequence++; eventsSequence++; replayBusy.value = false; mode.value = 'live'; replayState.value = null; await refresh(); }
watch(() => route.query.run, id => { if (id && id !== selectedId.value) void selectRun(String(id), false); });
onMounted(() => {
  void refresh(); void loadTools();
  pollTimer = setInterval(() => {
    now.value = Date.now();
    if (!busy.value && !loading.value && !showCreate.value && document.visibilityState !== 'hidden') void refresh(true);
  }, 4000);
});
onUnmounted(() => { disposed = true; loadSequence++; detailSequence++; replaySequence++; clearInterval(pollTimer); });
</script>

<template>
  <main class="h-full min-h-0 overflow-y-auto bg-slate-50/70 p-4 md:p-6 dark:bg-gray-950/30">
    <div class="mx-auto max-w-7xl space-y-5">
      <header class="flex flex-wrap items-center gap-3"><MobileMenuButton /><div class="flex-1"><p class="text-[10px] font-bold tracking-[0.2em] text-sky-700 dark:text-sky-400">AGENT OPERATIONS</p><h1 class="mt-1 text-2xl font-black text-slate-900 dark:text-white">Agent 任务中心</h1><p class="mt-1 text-xs text-slate-500 dark:text-gray-400">计划先行 · 独立执行 · 审批可控 · 检查点恢复</p></div><button type="button" :disabled="busy || loading" class="rounded-xl border border-slate-200 bg-white p-2.5 text-slate-600 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300" title="刷新任务状态" @click="refresh()"><RefreshCw :size="16" :class="{ 'animate-spin': loading }" /></button><button type="button" :disabled="busy || catalog?.runtimeEnabled === false" class="inline-flex items-center gap-1.5 rounded-xl bg-sky-700 px-4 py-2.5 text-xs font-bold text-white disabled:opacity-40" @click="showCreate = !showCreate; tab = 'runs'"><Plus :size="14" />新建计划</button></header>
      <div class="grid grid-cols-3 gap-3"><div class="rounded-2xl border border-slate-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900"><p class="text-xs text-slate-500">运行记录</p><b class="mt-1 block text-2xl text-slate-900 dark:text-white">{{ runs.length }}</b></div><div class="rounded-2xl border border-sky-200 bg-sky-50/60 p-4 dark:border-sky-900 dark:bg-sky-900/10"><p class="text-xs text-sky-700 dark:text-sky-300">排队 / 执行</p><b class="mt-1 block text-2xl text-sky-900 dark:text-sky-200">{{ active }}</b></div><div class="rounded-2xl border border-amber-200 bg-amber-50/60 p-4 dark:border-amber-900 dark:bg-amber-900/10"><p class="text-xs text-amber-700 dark:text-amber-300">待人工审批</p><b class="mt-1 block text-2xl text-amber-900 dark:text-amber-200">{{ approvals }}</b></div></div>
      <div v-if="!workerOnline && !loading" class="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50/60 p-3 text-xs leading-relaxed text-amber-800 dark:border-amber-900 dark:bg-amber-900/10 dark:text-amber-300"><AlertCircle :size="15" class="mt-0.5 shrink-0" /><p>独立执行器暂无心跳。计划会保留在队列，API不会代执行。请在后端目录启动 <code class="font-mono">npm run worker</code>；API和worker须使用同一数据库。</p></div>
      <p v-else-if="workerOnline" class="inline-flex items-center gap-1.5 text-[11px] text-teal-700 dark:text-teal-300"><span class="h-1.5 w-1.5 rounded-full bg-teal-500" />独立执行器在线 · 浏览器关闭不影响后台运行</p>
      <p v-if="error" role="alert" class="rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700 dark:border-rose-900 dark:bg-rose-900/10 dark:text-rose-300">{{ error }}<button type="button" class="ml-2 underline" @click="refresh()">重试</button></p>
      <nav class="inline-flex gap-1 rounded-xl border border-slate-200 bg-white p-1 dark:border-gray-800 dark:bg-gray-900" aria-label="Agent中心视图"><button type="button" class="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium" :class="tab === 'runs' ? 'bg-slate-900 text-white dark:bg-sky-800' : 'text-slate-500'" @click="tab = 'runs'"><Bot :size="15" />任务运行</button><button type="button" class="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium" :class="tab === 'policy' ? 'bg-slate-900 text-white dark:bg-sky-800' : 'text-slate-500'" @click="tab = 'policy'; loadTools()"><ShieldCheck :size="15" />工具权限</button></nav>

      <form v-if="showCreate && tab === 'runs'" class="rounded-2xl border border-sky-200 bg-white p-5 dark:border-sky-900 dark:bg-gray-900" @submit.prevent="createRun">
        <fieldset :disabled="busy" class="space-y-3"><h2 class="text-base font-bold text-slate-800 dark:text-white">创建校园资料研究计划</h2><p class="text-xs leading-relaxed text-slate-500 dark:text-gray-400">首版模板：多个已发布资料查询并行执行 → 汇编原文摘录 → 人工批准后保存。这里是显式依赖计划，不会让模型执行任意代码，也不额外消耗模型token。</p>
          <label class="block text-xs text-slate-600 dark:text-gray-300">任务目标<input v-model="form.goal" required maxlength="1000" placeholder="例如：整理图书馆使用与借阅指南" class="mt-1 w-full rounded-xl border border-slate-200 bg-transparent px-3 py-2.5 text-sm dark:border-gray-700" /></label>
          <div class="grid gap-3 md:grid-cols-2"><label class="block text-xs text-slate-600 dark:text-gray-300">独立检索问题（每行一个，最多6个）<textarea v-model="form.queries" required maxlength="3000" rows="4" class="mt-1 w-full rounded-xl border border-slate-200 bg-transparent p-3 text-sm dark:border-gray-700" /></label><div class="space-y-3"><label class="block text-xs text-slate-600 dark:text-gray-300">计划开始时间（可选，最多延后7天）<input v-model="form.startAt" type="datetime-local" class="mt-1 w-full rounded-xl border border-slate-200 bg-transparent px-3 py-2.5 text-sm dark:border-gray-700" /></label><label class="flex items-start gap-2 text-xs leading-relaxed text-slate-600 dark:text-gray-300"><input v-model="form.persist" type="checkbox" class="mt-0.5 accent-sky-600" />增加“保存个人摘录”步骤，执行前必须审批。</label></div></div>
          <div class="flex gap-3"><button type="submit" class="rounded-xl bg-sky-700 px-4 py-2.5 text-xs font-bold text-white">{{ busy ? '保存中…' : '生成并保存计划草稿' }}</button><button type="button" class="text-xs text-slate-500" @click="showCreate = false">取消</button></div>
        </fieldset>
      </form>
      <template v-if="tab === 'policy'"><p v-if="toolsError" role="alert" class="text-sm text-rose-600">{{ toolsError }}<button class="ml-2 underline" @click="loadTools">重试</button></p><ToolPolicyPanel v-if="catalog" :catalog="catalog" :admin="auth.isAdmin" :busy="busy" @save="savePolicy" /></template>
      <div v-else class="grid items-start gap-5 lg:grid-cols-[260px_minmax(0,1fr)]">
        <aside class="space-y-3"><button v-for="item in runs" :key="item.id" type="button" class="w-full rounded-2xl border p-4 text-left transition-colors" :class="item.id === selectedId ? 'border-sky-400 bg-sky-50/60 dark:border-sky-800 dark:bg-sky-900/10' : 'border-slate-200 bg-white hover:border-sky-200 dark:border-gray-800 dark:bg-gray-900'" @click="selectRun(item.id)"><span class="text-[10px] font-semibold text-sky-700 dark:text-sky-300">{{ agentStatusLabel(item.status) }}</span><p class="mt-2 break-words text-sm font-bold text-slate-800 dark:text-gray-100">{{ item.title }}</p><p class="mt-2 text-[11px] text-slate-400">{{ item.steps.filter(step => step.status === 'succeeded').length }} / {{ item.steps.length }} 步 · {{ item.calls }} 次调用</p></button><p v-if="!runs.length && !loading" class="rounded-xl border border-dashed border-slate-300 p-6 text-center text-xs text-slate-400 dark:border-gray-700">还没有Agent运行记录</p></aside>
        <div v-if="run" class="min-w-0 space-y-4">
          <div class="flex flex-wrap gap-2"><button type="button" class="inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-xs" :class="mode === 'live' ? 'border-sky-300 text-sky-700 dark:text-sky-300' : 'border-slate-200 text-slate-500 dark:border-gray-700'" @click="returnLive"><GitBranch :size="13" />当前状态</button><button type="button" :disabled="replayBusy" class="inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-xs" :class="mode === 'replay' ? 'border-amber-300 text-amber-800 dark:text-amber-300' : 'border-slate-200 text-slate-500 dark:border-gray-700'" @click="loadEvents(true)"><History :size="13" />只读回放</button></div>
          <section v-if="mode === 'replay'" class="rounded-2xl border border-amber-200 bg-amber-50/40 p-4 dark:border-amber-900 dark:bg-amber-900/10"><h3 class="text-sm font-bold text-slate-800 dark:text-white">执行事件时间线</h3><p class="mt-1 text-xs text-slate-500 dark:text-gray-400">回放只恢复历史界面，不重新发起工具调用；恢复执行请回到“当前状态”。</p><label class="mt-3 flex items-center gap-2 text-xs text-slate-500">查看事件 #<input v-model.number="through" type="number" min="1" :max="lastSeq" aria-label="回放事件序号" class="w-24 rounded-lg border border-amber-200 bg-white p-2 dark:border-amber-900 dark:bg-gray-900" /><button type="button" class="font-semibold text-amber-800 dark:text-amber-300" @click="showReplay">查看历史状态</button></label><ol class="mt-3 max-h-52 overflow-y-auto space-y-1"><li v-for="item in events" :key="item.seq"><button type="button" class="w-full rounded-lg px-2 py-1.5 text-left text-xs text-slate-600 hover:bg-white dark:text-gray-400 dark:hover:bg-gray-900" :class="{ 'bg-white dark:bg-gray-900': item.seq === through }" @click="through = item.seq; showReplay">#{{ item.seq }} {{ agentEventLabel(item.type) }} <span class="ml-1 text-[10px] text-slate-400">{{ formatAgentTime(item.at) }}</span></button></li></ol><button v-if="events.at(-1)?.seq < lastSeq" type="button" :disabled="replayBusy" class="mt-2 text-xs text-amber-800 dark:text-amber-300" @click="loadEvents()">加载更多事件</button></section>
          <AgentRunDetail v-if="displayedRun" :run="displayedRun" :read-only="mode === 'replay'" :busy="busy" :now="now" @action="runAction" @approval="approve" @edit-plan="editPlan" />
        </div>
        <section v-else class="flex min-h-96 flex-col items-center justify-center rounded-2xl border border-dashed border-slate-300 bg-white/60 p-8 text-center dark:border-gray-700 dark:bg-gray-900/40"><Bot :size="36" class="text-sky-500" /><h2 class="mt-4 text-lg font-bold text-slate-800 dark:text-white">把复杂任务交给可恢复的计划</h2><p class="mt-2 max-w-md text-sm leading-relaxed text-slate-500 dark:text-gray-400">先保存依赖计划，再交给独立执行器。每步结果都有检查点，涉及持久化操作时由你批准。</p><button type="button" class="mt-5 rounded-xl bg-sky-700 px-4 py-2.5 text-xs font-bold text-white" @click="showCreate = true">创建第一个计划</button></section>
      </div>
    </div>
    <ConfirmDialog :show="!!confirmation" :title="confirmation?.title" :message="confirmation?.message" :danger="confirmation?.danger" @confirm="confirmAction" @cancel="confirmation = null" />
  </main>
</template>
