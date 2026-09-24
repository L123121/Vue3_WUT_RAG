<script setup>
import { BookOpen, ChevronRight, Eye, EyeOff, Info, Loader2, RefreshCw, Search, Upload, X } from 'lucide-vue-next';
import MobileMenuButton from '../components/layout/MobileMenuButton.vue';
import { useWikiBrowse, formatWikiDate, formatWikiSize } from '../composables/useWiki.js';
import { wikiEntryPath } from '../utils/wikiTree.js';

const {
  tree,
  shownEntries,
  loading,
  loadError,
  searching,
  isSearching,
  searchQuery,
  activeGroup,
  activeSub,
  showHidden,
  busyId,
  isAdmin,
  publishedCount,
  hiddenCount,
  loadEntries,
  selectGroup,
  selectSub,
  clearFilters,
  toggleVisibility,
  toggleShowHidden,
} = useWikiBrowse();
</script>

<template>
  <div class="h-full flex flex-col p-4 md:p-6 min-h-0">
    <!-- 头部 -->
    <div class="flex items-center justify-between mb-4">
      <div class="flex items-center gap-3">
        <MobileMenuButton />
        <div class="w-10 h-10 rounded-xl bg-wut-600 flex items-center justify-center text-white shadow-lg shadow-wut-500/20">
          <BookOpen :size="20" />
        </div>
        <div>
          <h1 class="text-lg font-bold text-slate-800 dark:text-white">校园百科</h1>
          <p class="text-xs text-slate-500 dark:text-gray-400">
            已上架 {{ publishedCount }} 条
            <span v-if="isAdmin">· 未上架 {{ hiddenCount }} 条</span>
          </p>
        </div>
      </div>
      <div class="flex items-center gap-2">
        <button
          v-if="isAdmin"
          @click="toggleShowHidden"
          :class="[
            'inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors',
            showHidden
              ? 'border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-300'
              : 'border-slate-200 dark:border-gray-700 text-slate-600 dark:text-gray-300 hover:bg-slate-100 dark:hover:bg-gray-800'
          ]"
        >
          <EyeOff v-if="showHidden" :size="14" />
          <Eye v-else :size="14" />
          <span>{{ showHidden ? '隐藏未上架' : '含未上架' }}</span>
        </button>
        <button
          @click="loadEntries({ force: true })"
          :disabled="loading"
          class="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-gray-700 px-3 py-1.5 text-xs font-medium text-slate-600 dark:text-gray-300 hover:bg-slate-100 dark:hover:bg-gray-800 disabled:opacity-50 transition-colors"
        >
          <RefreshCw :size="14" :class="loading ? 'animate-spin' : ''" />
          <span>刷新</span>
        </button>
      </div>
    </div>

    <!-- 内容口径说明：词条正文与知识库同源，语料内含虚构演示文档 -->
    <div class="flex items-start gap-2 rounded-xl border border-amber-200 dark:border-amber-900/50 bg-amber-50/70 dark:bg-amber-900/15 px-3 py-2 mb-4">
      <Info :size="14" class="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" />
      <p class="text-[11px] leading-relaxed text-amber-800 dark:text-amber-200/80">
        词条正文与 AI 回答同源，管理员在知识库侧上架后才对外可见；演示用虚构语料按治理规则禁止上架。校园事务请以学校官方渠道为准。
      </p>
    </div>

    <!-- 搜索：服务端匹配标题、分类与正文 -->
    <div class="relative mb-4">
      <Search :size="14" class="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 dark:text-gray-500" />
      <input
        v-model="searchQuery"
        type="search"
        placeholder="搜索标题、分类或正文…"
        class="w-full rounded-xl border border-slate-200 dark:border-gray-700 bg-white dark:bg-gray-900 pl-9 pr-9 py-2 text-sm text-slate-700 dark:text-gray-200 placeholder:text-slate-400 dark:placeholder:text-gray-500 focus:outline-none focus:ring-2 focus:ring-wut-500/30 focus:border-wut-400"
      />
      <Loader2 v-if="searching" :size="14" class="absolute right-3 top-1/2 -translate-y-1/2 animate-spin text-wut-500" />
      <button
        v-else-if="searchQuery"
        @click="searchQuery = ''"
        class="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 rounded-md text-slate-400 hover:bg-slate-100 dark:hover:bg-gray-800 transition-colors"
      >
        <X :size="13" />
      </button>
    </div>

    <!-- 窄屏下分类树不渲染，用下拉兜底 -->
    <select
      v-if="tree.length"
      :value="activeGroup"
      @change="selectGroup($event.target.value)"
      class="lg:hidden mb-3 w-full rounded-xl border border-slate-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-xs text-slate-700 dark:text-gray-200 focus:outline-none focus:ring-2 focus:ring-wut-500/30"
    >
      <option value="">全部一级分类</option>
      <option v-for="group in tree" :key="group.key" :value="group.key">
        {{ group.label }}（{{ group.count }}）
      </option>
    </select>

    <div class="flex-1 min-h-0 flex gap-4 overflow-hidden">
      <!-- 分类树 -->
      <aside class="hidden lg:flex w-56 shrink-0 flex-col overflow-y-auto rounded-xl border border-slate-200 dark:border-gray-800 bg-white/70 dark:bg-gray-900/60 p-2">
        <button
          @click="selectGroup('')"
          :class="[
            'rounded-lg px-2.5 py-1.5 text-left text-xs font-bold transition-colors',
            !activeGroup ? 'bg-wut-50 dark:bg-wut-900/30 text-wut-700 dark:text-wut-300' : 'text-slate-500 dark:text-gray-400 hover:bg-slate-50 dark:hover:bg-gray-800'
          ]"
        >
          全部词条
        </button>
        <div v-for="group in tree" :key="group.key" class="mt-1">
          <button
            @click="selectGroup(group.key)"
            :class="[
              'w-full flex items-center justify-between gap-1 rounded-lg px-2.5 py-1.5 text-left text-xs font-semibold transition-colors',
              activeGroup === group.key ? 'bg-wut-50 dark:bg-wut-900/30 text-wut-700 dark:text-wut-300' : 'text-slate-600 dark:text-gray-300 hover:bg-slate-50 dark:hover:bg-gray-800'
            ]"
          >
            <span class="truncate">{{ group.label }}</span>
            <span class="shrink-0 text-[10px] text-slate-400 dark:text-gray-500">{{ group.count }}</span>
          </button>
          <!-- 只有一级分类的语料（如 ragdata 的"学校概况"）不再重复列一层 -->
          <div v-if="group.children.length > 1" class="ml-2 mt-0.5 border-l border-slate-100 dark:border-gray-800 pl-1.5">
            <button
              v-for="child in group.children"
              :key="child.key"
              @click="selectSub(group.key, child.label)"
              :class="[
                'w-full flex items-center justify-between gap-1 rounded-md px-2 py-1 text-left text-[11px] transition-colors',
                activeSub === child.label && activeGroup === group.key
                  ? 'bg-wut-50/70 dark:bg-wut-900/20 text-wut-700 dark:text-wut-300 font-bold'
                  : 'text-slate-500 dark:text-gray-400 hover:text-slate-700 dark:hover:text-gray-200'
              ]"
            >
              <span class="truncate">{{ child.label }}</span>
              <span class="shrink-0 text-[10px] text-slate-400 dark:text-gray-500">{{ child.count }}</span>
            </button>
          </div>
        </div>
      </aside>

      <!-- 词条列表 -->
      <div class="flex-1 min-h-0 overflow-y-auto">
        <div v-if="loading && !shownEntries.length" class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          <div v-for="i in 6" :key="i" class="h-24 rounded-xl bg-slate-100 dark:bg-gray-800 animate-pulse" />
        </div>

        <div v-else-if="loadError" class="rounded-xl border border-rose-200 dark:border-rose-900/50 bg-rose-50/70 dark:bg-rose-900/15 p-4">
          <p class="text-sm font-semibold text-rose-700 dark:text-rose-300">词条列表加载失败</p>
          <p class="mt-1 text-xs text-rose-600/80 dark:text-rose-400/70">{{ loadError }}</p>
          <button
            @click="loadEntries({ force: true })"
            class="mt-3 rounded-lg border border-rose-300 dark:border-rose-800 px-3 py-1.5 text-xs font-bold text-rose-700 dark:text-rose-300 hover:bg-rose-100/60 dark:hover:bg-rose-900/30 transition-colors"
          >
            重试
          </button>
        </div>

        <template v-else>
          <div v-if="isSearching" class="mb-2 text-[11px] text-slate-500 dark:text-gray-400">
            搜索“{{ searchQuery }}”：{{ shownEntries.length }} 条命中
          </div>
          <div v-else-if="activeGroup" class="mb-2 text-[11px] text-slate-500 dark:text-gray-400">
            {{ activeGroup }}<span v-if="activeSub"> / {{ activeSub }}</span>
          </div>

          <div v-if="!shownEntries.length" class="flex flex-col items-center justify-center rounded-xl border border-dashed border-slate-200 dark:border-gray-800 py-20">
            <BookOpen :size="26" class="text-slate-300 dark:text-gray-600" />
            <p v-if="isSearching" class="mt-3 text-sm font-semibold text-slate-600 dark:text-gray-300">没有匹配“{{ searchQuery }}”的词条</p>
            <p v-else-if="!publishedCount" class="mt-3 text-sm font-semibold text-slate-600 dark:text-gray-300">还没有已上架的词条</p>
            <p v-else class="mt-3 text-sm font-semibold text-slate-600 dark:text-gray-300">该分类下暂无词条</p>
            <p v-if="isAdmin && !isSearching" class="mt-1 text-xs text-slate-400 dark:text-gray-500">
              点右上「含未上架」查看全部文档，再逐条上架
            </p>
            <button
              v-if="!isSearching && (activeGroup || activeSub)"
              @click="clearFilters"
              class="mt-3 rounded-lg border border-slate-200 dark:border-gray-700 px-3 py-1.5 text-xs font-bold text-slate-600 dark:text-gray-300 hover:bg-slate-100 dark:hover:bg-gray-800 transition-colors"
            >
              清除筛选
            </button>
          </div>

          <div v-else class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3 pb-4">
            <article
              v-for="doc in shownEntries"
              :key="doc.id"
              class="group relative flex flex-col rounded-xl border bg-white dark:bg-gray-900 p-3 transition-colors"
              :class="doc.visible
                ? 'border-slate-200 dark:border-gray-800 hover:border-wut-300 dark:hover:border-wut-700'
                : 'border-dashed border-amber-300 dark:border-amber-800'"
            >
              <router-link :to="wikiEntryPath(doc)" class="flex flex-col focus:outline-none">
                <h2 class="text-sm font-bold text-slate-800 dark:text-gray-100 line-clamp-2 group-hover:text-wut-700 dark:group-hover:text-wut-300 transition-colors">
                  {{ doc.title }}
                  <ChevronRight :size="13" class="inline -mt-0.5 opacity-0 group-hover:opacity-100 transition-opacity" />
                </h2>
                <p class="mt-1 text-[11px] font-semibold text-wut-600 dark:text-wut-400">
                  {{ doc.category || '未分类' }}
                  <span v-if="!doc.visible" class="ml-1 rounded bg-amber-100 dark:bg-amber-900/40 px-1.5 py-0.5 text-amber-700 dark:text-amber-300">未上架</span>
                  <span v-if="doc.stale" class="ml-1 rounded bg-rose-100 dark:bg-rose-900/40 px-1.5 py-0.5 text-rose-700 dark:text-rose-300">来源已更新</span>
                </p>
                <p v-if="doc.excerpt" class="mt-1.5 text-[11px] leading-relaxed text-slate-500 dark:text-gray-400 line-clamp-2">…{{ doc.excerpt }}…</p>
                <p class="mt-auto pt-2 text-[11px] text-slate-400 dark:text-gray-500">
                  {{ formatWikiSize(doc.contentLength) }} · {{ doc.chunkCount || 0 }} 段 · {{ formatWikiDate(doc.createdAt) }}
                </p>
              </router-link>
              <button
                v-if="isAdmin"
                @click="toggleVisibility(doc)"
                :disabled="busyId === doc.id"
                class="absolute right-2 top-2 inline-flex items-center gap-1 rounded-lg border border-slate-200 dark:border-gray-700 bg-white/90 dark:bg-gray-900/90 px-2 py-1 text-[10px] font-bold text-slate-600 dark:text-gray-300 hover:border-wut-300 dark:hover:border-wut-700 disabled:opacity-50 transition-colors"
              >
                <Upload v-if="!doc.visible" :size="11" />
                <EyeOff v-else :size="11" />
                <span>{{ busyId === doc.id ? '处理中' : (doc.visible ? '下架' : '上架') }}</span>
              </button>
            </article>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>
