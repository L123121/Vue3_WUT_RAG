<script setup>
import { computed, onUnmounted, ref, watch, nextTick } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ArrowLeft, BookOpen, ChevronLeft, ChevronRight, Eye, EyeOff, FileWarning, PencilLine, ShieldAlert } from 'lucide-vue-next';
import MobileMenuButton from '../components/layout/MobileMenuButton.vue';
import MarkdownRenderer from '../components/chat/MarkdownRenderer.vue';
import { useWikiEntry, formatWikiDate, formatWikiSize } from '../composables/useWiki.js';
import { wikiEntryPath } from '../utils/wikiTree.js';
import { splitCategory } from '../constants/wiki-categories.js';

const route = useRoute();
const router = useRouter();
const {
  entry,
  articleBody,
  loading,
  loadError,
  notFound,
  isAdmin,
  busy,
  prevEntry,
  nextEntry,
  related,
  reload,
  toggleVisibility,
} = useWikiEntry();

const docId = computed(() => entry.value?.id || '');

const breadcrumb = computed(() => {
  const { group, sub } = splitCategory(entry.value?.category);
  return sub ? [group, sub] : [group];
});

// 引用跳转带来的关键词：交给 MarkdownRenderer 打 <mark>，再滚到第一处命中
const keyword = computed(() => String(route.query.q || '').slice(0, 50).trim());

// ===== 目录与定位：DOMPurify 白名单不含 id 属性，只能在渲染完成后操作 DOM =====
const contentRef = ref(null);
const toc = ref([]);
let anchorObserver = null;
let tocSignature = '';
let hitScrolled = false;

const rebuildToc = () => {
  const root = contentRef.value;
  if (!root) return;
  const items = Array.from(root.querySelectorAll('h2, h3')).map((el, index) => {
    if (!el.id) el.id = `wiki-anchor-${index}`;
    return { id: el.id, level: Number(el.tagName.slice(1)), text: el.textContent.trim() };
  }).filter(item => item.text);

  const signature = items.map(item => `${item.id}:${item.text}`).join('|');
  if (signature === tocSignature) return;
  tocSignature = signature;
  toc.value = items;
};

const scrollToKeywordHit = () => {
  if (!keyword.value || hitScrolled) return;
  const hit = contentRef.value?.querySelector('.search-hit');
  if (!hit) return;
  hitScrolled = true;
  hit.scrollIntoView({ behavior: 'smooth', block: 'center' });
};

const refreshDerivedDom = () => {
  rebuildToc();
  scrollToKeywordHit();
};

watch(contentRef, (el) => {
  anchorObserver?.disconnect();
  anchorObserver = null;
  if (!el) return;
  hitScrolled = false;
  anchorObserver = new window.MutationObserver(refreshDerivedDom);
  anchorObserver.observe(el, { childList: true, subtree: true });
  nextTick(refreshDerivedDom);
});

onUnmounted(() => anchorObserver?.disconnect());

const jumpTo = (id) => {
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
};

const relocate = () => {
  hitScrolled = false;
  scrollToKeywordHit();
};

// 复用知识库页已有的 route.query.docId 定位预览能力
const editInKnowledgeBase = () => {
  router.push({ path: '/knowledge', query: { docId: docId.value } });
};
</script>

