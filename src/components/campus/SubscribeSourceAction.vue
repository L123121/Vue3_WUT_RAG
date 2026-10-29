<script setup>
import { ref, watch } from 'vue';
import { Radar } from 'lucide-vue-next';
import { subscribeSource } from '../../api/campus.js';
import { useToastStore } from '../../stores/toast.store.js';
const props = defineProps({ docId: { type: String, required: true } });
const toast = useToastStore();
const busy = ref(false);
const saved = ref(false);
watch(() => props.docId, () => { saved.value = false; });
async function subscribe() {
  if (busy.value) return;
  const docId = props.docId;
  busy.value = true;
  try {
    await subscribeSource(docId);
    if (props.docId === docId) saved.value = true;
    toast.success('已订阅，后续已审核版本的变化将在雷达中显示');
  } catch (error) { toast.error(error.message); }
  finally { busy.value = false; }
}
</script>

<template>
  <router-link v-if="saved" to="/workbench?tab=radar" class="inline-flex items-center gap-1.5 rounded-lg border border-teal-200 px-2.5 py-1.5 text-xs font-medium text-teal-700 dark:border-teal-800 dark:text-teal-300"><Radar :size="14" />查看变化雷达</router-link>
  <button v-else type="button" :disabled="busy" class="inline-flex items-center gap-1.5 rounded-lg border border-teal-200 px-2.5 py-1.5 text-xs font-medium text-teal-700 disabled:opacity-40 dark:border-teal-800 dark:text-teal-300" @click="subscribe"><Radar :size="14" />{{ busy ? '订阅中…' : '订阅变化' }}</button>
</template>
