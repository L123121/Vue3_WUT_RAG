<script setup>
import { computed, ref } from 'vue';
import { CheckCircle2, Circle, MapPin, Clock, ListChecks, ClipboardList, AlertCircle, FileText } from 'lucide-vue-next';

/**
 * 政策问答「步骤卡片」组件
 * 渲染后端解析出的流程卡片 JSON：{ summary, steps[], materials[], location, duration, notes }
 * 步骤带序号 + 图标 + 本地可勾选（仅交互状态，不持久化）。
 */
const props = defineProps({
  card: { type: Object, required: true },
});

// 勾选状态（本地交互，按步骤下标记录）
const checked = ref(new Set());
const toggleStep = (index) => {
  const next = new Set(checked.value);
  if (next.has(index)) next.delete(index);
  else next.add(index);
  checked.value = next;
};

const steps = computed(() => (Array.isArray(props.card?.steps) ? props.card.steps : []));
const materials = computed(() => (Array.isArray(props.card?.materials) ? props.card.materials : []));
</script>

<template>
  <div class="my-3 rounded-2xl border border-wut-100 dark:border-wut-900/40 bg-wut-50/80 dark:bg-wut-900/30 shadow-sm overflow-hidden">
    <!-- Header -->
    <div class="flex items-center gap-2 px-4 py-2.5 bg-wut-600/90 dark:bg-wut-800/80 text-white">
      <ClipboardList :size="15" class="shrink-0" />
      <span class="text-xs font-bold tracking-wide">办理流程</span>
      <span v-if="card.summary" class="flex-1 min-w-0 text-[11px] text-wut-100 truncate" :title="card.summary">
        {{ card.summary }}
      </span>
    </div>

    <div class="p-3.5 space-y-3">
      <!-- Steps -->
      <ol v-if="steps.length > 0" class="space-y-2">
        <li
          v-for="(step, index) in steps"
          :key="index"
          class="flex items-start gap-2.5 group"
          :class="{ 'opacity-50': checked.has(index) }"
        >
          <button
            type="button"
            class="mt-0.5 shrink-0 transition-colors cursor-pointer"
            :title="checked.has(index) ? '标记为未完成' : '标记为已完成'"
            @click="toggleStep(index)"
          >
            <CheckCircle2
              v-if="checked.has(index)"
              :size="18"
              class="text-emerald-500 dark:text-emerald-400"
            />
            <Circle v-else :size="18" class="text-wut-400 dark:text-wut-500/70 group-hover:text-wut-600 dark:group-hover:text-wut-400" />
          </button>
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-1.5">
              <span class="inline-flex items-center justify-center w-5 h-5 rounded-full bg-wut-100 dark:bg-wut-900/50 text-wut-700 dark:text-wut-300 text-[10px] font-bold shrink-0">
                {{ index + 1 }}
              </span>
              <span class="text-sm font-semibold text-slate-800 dark:text-gray-100">{{ step.title }}</span>
            </div>
            <p v-if="step.detail" class="mt-0.5 pl-7 text-xs text-slate-500 dark:text-gray-400 leading-relaxed">{{ step.detail }}</p>
          </div>
        </li>
      </ol>

      <!-- Materials -->
      <div v-if="materials.length > 0" class="rounded-xl bg-white dark:bg-gray-800/80 border border-slate-100 dark:border-gray-700 p-3">
        <div class="flex items-center gap-1.5 mb-1.5">
          <FileText :size="13" class="text-wut-500 dark:text-wut-400 shrink-0" />
          <span class="text-xs font-bold text-slate-600 dark:text-gray-300">所需材料</span>
        </div>
        <ul class="space-y-1">
          <li v-for="(m, i) in materials" :key="i" class="flex items-start gap-1.5 text-xs text-slate-500 dark:text-gray-400">
            <span class="text-wut-400 shrink-0">·</span>
            <span>{{ m }}</span>
          </li>
        </ul>
      </div>

      <!-- Meta info -->
      <div class="flex flex-wrap gap-x-4 gap-y-1.5">
        <span v-if="card.location" class="inline-flex items-center gap-1 text-[11px] text-slate-500 dark:text-gray-400">
          <MapPin :size="12" class="text-wut-500 dark:text-wut-400 shrink-0" />
          <span class="font-medium">办理地点：</span>{{ card.location }}
        </span>
        <span v-if="card.duration" class="inline-flex items-center gap-1 text-[11px] text-slate-500 dark:text-gray-400">
          <Clock :size="12" class="text-wut-500 dark:text-wut-400 shrink-0" />
          <span class="font-medium">办理时长：</span>{{ card.duration }}
        </span>
      </div>

      <!-- Notes -->
      <div v-if="card.notes" class="flex items-start gap-1.5 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/50 px-2.5 py-2">
        <AlertCircle :size="13" class="text-amber-500 dark:text-amber-400 shrink-0 mt-0.5" />
        <p class="text-[11px] text-amber-700 dark:text-amber-300 leading-relaxed">{{ card.notes }}</p>
      </div>

      <!-- Empty hint -->
      <p v-if="steps.length === 0 && materials.length === 0" class="text-xs text-slate-400 dark:text-gray-500">
        <ListChecks :size="12" class="inline mr-1" />未能提取到结构化流程信息，请参考上方回答。
      </p>
    </div>
  </div>
</template>
