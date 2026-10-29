<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ListTodo, Radar, RefreshCw, ArrowRight, CalendarDays, AlertCircle, Plus } from 'lucide-vue-next';
import MobileMenuButton from '../components/layout/MobileMenuButton.vue';
import ConfirmDialog from '../components/common/ConfirmDialog.vue';
import TaskDetail from '../components/campus/TaskDetail.vue';
import SourceChangePanel from '../components/campus/SourceChangePanel.vue';
import { getWorkbench, getCampusTask, updateCampusTask, deleteCampusTask, subscribeSource, updateSourceSubscription, refreshWorkbench } from '../api/campus.js';
import { getWikiEntries } from '../api/wiki.js';
import { useToastStore } from '../stores/toast.store.js';

const route = useRoute();
const router = useRouter();
const toast = useToastStore();
const tab = computed(() => route.query.tab === 'radar' ? 'radar' : 'tasks');
const version = ref(0);
const tasks = ref([]);
const subscriptions = ref([]);
const selectedId = ref('');
const selectedTask = ref(null);
const loading = ref(true);
const detailLoading = ref(false);
const busy = ref(false);
const error = ref('');
const detailError = ref('');
const filter = ref('all');
const confirmation = ref(null);
const availableSources = ref([]);
const sourceChoice = ref('');
const sourceError = ref('');
let loadSeq = 0;
let detailSeq = 0;
let disposed = false;
const statusLabels = { draft: '待确认', active: '进行中', completed: '已完成', archived: '已归档' };
const activeTasks = computed(() => tasks.value.filter(task => task.status !== 'archived'));
const reviewCount = computed(() => activeTasks.value.filter(task => task.needsReview).length);
const updates = computed(() => subscriptions.value.filter(source => source.changed));
const shownTasks = computed(() => tasks.value.filter(task => filter.value === 'all' ? task.status !== 'archived' : filter.value === 'review' ? task.needsReview && task.status !== 'archived' : task.status === filter.value));
const sourceOptions = computed(() => availableSources.value.filter(source => !subscriptions.value.some(item => item.docId === source.id)));
const switchTab = value => router.replace({ path: '/workbench', query: value === 'radar' ? { tab: 'radar' } : selectedId.value ? { task: selectedId.value } : {} });

async function selectTask(id, navigate = true) {
  const seq = ++detailSeq;
  selectedId.value = id;
  selectedTask.value = null;
  detailError.value = '';
  detailLoading.value = Boolean(id);
  if (navigate) await router.replace({ path: '/workbench', query: { task: id } });
  if (!id || disposed || seq !== detailSeq) return;
  try {
    const result = await getCampusTask(id);
    if (seq !== detailSeq || disposed) return;
    selectedTask.value = result.task;
    version.value = result.version;
  } catch (err) {
    if (seq === detailSeq && !disposed) detailError.value = err.message;
  } finally { if (seq === detailSeq && !disposed) detailLoading.value = false; }
}

async function load(check = false) {
  const seq = ++loadSeq;
  loading.value = true;
  error.value = '';
  try {
    let result;
    if (check) {
      try { result = await refreshWorkbench(); } catch (err) {
        if (seq === loadSeq && !disposed) error.value = `检查更新失败，以下为已保存状态：${err.message}`;
        result = await getWorkbench();
      }
    } else result = await getWorkbench();
    if (seq !== loadSeq || disposed) return;
    version.value = result.version;
    tasks.value = result.tasks;
    subscriptions.value = result.subscriptions;
    const requested = String(route.query.task || selectedId.value || '');
    const id = tasks.value.some(task => task.id === requested) ? requested : activeTasks.value[0]?.id || '';
    await selectTask(id, false);
  } catch (err) {
    if (seq === loadSeq && !disposed) error.value = err.message;
  } finally { if (seq === loadSeq && !disposed) loading.value = false; }
}

