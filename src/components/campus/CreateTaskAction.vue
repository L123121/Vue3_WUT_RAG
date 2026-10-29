<script setup>
import { computed, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { ListTodo, ArrowRight } from 'lucide-vue-next';
import { createCampusTask } from '../../api/campus.js';
import { useToastStore } from '../../stores/toast.store.js';

const props = defineProps({ card: { type: Object, required: true }, messageId: { type: String, required: true }, sources: { type: Array, default: () => [] }, disabled: Boolean });
const router = useRouter();
const toast = useToastStore();
const open = ref(false);
const busy = ref(false);
const error = ref('');
const context = ref('');
const selectedSources = ref([]);
const sourceRefs = computed(() => props.sources.map(source => ({ docId: source.docId || source.id, revision: source.sourceRevision || source.revision || '', title: source.title || '未命名来源' }))
  .filter((source, index, all) => source.docId && all.findIndex(other => other.docId === source.docId) === index));
watch(sourceRefs, sources => { selectedSources.value = sources.slice(0, 8).map(source => source.docId); }, { immediate: true });
async function create() {
  if (busy.value || props.disabled || !selectedSources.value.length || selectedSources.value.length > 8) return;
  busy.value = true;
  error.value = '';
  try {
    const sources = sourceRefs.value.filter(source => selectedSources.value.includes(source.docId)).map(({ docId, revision }) => ({ docId, revision }));
    const result = await createCampusTask({ originMessageId: props.messageId, card: props.card, context: context.value, sources });
    toast.success(result.existing ? '已打开此前创建的任务' : '草稿已保存，请在工作台核对后确认');
    await router.push({ path: '/workbench', query: { task: result.task.id } });
  } catch (err) {
    error.value = err.message;
  } finally { busy.value = false; }
}
</script>

<template>
  <div class="border-t border-wut-100 pt-3 dark:border-wut-900/40">
    <button type="button" :disabled="disabled || !sourceRefs.length" class="inline-flex items-center gap-2 rounded-lg bg-wut-600 px-3 py-2 text-xs font-semibold text-white hover:bg-wut-700 disabled:opacity-40" @click="open = !open">
      <ListTodo :size="14" />保存为办事任务<ArrowRight :size="13" />
    </button>
    <p class="mt-1.5 text-[11px] text-slate-500 dark:text-gray-400">卡片勾选仅临时预览；任务可跨会话保存，并订阅已上架来源的变化。</p>
    <form v-if="open && !disabled" class="mt-3 space-y-2" @submit.prevent="create">
      <label class="block text-xs text-slate-600 dark:text-gray-300">办理条件（校区、事项要求等，可选）
        <textarea v-model="context" maxlength="500" rows="2" class="mt-1 w-full rounded-lg border border-slate-200 bg-white p-2 text-xs dark:border-gray-700 dark:bg-gray-900" placeholder="补充与你有关的条件，核对流程是否适用" />
      </label>
      <fieldset :disabled="busy" class="space-y-1.5">
        <legend class="text-xs text-slate-600 dark:text-gray-300">确认计划依据（选择 1–8 个已上架来源）</legend>
        <label v-for="source in sourceRefs" :key="source.docId" class="flex items-start gap-2 text-xs text-slate-500 dark:text-gray-400"><input v-model="selectedSources" type="checkbox" :value="source.docId" class="mt-0.5 accent-teal-600" /><span>{{ source.title }} · {{ source.revision?.slice(0, 8) || '将核对当前版本' }}</span></label>
      </fieldset>
      <p class="text-[11px] text-amber-700 dark:text-amber-300">仅保存个人计划，不代提交申请。来源须已审核上架；原回答若过时，请先重新提问。未选来源的结论需要另外核验。</p>
      <p v-if="error" role="alert" class="text-xs text-rose-600 dark:text-rose-300">{{ error }}</p>
      <button type="submit" :disabled="busy || !selectedSources.length || selectedSources.length > 8" class="rounded-lg bg-wut-600 px-3 py-2 text-xs text-white disabled:opacity-50">{{ busy ? '正在保存…' : '保存草稿并打开工作台' }}</button>
    </form>
  </div>
</template>