<template>
  <div class="h-full flex flex-col p-4 md:p-6 min-h-0">
    <div class="flex items-center gap-2 mb-4">
      <MobileMenuButton />
      <router-link
        to="/wiki"
        class="inline-flex items-center gap-1 rounded-lg border border-slate-200 dark:border-gray-700 px-2.5 py-1.5 text-xs font-medium text-slate-600 dark:text-gray-300 hover:bg-slate-100 dark:hover:bg-gray-800 transition-colors"
      >
        <ArrowLeft :size="14" />
        <span>校园百科</span>
      </router-link>
      <div class="flex-1" />
      <button
        v-if="isAdmin && entry"
        @click="toggleVisibility"
        :disabled="busy"
        :class="[
          'inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-bold transition-colors disabled:opacity-50',
          entry.visible
            ? 'border-amber-300 dark:border-amber-800 text-amber-700 dark:text-amber-300 hover:bg-amber-50 dark:hover:bg-amber-900/20'
            : 'border-emerald-300 dark:border-emerald-800 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-50 dark:hover:bg-emerald-900/20'
        ]"
      >
        <EyeOff v-if="entry.visible" :size="14" />
        <Eye v-else :size="14" />
        <span>{{ busy ? '处理中…' : (entry.visible ? '下架词条' : '上架词条') }}</span>
      </button>
      <button
        v-if="entry"
        @click="editInKnowledgeBase"
        class="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-gray-700 px-2.5 py-1.5 text-xs font-medium text-slate-600 dark:text-gray-300 hover:bg-slate-100 dark:hover:bg-gray-800 transition-colors"
      >
        <PencilLine :size="14" />
        <span>管理原文</span>
      </button>
    </div>

    <div v-if="loading" class="flex-1 min-h-0 overflow-y-auto space-y-3">
      <div class="h-7 w-2/3 rounded-lg bg-slate-100 dark:bg-gray-800 animate-pulse" />
      <div v-for="i in 6" :key="i" class="h-4 rounded bg-slate-100 dark:bg-gray-800 animate-pulse" :class="i % 3 === 0 ? 'w-3/4' : 'w-full'" />
    </div>

    <div v-else-if="notFound" class="flex-1 min-h-0 overflow-y-auto flex flex-col items-center justify-center rounded-xl border border-dashed border-slate-200 dark:border-gray-800 py-20">
      <FileWarning :size="26" class="text-slate-300 dark:text-gray-600" />
      <p class="mt-3 text-sm font-semibold text-slate-600 dark:text-gray-300">词条不可见</p>
      <p class="mt-1 max-w-sm text-center text-xs text-slate-400 dark:text-gray-500">{{ loadError || '该文档不存在或管理员尚未将其上架' }}</p>
      <router-link
        to="/wiki"
        class="mt-4 rounded-lg border border-slate-200 dark:border-gray-700 px-3 py-1.5 text-xs font-bold text-slate-600 dark:text-gray-300 hover:bg-slate-100 dark:hover:bg-gray-800 transition-colors"
      >
        返回词条列表
      </router-link>
    </div>

    <div v-else-if="loadError" class="flex-1 min-h-0 overflow-y-auto rounded-xl border border-rose-200 dark:border-rose-900/50 bg-rose-50/70 dark:bg-rose-900/15 p-4">
      <p class="text-sm font-semibold text-rose-700 dark:text-rose-300">词条加载失败</p>
      <p class="mt-1 text-xs text-rose-600/80 dark:text-rose-400/70">{{ loadError }}</p>
      <button
        @click="reload"
        class="mt-3 rounded-lg border border-rose-300 dark:border-rose-800 px-3 py-1.5 text-xs font-bold text-rose-700 dark:text-rose-300 hover:bg-rose-100/60 dark:hover:bg-rose-900/30 transition-colors"
      >
        重试
      </button>
    </div>

    <div v-else class="flex-1 min-h-0 flex gap-5 overflow-hidden">
      <main class="flex-1 min-h-0 overflow-y-auto">
        <nav class="flex items-center gap-1 text-[11px] text-slate-400 dark:text-gray-500 mb-2">
          <router-link to="/wiki" class="hover:text-wut-600 dark:hover:text-wut-400">校园百科</router-link>
          <span v-for="item in breadcrumb" :key="item">
            <ChevronRight :size="11" class="inline" />
            <span>{{ item }}</span>
          </span>
        </nav>

        <h1 class="text-2xl font-black tracking-tight text-slate-900 dark:text-white leading-snug">
          {{ entry?.title || '未命名词条' }}
        </h1>

        <p class="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-slate-500 dark:text-gray-400">
          <span>{{ formatWikiSize(entry?.contentLength) }}</span>
          <span>·</span>
          <span>{{ entry?.chunkCount || 0 }} 个检索段落</span>
          <span>·</span>
          <span>入库于 {{ formatWikiDate(entry?.createdAt) }}</span>
          <span v-if="entry?.sourceLabel" class="rounded-full bg-slate-100 dark:bg-gray-800 px-2 py-0.5 text-slate-600 dark:text-gray-300">
            来源：{{ entry.sourceLabel }}
          </span>
          <span v-if="entry && !entry.visible" class="rounded-full bg-amber-100 dark:bg-amber-900/40 px-2 py-0.5 font-bold text-amber-700 dark:text-amber-300">
            未上架（仅管理员可见）
          </span>
        </p>

        <div
          v-if="entry?.simulated"
          class="mt-3 flex items-start gap-2 rounded-xl border border-rose-200 dark:border-rose-900/50 bg-rose-50/80 dark:bg-rose-900/15 px-3 py-2"
        >
          <ShieldAlert :size="14" class="mt-0.5 shrink-0 text-rose-600 dark:text-rose-400" />
          <p class="text-[11px] leading-relaxed text-rose-800 dark:text-rose-200/80">
            演示用虚构内容：本词条来自仓库内置的模拟语料，不来自武汉理工大学官方渠道，仅用于演示检索链路，不可作为校园信息参考。
          </p>
        </div>

        <div
          v-if="keyword"
          class="mt-3 flex items-center justify-between gap-3 rounded-xl border border-wut-200 dark:border-wut-800 bg-wut-50/70 dark:bg-wut-900/20 px-3 py-2"
        >
          <p class="text-[11px] text-wut-800 dark:text-wut-200 truncate">已按引用关键词定位：<span class="font-bold">{{ keyword }}</span></p>
          <button
            @click="relocate"
            class="shrink-0 rounded-lg border border-wut-300 dark:border-wut-700 px-2 py-1 text-[10px] font-bold text-wut-700 dark:text-wut-300 hover:bg-wut-100 dark:hover:bg-wut-900/40 transition-colors"
          >
            重新定位
          </button>
        </div>

        <div ref="contentRef" class="mt-4">
          <MarkdownRenderer :key="`${docId}|${keyword}`" :content="articleBody" :highlight="keyword" :sources="[]" />
        </div>

        <div v-if="prevEntry || nextEntry" class="mt-8 grid grid-cols-1 sm:grid-cols-2 gap-3">
          <router-link
            v-if="prevEntry"
            :to="wikiEntryPath(prevEntry)"
            class="rounded-xl border border-slate-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-3 hover:border-wut-300 dark:hover:border-wut-700 transition-colors"
          >
            <span class="flex items-center gap-1 text-[10px] text-slate-400 dark:text-gray-500">
              <ChevronLeft :size="12" /> 上一篇
            </span>
            <span class="mt-1 block line-clamp-2 text-xs font-bold text-slate-700 dark:text-gray-200">{{ prevEntry.title }}</span>
          </router-link>
          <router-link
            v-if="nextEntry"
            :to="wikiEntryPath(nextEntry)"
            class="sm:col-start-2 text-right rounded-xl border border-slate-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-3 hover:border-wut-300 dark:hover:border-wut-700 transition-colors"
          >
            <span class="flex items-center justify-end gap-1 text-[10px] text-slate-400 dark:text-gray-500">
              下一篇 <ChevronRight :size="12" />
            </span>
            <span class="mt-1 block line-clamp-2 text-xs font-bold text-slate-700 dark:text-gray-200">{{ nextEntry.title }}</span>
          </router-link>
        </div>
      </main>

      <aside class="hidden xl:flex w-60 shrink-0 flex-col overflow-y-auto rounded-xl border border-slate-200 dark:border-gray-800 bg-white/70 dark:bg-gray-900/60 p-3">
        <template v-if="toc.length">
          <h2 class="text-[10px] font-bold uppercase tracking-wider text-slate-400 dark:text-gray-500 mb-2">目录</h2>
          <nav class="space-y-1">
            <button
              v-for="item in toc"
              :key="item.id"
              @click="jumpTo(item.id)"
              :class="[
                'block w-full text-left text-[11px] leading-snug transition-colors hover:text-wut-700 dark:hover:text-wut-300',
                item.level === 2 ? 'font-semibold text-slate-600 dark:text-gray-300' : 'pl-2 text-slate-500 dark:text-gray-400'
              ]"
            >
              {{ item.text }}
            </button>
          </nav>
        </template>

        <div v-if="related.length" :class="toc.length ? 'mt-5 pt-4 border-t border-slate-100 dark:border-gray-800' : ''">
          <h2 class="flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-slate-400 dark:text-gray-500 mb-2">
            <BookOpen :size="11" /> 相关词条
          </h2>
          <div class="space-y-1">
            <router-link
              v-for="doc in related"
              :key="doc.id"
              :to="wikiEntryPath(doc)"
              class="block w-full text-left text-[11px] leading-snug text-slate-600 dark:text-gray-300 hover:text-wut-700 dark:hover:text-wut-300 transition-colors"
            >
              {{ doc.title }}
            </router-link>
          </div>
        </div>
      </aside>
    </div>
  </div>
</template>