async function mutate(action, message = '已保存') {
  if (busy.value) return;
  busy.value = true;
  try {
    await action();
    if (disposed) return;
    toast.success(message);
    await load();
  } catch (err) {
    if (disposed) return;
    toast.error(err.message);
    if (err.status === 409) await load();
  } finally { if (!disposed) busy.value = false; }
}
const updateTask = input => mutate(() => updateCampusTask(selectedId.value, { ...input, version: version.value }));
const reviewSource = change => {
  const id = selectedId.value;
  const expectedVersion = version.value;
  confirmation.value = {
    title: '确认来源变更', message: '确认已核对影响？将切换依据版本，不改写步骤、不清空进度。',
    run: () => mutate(() => updateCampusTask(id, { action: 'acknowledge_source', docId: change.docId, revision: change.revision, version: expectedVersion })),
  };
};
const removeTask = () => {
  const id = selectedId.value;
  const expectedVersion = version.value;
  confirmation.value = { title: '删除个人任务', message: '任务与办理进度将删除；独立来源订阅仍保留。', danger: true, run: () => mutate(() => deleteCampusTask(id, expectedVersion), '任务已删除') };
};
const subscriptionAction = (source, action) => {
  const expectedVersion = version.value;
  confirmation.value = {
    title: action === 'unsubscribe' ? '取消来源订阅' : '标记此版本已读',
    message: action === 'unsubscribe' ? '仅取消此订阅；未归档任务仍跟踪其引用来源。' : '仅更新订阅读取状态，关联任务仍需单独确认影响。',
    run: () => mutate(() => updateSourceSubscription(source.docId, { action, revision: source.revision, version: expectedVersion })),
  };
};
async function confirmAction() {
  const pending = confirmation.value;
  confirmation.value = null;
  await pending?.run();
}
async function addSubscription() {
  if (!sourceChoice.value) return;
  await mutate(() => subscribeSource(sourceChoice.value), '已订阅该来源');
  sourceChoice.value = '';
}
async function loadSources() {
  sourceError.value = '';
  try {
    const result = await getWikiEntries();
    if (!result.success) throw new Error(result.message || '可订阅来源加载失败');
    if (!disposed) availableSources.value = result.data?.entries || [];
  } catch (err) { if (!disposed) sourceError.value = err.message; }
}
watch(() => route.query.task, id => {
  if (id && id !== selectedId.value && !loading.value) void selectTask(String(id), false);
});
onMounted(() => { void load(true); void loadSources(); });
onUnmounted(() => { disposed = true; loadSeq++; detailSeq++; });
</script>

