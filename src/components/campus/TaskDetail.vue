<script setup>
import { computed, nextTick, ref, watch } from 'vue';
import { Archive, Trash2, Plus, PencilLine, CheckCircle2, ScanSearch } from 'lucide-vue-next';
import EvidencePanel from './EvidencePanel.vue';
import SourceChangePanel from './SourceChangePanel.vue';

const props = defineProps({ task: { type: Object, required: true }, busy: Boolean });
const emit = defineEmits(['action', 'delete', 'review-source']);
const accepted = ref(false);
const details = ref({ title: '', context: '', dueDate: '' });
const stepNotes = ref({});
const editor = ref(null);
const materialEditor = ref(null);
const focusClaim = ref('');
const evidenceRoot = ref(null);
watch(() => props.task, task => {
  details.value = { title: task.title, context: task.context, dueDate: task.dueDate || '' };
  stepNotes.value = Object.fromEntries(task.steps.map(step => [step.id, { note: step.note || '', dueDate: step.dueDate || '' }]));
  accepted.value = false;
  editor.value = null;
  materialEditor.value = null;
}, { immediate: true });
const changedSources = computed(() => (props.task.sourceChanges || []).filter(change => change.changed));
const statusLabels = { pending: '待办', in_progress: '进行中', blocked: '待补充 / 等待确认', completed: '已完成' };
const saveStep = (step, status = step.status) => emit('action', { action: 'step', stepId: step.id, status, ...stepNotes.value[step.id] });
const editStep = step => { editor.value = { id: step?.id || '', title: step?.title || '', detail: step?.detail || '' }; };
const saveEditor = () => emit('action', { action: editor.value.id ? 'edit_step' : 'add_step', stepId: editor.value.id, title: editor.value.title, detail: editor.value.detail });
async function showEvidence(id) {
  focusClaim.value = id;
  await nextTick();
  evidenceRoot.value?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
}
const involvedSteps = change => props.task.steps.filter(step => change.relatedStepIds?.includes(step.id)).map(step => step.title).join('、');
</script>

