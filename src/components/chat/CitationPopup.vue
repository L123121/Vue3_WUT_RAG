<script setup>
import { useRouter } from 'vue-router';
import { X, BookOpen, Database } from 'lucide-vue-next';
import MarkdownRenderer from './MarkdownRenderer.vue';
import { citationTarget } from '../../utils/citations.js';

/**
 * 行内引用弹窗：展示被引用来源的标题/分类/原文片段，并可跳转知识库或百科阅读页定位原文。
 * popup = { source: {...}, index: number } | null，由 MessageBubble 持有状态。
 */

const props = defineProps({
  popup: { type: Object, default: null },
});

const emit = defineEmits(['close']);
const router = useRouter();

const target = () => citationTarget(props.popup?.source);

// 知识库：管理视角，带关键词高亮定位
const openSourceInKnowledgeBase = () => {
  const { docId, q } = target();
  if (!docId) return;
  emit('close');
  router.push({ path: '/knowledge', query: { docId, ...(q ? { q } : {}) } });
};

// 百科：阅读视角，同一篇文档的完整词条，高亮口径与知识库一致
const openSourceInWiki = () => {
  const { docId, q } = target();
  if (!docId) return;
  emit('close');
  router.push({ path: `/wiki/${docId}`, query: q ? { q } : {} });
};
</script>

<template>
  <Teleport to="body">
    <Transition name="popup">
      <div v-if="popup" class="fixed inset-0 z-50 flex items-center justify-center p-4" @click.self="emit('close')">
        <div class="absolute inset-0 bg-black/30 backdrop-blur-sm" @click="emit('close')"></div>
        <div class="relative bg-white dark:bg-gray-900 rounded-2xl shadow-2xl border border-slate-200 dark:border-gray-700 max-w-lg w-full max-h-[60vh] overflow-hidden flex flex-col">
          <!-- Header -->
          <div class="flex items-center justify-between px-5 py-3 border-b border-slate-100 dark:border-gray-800 shrink-0">
            <div class="flex items-center gap-2 min-w-0">
              <span class="inline-flex items-center justify-center w-6 h-6 rounded-full bg-wut-100 dark:bg-wut-900/40 text-wut-700 dark:text-wut-300 text-xs font-bold shrink-0">{{ popup.index }}</span>
              <div class="min-w-0">
                <span class="text-sm font-semibold text-slate-800 dark:text-white truncate block">{{ popup.source.title }}</span>
                <span v-if="popup.source.category" class="text-[10px] text-slate-500 dark:text-gray-400">{{ popup.source.category }}</span>
              </div>
            </div>
            <button @click="emit('close')" class="shrink-0 p-1 rounded-lg hover:bg-slate-100 dark:hover:bg-gray-800 text-slate-400 hover:text-slate-600 dark:hover:text-gray-200 transition-colors cursor-pointer">
              <X :size="16" />
            </button>
          </div>
          <!-- Content -->
          <div class="p-5 overflow-y-auto flex-1">
            <MarkdownRenderer :content="popup.source.snippet || '（无原文内容）'" :sources="[]" />
          </div>
          <!-- Footer: 跳转原文（百科阅读 / 知识库管理） -->
          <div class="px-5 py-3 border-t border-slate-100 dark:border-gray-800 shrink-0 flex gap-2">
            <button
              @click="openSourceInWiki"
              class="flex-1 h-9 rounded-lg text-xs font-medium inline-flex items-center justify-center gap-1.5 bg-wut-600 text-white hover:bg-wut-700 transition-colors"
            >
              <BookOpen :size="13" />
              在百科中阅读
            </button>
            <button
              @click="openSourceInKnowledgeBase"
              class="flex-1 h-9 rounded-lg text-xs font-medium inline-flex items-center justify-center gap-1.5 border border-slate-200 dark:border-gray-700 text-slate-600 dark:text-gray-300 hover:bg-slate-100 dark:hover:bg-gray-800 transition-colors"
            >
              <Database :size="13" />
              在知识库查看原文
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.popup-enter-active { transition: all 0.2s ease-out; }
.popup-leave-active { transition: all 0.15s ease-in; }
.popup-enter-from { opacity: 0; }
.popup-enter-from > div:last-child { transform: scale(0.95) translateY(10px); }
.popup-leave-to { opacity: 0; }
.popup-leave-to > div:last-child { transform: scale(0.95); }
</style>