<template>
  <main class="h-full min-h-0 overflow-y-auto bg-slate-50/70 p-4 dark:bg-gray-950/40 md:p-6">
    <div class="mx-auto max-w-7xl space-y-5">
      <header class="flex flex-wrap items-center gap-3">
        <MobileMenuButton />
        <div class="flex-1"><p class="text-[10px] font-bold tracking-[0.22em] text-teal-700 dark:text-teal-400">CAMPUS WORKSPACE</p><h1 class="mt-1 text-2xl font-black text-slate-900 dark:text-white">校园办事工作台</h1><p class="mt-1 text-xs text-slate-500 dark:text-gray-400">有依据地开始，按进度推进，变化由你确认。</p></div>
        <button type="button" :disabled="loading || busy" class="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-600 shadow-sm dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300 disabled:opacity-40" @click="load(true)"><RefreshCw :size="14" :class="{ 'animate-spin': loading }" />检查更新</button>
      </header>
      <div class="grid grid-cols-3 gap-3">
        <div class="rounded-2xl border border-slate-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900"><p class="text-xs text-slate-500">我的任务</p><p class="mt-1 text-2xl font-bold text-slate-900 dark:text-white">{{ activeTasks.length }}</p></div>
        <div class="rounded-2xl border border-amber-200 bg-amber-50/70 p-4 dark:border-amber-900/50 dark:bg-amber-900/10"><p class="text-xs text-amber-700 dark:text-amber-300">待核对影响</p><p class="mt-1 text-2xl font-bold text-amber-800 dark:text-amber-200">{{ reviewCount }}</p></div>
        <div class="rounded-2xl border border-teal-200 bg-teal-50/70 p-4 dark:border-teal-900/50 dark:bg-teal-900/10"><p class="text-xs text-teal-700 dark:text-teal-300">订阅更新</p><p class="mt-1 text-2xl font-bold text-teal-800 dark:text-teal-200">{{ updates.length }}</p></div>
      </div>
      <nav aria-label="工作台视图" class="inline-flex gap-1 rounded-xl border border-slate-200 bg-white p-1 dark:border-gray-800 dark:bg-gray-900">
        <button type="button" :aria-pressed="tab === 'tasks'" class="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium" :class="tab === 'tasks' ? 'bg-slate-900 text-white dark:bg-teal-700' : 'text-slate-500 dark:text-gray-400'" @click="switchTab('tasks')"><ListTodo :size="16" />我的计划</button>
        <button type="button" :aria-pressed="tab === 'radar'" class="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium" :class="tab === 'radar' ? 'bg-slate-900 text-white dark:bg-teal-700' : 'text-slate-500 dark:text-gray-400'" @click="switchTab('radar')"><Radar :size="16" />变化雷达<span v-if="updates.length" class="rounded-full bg-amber-100 px-1.5 text-xs text-amber-800">{{ updates.length }}</span></button>
      </nav>
      <div v-if="error" role="alert" class="rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700 dark:border-rose-900 dark:bg-rose-900/10 dark:text-rose-300">{{ error }}<button class="ml-2 underline" @click="load()">重试读取</button></div>

      <div v-if="tab === 'tasks'" class="grid items-start gap-5 lg:grid-cols-[290px_minmax(0,1fr)]">
        <aside class="space-y-3">
          <select v-model="filter" aria-label="筛选任务状态" class="w-full rounded-xl border border-slate-200 bg-white p-3 text-xs text-slate-600 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300"><option value="all">全部未归档任务</option><option value="review">来源待核对</option><option v-for="(label, status) in statusLabels" :key="status" :value="status">{{ label }}</option></select>
          <div v-if="loading && !tasks.length" class="space-y-3"><div v-for="i in 3" :key="i" class="h-24 animate-pulse rounded-xl bg-slate-200/60 dark:bg-gray-800" /></div>
          <button v-for="task in shownTasks" :key="task.id" type="button" class="w-full rounded-2xl border p-4 text-left transition-colors" :class="selectedId === task.id ? 'border-teal-400 bg-teal-50/60 ring-1 ring-teal-200 dark:border-teal-700 dark:bg-teal-900/10 dark:ring-teal-900' : 'border-slate-200 bg-white hover:border-teal-200 dark:border-gray-800 dark:bg-gray-900'" @click="selectTask(task.id)">
            <div class="flex items-center justify-between gap-2"><span class="text-[10px] font-semibold text-slate-500 dark:text-gray-400">{{ statusLabels[task.status] }}</span><AlertCircle v-if="task.needsReview" :size="14" class="text-amber-600" /></div>
            <p class="mt-2 text-sm font-bold text-slate-800 dark:text-white">{{ task.title }}</p>
            <p class="mt-2 text-xs text-slate-500">{{ task.completedSteps }} / {{ task.steps.length }} 步骤</p>
            <p v-if="task.dueDate" class="mt-1 inline-flex items-center gap-1 text-[11px] text-slate-500"><CalendarDays :size="12" />{{ task.dueDate }}</p>
          </button>
          <p v-if="!loading && !shownTasks.length && tasks.length" class="p-5 text-center text-xs text-slate-400">当前筛选下没有任务</p>
          <router-link to="/chat" class="flex items-center justify-between rounded-xl border border-dashed border-slate-300 p-3 text-xs font-medium text-slate-500 dark:border-gray-700 dark:text-gray-400">从对话流程卡创建新任务<ArrowRight :size="14" /></router-link>
        </aside>
        <div v-if="detailLoading" class="h-96 animate-pulse rounded-2xl bg-slate-200/50 dark:bg-gray-800" />
        <div v-else-if="detailError" role="alert" class="rounded-2xl border border-rose-200 p-6 text-sm text-rose-600">{{ detailError }}<button class="ml-2 underline" @click="selectTask(selectedId, false)">重试</button></div>
        <TaskDetail v-else-if="selectedTask" :task="selectedTask" :busy="busy || loading" @action="updateTask" @delete="removeTask" @review-source="reviewSource" />
        <section v-else class="flex min-h-96 flex-col items-center justify-center rounded-2xl border border-dashed border-slate-300 bg-white/60 p-8 text-center dark:border-gray-700 dark:bg-gray-900/50"><ListTodo :size="36" class="text-teal-500" /><h2 class="mt-4 text-lg font-bold text-slate-800 dark:text-white">把一次提问，变成一份可继续的计划</h2><p class="mt-2 max-w-sm text-sm leading-relaxed text-slate-500 dark:text-gray-400">先在对话中询问办理流程。在回答的流程卡里选择“保存为办事任务”，核对来源后开始推进。</p><router-link to="/chat" class="mt-5 rounded-xl bg-teal-700 px-4 py-2.5 text-sm font-semibold text-white">去询问办理流程</router-link></section>
      </div>

      <section v-else class="space-y-4">
        <div class="rounded-2xl border border-slate-200 bg-white p-5 dark:border-gray-800 dark:bg-gray-900">
          <h2 class="text-base font-bold text-slate-800 dark:text-white">只关注与你有关的变化</h2>
          <p class="mt-2 text-xs leading-relaxed text-slate-500 dark:text-gray-400">首版跟踪已审核上架的百科来源，不直接爬取外部网站。后台定期检查，保留最近 8 个观测版本；未审核内容不进入提醒。标记已读不会替你确认任务影响。</p>
          <form class="mt-4 flex flex-wrap gap-2" @submit.prevent="addSubscription"><select v-model="sourceChoice" aria-label="选择订阅来源" class="min-w-0 flex-1 rounded-xl border border-slate-200 bg-transparent px-3 py-2.5 text-sm dark:border-gray-700 dark:text-gray-300"><option value="">选择一个已发布来源…</option><option v-for="source in sourceOptions" :key="source.id" :value="source.id">{{ source.title }}</option></select><button type="submit" :disabled="!sourceChoice || busy" class="inline-flex items-center gap-1 rounded-xl bg-teal-700 px-4 py-2 text-xs font-bold text-white disabled:opacity-40"><Plus :size="14" />订阅变化</button></form>
          <p v-if="sourceError" role="alert" class="mt-2 text-xs text-rose-600">{{ sourceError }}<button class="ml-2 underline" @click="loadSources">重试</button></p>
          <p v-else-if="!availableSources.length" class="mt-2 text-xs text-slate-400">暂时没有可订阅来源，需要管理员先审核上架。</p>
        </div>
        <div v-for="source in subscriptions" :key="source.docId" class="space-y-2">
          <SourceChangePanel v-if="source.changed" :change="source"><button v-if="source.available" type="button" :disabled="busy" class="rounded-lg bg-amber-700 px-3 py-2 text-xs text-white disabled:opacity-40" @click="subscriptionAction(source, 'acknowledge')">此版本已读</button><button v-for="id in source.taskIds" :key="id" type="button" class="rounded-lg border border-amber-300 px-3 py-2 text-xs text-amber-800 dark:border-amber-800 dark:text-amber-300" @click="selectTask(id)">查看关联任务</button><button type="button" :disabled="busy" class="ml-auto text-xs text-slate-500" @click="subscriptionAction(source, 'unsubscribe')">取消订阅</button></SourceChangePanel>
          <div v-else class="flex items-center gap-3 rounded-xl border border-slate-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900"><Radar :size="18" class="text-teal-600" /><div class="flex-1"><p class="text-sm font-semibold text-slate-700 dark:text-gray-200">{{ source.title }}</p><p class="mt-1 text-[11px] text-slate-400">暂无新变化 · {{ source.checkedAt ? `检查于 ${new Date(source.checkedAt).toLocaleString('zh-CN')}` : '尚未检查' }}</p></div><button type="button" :disabled="busy" class="text-xs text-slate-500" @click="subscriptionAction(source, 'unsubscribe')">取消订阅</button></div>
        </div>
        <p v-if="!subscriptions.length" class="rounded-2xl border border-dashed border-slate-300 p-12 text-center text-sm text-slate-500 dark:border-gray-700">还没有订阅。创建任务时，也会自动订阅它引用的来源。</p>
      </section>
    </div>
    <ConfirmDialog :show="!!confirmation" :title="confirmation?.title" :message="confirmation?.message" :danger="confirmation?.danger" @confirm="confirmAction" @cancel="confirmation = null" />
  </main>
</template>