<template>
  <article class="space-y-5" data-testid="task-detail">
    <header class="rounded-2xl border border-slate-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-900">
      <div class="flex items-start gap-3">
        <div class="flex-1 min-w-0">
          <p class="text-[10px] font-bold uppercase tracking-[0.18em] text-teal-600 dark:text-teal-400">My campus plan</p>
          <h2 class="mt-2 text-xl font-bold text-slate-900 dark:text-white">{{ task.title }}</h2>
          <p class="mt-2 text-xs text-slate-500 dark:text-gray-400">{{ task.completedSteps }} / {{ task.steps.length }} 个步骤完成 · {{ task.materials.filter(item => item.ready).length }} / {{ task.materials.length }} 项材料就绪</p>
        </div>
        <button type="button" :disabled="busy" :title="task.archived ? '恢复任务' : '归档任务'" class="rounded-lg border border-slate-200 p-2 text-slate-500 dark:border-gray-700 disabled:opacity-40" @click="emit('action', { action: task.archived ? 'restore' : 'archive' })"><Archive :size="16" /></button>
        <button type="button" :disabled="busy" title="删除任务" class="rounded-lg border border-rose-100 p-2 text-rose-500 dark:border-rose-900 disabled:opacity-40" @click="emit('delete')"><Trash2 :size="16" /></button>
      </div>
      <div class="mt-4 h-1.5 overflow-hidden rounded-full bg-slate-100 dark:bg-gray-800"><div class="h-full rounded-full bg-teal-500 transition-all" :style="{ width: `${task.completedSteps / task.steps.length * 100}%` }" /></div>
      <p class="mt-3 text-xs text-slate-500 dark:text-gray-400">个人办理计划，不代表已向发布方提交或通过审核。页面刷新后进度仍会保留。</p>
    </header>

    <div v-if="changedSources.length" class="space-y-3">
      <h3 class="text-sm font-bold text-amber-800 dark:text-amber-300">引用来源有变化，请先核对影响</h3>
      <SourceChangePanel v-for="change in changedSources" :key="change.docId" :change="change">
        <p class="w-full text-xs text-slate-600 dark:text-gray-400">{{ involvedSteps(change) ? `可能相关步骤：${involvedSteps(change)}。仅为来源关联，不是自动判定已失效。` : '尚无法准确定位受影响步骤，请检查整份计划。' }}</p>
        <button v-if="change.available" type="button" :disabled="busy || task.archived" class="rounded-lg bg-amber-700 px-3 py-2 text-xs font-medium text-white disabled:opacity-40" @click="emit('review-source', change)">我已核对，确认此版本</button>
        <span class="text-[11px] text-slate-500">不会自动改写步骤或清空已完成进度</span>
      </SourceChangePanel>
    </div>

    <fieldset :disabled="busy || task.archived" class="space-y-5 disabled:opacity-70">
      <form class="rounded-2xl border border-slate-200 bg-white p-4 space-y-3 dark:border-gray-700 dark:bg-gray-900" @submit.prevent="emit('action', { action: 'details', ...details })">
        <h3 class="text-sm font-semibold text-slate-800 dark:text-gray-100">办理条件与个人期限</h3>
        <div class="grid gap-3 sm:grid-cols-[1fr_160px]">
          <label class="text-xs text-slate-500 dark:text-gray-400">任务标题<input v-model="details.title" required maxlength="180" class="mt-1 w-full rounded-lg border border-slate-200 bg-transparent px-3 py-2 text-sm text-slate-800 dark:border-gray-700 dark:text-gray-200" /></label>
          <label class="text-xs text-slate-500 dark:text-gray-400">个人截止日期<input v-model="details.dueDate" type="date" class="mt-1 w-full rounded-lg border border-slate-200 bg-transparent px-3 py-2 text-sm dark:border-gray-700 dark:text-gray-200" /></label>
        </div>
        <label class="block text-xs text-slate-500 dark:text-gray-400">校区、身份和事项条件（由你确认，不自动推断）<textarea v-model="details.context" rows="2" maxlength="500" class="mt-1 w-full rounded-lg border border-slate-200 bg-transparent p-3 text-sm dark:border-gray-700 dark:text-gray-200" /></label>
        <p v-if="task.location || task.duration" class="text-xs text-slate-500 dark:text-gray-400">地点：{{ task.location || '待确认' }} · 预计耗时：{{ task.duration || '待确认' }}</p>
        <p v-if="task.notes" class="text-xs text-slate-500 dark:text-gray-400">{{ task.notes }}</p>
        <button type="submit" class="rounded-lg border border-slate-200 px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800">保存条件与日期</button>
      </form>

      <section v-if="!task.confirmedAt" class="rounded-2xl border border-teal-200 bg-teal-50/50 p-4 dark:border-teal-800 dark:bg-teal-900/10">
        <h3 class="text-sm font-bold text-teal-800 dark:text-teal-300">草稿待确认</h3>
        <label class="mt-2 flex items-start gap-2 text-xs leading-relaxed text-slate-600 dark:text-gray-300"><input v-model="accepted" type="checkbox" class="mt-0.5 accent-teal-600" />我已查看依据，核对适用范围、时间及步骤。此确认仅用于我的个人计划。</label>
        <button type="button" :disabled="!accepted || task.needsReview" class="mt-3 rounded-lg bg-teal-700 px-3 py-2 text-xs font-bold text-white disabled:opacity-40" @click="emit('action', { action: 'confirm' })">确认并开始办理</button>
      </section>

      <section class="rounded-2xl border border-slate-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
        <div class="mb-3 flex items-center justify-between"><h3 class="text-sm font-semibold text-slate-800 dark:text-white">办理步骤</h3><button type="button" class="inline-flex items-center gap-1 text-xs text-teal-700 dark:text-teal-300" @click="editStep(null)"><Plus :size="14" />添加步骤</button></div>
        <ol class="space-y-3">
          <li v-for="(step, index) in task.steps" :key="step.id" class="rounded-xl border p-3" :class="step.id === task.nextStep ? 'border-teal-200 bg-teal-50/30 dark:border-teal-900 dark:bg-teal-900/10' : 'border-slate-100 dark:border-gray-800'">
            <div class="flex items-start gap-2">
              <CheckCircle2 v-if="step.status === 'completed'" :size="20" class="mt-0.5 shrink-0 text-teal-600" />
              <span v-else class="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-slate-100 text-[11px] text-slate-500 dark:bg-gray-800">{{ index + 1 }}</span>
              <div class="min-w-0 flex-1"><p class="text-sm font-semibold text-slate-800 dark:text-gray-100">{{ step.title }}</p><p class="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-slate-500 dark:text-gray-400">{{ step.detail }}</p></div>
              <button type="button" title="编辑步骤，编辑后重新设为待办" class="text-slate-400 hover:text-teal-700" @click="editStep(step)"><PencilLine :size="14" /></button>
            </div>
            <div class="mt-3 flex flex-wrap items-center justify-between gap-2 pl-7">
              <select :value="step.status" :disabled="!task.confirmedAt" :aria-label="`${step.title}状态`" class="rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs text-slate-600 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200" @change="saveStep(step, $event.target.value)"><option v-for="(label, key) in statusLabels" :key="key" :value="key">{{ label }}</option></select>
              <button type="button" class="inline-flex items-center gap-1 text-xs text-teal-700 dark:text-teal-300" @click="showEvidence(step.id)"><ScanSearch :size="13" />查看这一步的依据</button>
            </div>
            <details class="mt-2 pl-7 text-xs text-slate-500 dark:text-gray-400">
              <summary class="cursor-pointer">备注与截止日期{{ step.dueDate ? ` · ${step.dueDate}` : '' }}</summary>
              <textarea v-model="stepNotes[step.id].note" rows="2" maxlength="1000" :aria-label="`${step.title}备注`" class="mt-2 w-full rounded-lg border border-slate-200 bg-transparent p-2 dark:border-gray-700" placeholder="例如：已联系、还缺少什么、等待谁确认" />
              <div class="mt-2 flex items-center gap-2"><input v-model="stepNotes[step.id].dueDate" type="date" :aria-label="`${step.title}截止日期`" class="rounded-lg border border-slate-200 bg-transparent p-2 dark:border-gray-700" /><button type="button" :disabled="!task.confirmedAt" class="text-teal-700 disabled:opacity-40 dark:text-teal-300" @click="saveStep(step)">保存备注与日期</button></div>
            </details>
          </li>
        </ol>
        <form v-if="editor" class="mt-3 rounded-xl border border-teal-200 p-3 space-y-2 dark:border-teal-800" @submit.prevent="saveEditor">
          <h4 class="text-xs font-semibold text-slate-700 dark:text-gray-300">{{ editor.id ? '修改步骤（此步骤将重新设为待办）' : '添加新步骤' }}</h4>
          <input v-model="editor.title" required maxlength="200" aria-label="步骤标题" placeholder="步骤标题" class="w-full rounded-lg border border-slate-200 bg-transparent p-2 text-sm dark:border-gray-700 dark:text-gray-200" />
          <textarea v-model="editor.detail" rows="2" maxlength="1200" aria-label="步骤说明" placeholder="说明与需要核对的条件" class="w-full rounded-lg border border-slate-200 bg-transparent p-2 text-xs dark:border-gray-700 dark:text-gray-200" />
          <button type="submit" class="rounded-lg bg-teal-700 px-3 py-1.5 text-xs text-white">保存步骤</button><button type="button" class="ml-2 text-xs text-slate-500" @click="editor = null">取消</button>
        </form>
      </section>

      <section class="rounded-2xl border border-slate-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
        <div class="mb-3 flex items-center justify-between"><h3 class="text-sm font-semibold text-slate-800 dark:text-gray-100">材料准备</h3><button type="button" class="inline-flex items-center gap-1 text-xs text-teal-700 dark:text-teal-300" @click="materialEditor = { id: '', text: '' }"><Plus :size="14" />添加材料</button></div>
        <div v-for="material in task.materials" :key="material.id" class="flex items-start gap-2 py-2">
          <label class="flex flex-1 items-start gap-2 text-sm text-slate-600 dark:text-gray-300"><input type="checkbox" :checked="material.ready" class="mt-1 accent-teal-600" @change="emit('action', { action: 'material', materialId: material.id, ready: $event.target.checked })" /><span :class="{ 'line-through text-slate-400': material.ready }">{{ material.text }}</span></label>
          <button type="button" title="修改材料，修改后重新设为待准备" class="text-slate-400" @click="materialEditor = { id: material.id, text: material.text }"><PencilLine :size="14" /></button>
          <button type="button" title="移除这项材料" class="text-rose-400" @click="emit('action', { action: 'remove_material', materialId: material.id })"><Trash2 :size="14" /></button>
        </div>
        <p v-if="!task.materials.length" class="text-xs text-slate-400">暂无材料清单，可按最新要求补充。</p>
        <form v-if="materialEditor" class="mt-3 space-y-2" @submit.prevent="emit('action', { action: materialEditor.id ? 'edit_material' : 'add_material', materialId: materialEditor.id, text: materialEditor.text })">
          <input v-model="materialEditor.text" required maxlength="500" aria-label="材料名称" placeholder="材料名称与份数" class="w-full rounded-lg border border-slate-200 bg-transparent p-2 text-xs dark:border-gray-700 dark:text-gray-200" />
          <button type="submit" class="rounded-lg bg-teal-700 px-3 py-1.5 text-xs text-white">保存材料</button><button type="button" class="ml-2 text-xs text-slate-500" @click="materialEditor = null">取消</button>
        </form>
      </section>
    </fieldset>

    <div ref="evidenceRoot"><EvidencePanel :report="task.evidence" :focus-claim-id="focusClaim" /></div>
    <details class="rounded-xl border border-slate-200 px-4 py-3 text-xs text-slate-500 dark:border-gray-700 dark:text-gray-400"><summary class="cursor-pointer">最近操作记录</summary><ol class="mt-3 space-y-2"><li v-for="(event, index) in [...task.history].reverse()" :key="index"><time>{{ new Date(event.at).toLocaleString('zh-CN') }}</time><span class="ml-2">{{ event.action }}</span></li></ol></details>
  </article>
</template>
