<script setup>
import { FileDiff, AlertCircle } from 'lucide-vue-next';
defineProps({ change: { type: Object, required: true } });
</script>

<template>
  <section class="rounded-xl border border-amber-200 bg-amber-50/50 p-4 dark:border-amber-900/50 dark:bg-amber-900/10">
    <div class="flex items-start gap-2">
      <FileDiff v-if="change.available" :size="17" class="mt-0.5 shrink-0 text-amber-600" />
      <AlertCircle v-else :size="17" class="mt-0.5 shrink-0 text-amber-600" />
      <div class="flex-1 min-w-0">
        <h3 class="text-sm font-semibold text-slate-800 dark:text-gray-100">{{ change.title || '引用来源' }}</h3>
        <p v-if="!change.available" class="mt-1 text-xs leading-relaxed text-amber-800 dark:text-amber-300">来源已下架、删除或待重新审核。未审核的新正文不会进入提醒；请暂缓依赖该来源的办理步骤。</p>
        <p v-else class="mt-1 text-xs text-slate-500 dark:text-gray-400">{{ change.previousRevision?.slice(0, 8) || '原版本' }} → {{ change.revision?.slice(0, 8) }} · {{ change.simulated ? '演示语料' : '已审核上架' }}</p>
      </div>
      <router-link v-if="change.available" :to="`/wiki/${change.docId}`" class="shrink-0 text-xs font-medium text-wut-600 dark:text-wut-300">查看原文</router-link>
    </div>
    <template v-if="change.available && change.diff">
      <p v-if="change.diff.fields?.length" class="mt-3 text-xs text-amber-800 dark:text-amber-300">可能涉及：{{ change.diff.fields.join('、') }}（关键词提示，需人工确认）</p>
      <p v-if="change.diff.unavailableBaseline" class="mt-3 text-xs text-amber-800 dark:text-amber-300">旧版本已不在最近 8 个快照中，无法完整对比，请核对当前原文。</p>
      <div v-else class="mt-3 grid gap-3 md:grid-cols-2">
        <div class="rounded-lg bg-white/80 p-3 dark:bg-gray-900/70">
          <p class="mb-2 text-[11px] font-bold text-rose-700 dark:text-rose-300">原有内容 · {{ change.diff.removedCount || 0 }} 处</p>
          <p v-for="(line, i) in change.diff.removed" :key="i" class="mb-1 whitespace-pre-wrap break-words text-xs leading-relaxed text-slate-600 dark:text-gray-300">− {{ line }}</p>
          <p v-if="!change.diff.removed?.length" class="text-xs text-slate-400">无删除内容</p>
        </div>
        <div class="rounded-lg bg-white/80 p-3 dark:bg-gray-900/70">
          <p class="mb-2 text-[11px] font-bold text-teal-700 dark:text-teal-300">更新内容 · {{ change.diff.addedCount || 0 }} 处</p>
          <p v-for="(line, i) in change.diff.added" :key="i" class="mb-1 whitespace-pre-wrap break-words text-xs leading-relaxed text-slate-600 dark:text-gray-300">+ {{ line }}</p>
          <p v-if="!change.diff.added?.length" class="text-xs text-slate-400">无新增内容</p>
        </div>
      </div>
      <p v-if="change.diff.truncated" class="mt-2 text-xs text-amber-800 dark:text-amber-300">差异较长，仅展示部分内容，请打开完整原文核验。</p>
      <p v-if="change.diff.metadataChanged" class="mt-2 text-xs text-amber-800 dark:text-amber-300">标题、适用范围或有效期标注也有变化。</p>
    </template>
    <div class="mt-3 flex flex-wrap items-center gap-2"><slot /></div>
  </section>
</template>
