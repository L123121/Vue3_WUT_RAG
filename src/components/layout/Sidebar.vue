<script setup>
import { computed, ref, watch } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import wutLogoImg from '../../assets/wuhan-university-logo.png';
import ConversationList from '../chat/ConversationList.vue';
import { Activity, BookOpen, Database, MessageSquare, BarChart3, LogOut, MessagesSquare, ChevronUp, Moon, Sun } from 'lucide-vue-next';
import { useAuthStore } from '../../stores/auth.store.js';
import { useConversationStore } from '../../stores/conversation.store.js';
import { useToastStore } from '../../stores/toast.store.js';
import { useThemeStore } from '../../stores/theme.store.js';
import { prefetchRoute } from '../../utils/prefetch.js';
import ProfilePanel from '../common/ProfilePanel.vue';
import FavoritesPanel from './FavoritesPanel.vue';

const wutLogo = wutLogoImg;
const router = useRouter();
const route = useRoute();
const authStore = useAuthStore();
const convStore = useConversationStore();
const toast = useToastStore();
const themeStore = useThemeStore();
const currentPath = computed(() => route.path);

const showDevEval = import.meta.env.VITE_SHOW_DEV_EVAL === 'true';

// 头像加载失败时回退到首字母占位
const avatarFailed = ref(false);
watch(() => authStore.user?.avatar, () => { avatarFailed.value = false; });

const showProfilePanel = ref(false);

const handleLogout = async () => {
  const synced = await convStore.flushPendingChanges();
  if (!synced) {
    toast.error('对话记录同步失败，请稍后重试后再退出');
    return;
  }
  convStore.resetConversationState();
  // 同步已确认成功，此时才能清缓存；清的是当前用户命名空间（chat_cache:<userId>）
  convStore.clearPersistedCache();
  await authStore.logout();
  await router.replace('/login');
};

const handleClickOutside = (event) => {
  const panel = document.querySelector('.profile-panel');
  const btn = event.target.closest('[data-profile-trigger]');
  if (showProfilePanel.value && panel && !panel.contains(event.target) && !btn) {
    showProfilePanel.value = false;
  }
};

watch(showProfilePanel, (val) => {
  if (val) {
    document.addEventListener('click', handleClickOutside, { once: true });
  }
});
</script>

<template>
  <div class="w-72 h-screen bg-white/80 dark:bg-gray-900/95 backdrop-blur-md border-r border-t border-b border-slate-200 dark:border-gray-800 flex flex-col z-20 transition-all duration-300 ease-in-out">
    <div class="p-6 pt-8 flex flex-col items-start justify-center">
      <div class="flex items-center gap-3 mb-2 px-2">
        <div class="w-20 h-20 rounded-full overflow-hidden flex items-center justify-center shrink-0">
          <img :src="wutLogo" alt="WUT Logo" class="w-full h-full object-cover scale-125 drop-shadow-md" />
        </div>
        <div>
          <h1 class="text-xl font-extrabold tracking-tight text-slate-800 dark:text-white leading-tight">武理小精灵</h1>
          <p class="text-[10px] font-bold text-wut-800 dark:text-wut-400 tracking-widest uppercase mt-0.5 opacity-90">WUT Assistant</p>
        </div>
      </div>
    </div>

    <!-- 导航标签 -->
    <div class="px-3 mb-2">
      <div class="flex gap-1 p-1 rounded-lg bg-slate-100 dark:bg-gray-800">
        <button
          @click="router.push('/chat')"
          :class="[
            'flex-1 h-8 rounded-md text-xs font-medium inline-flex items-center justify-center gap-1.5 transition-colors',
            currentPath === '/chat'
              ? 'bg-white dark:bg-gray-700 text-slate-800 dark:text-white shadow-sm'
              : 'text-slate-500 dark:text-gray-400 hover:text-slate-700 dark:hover:text-gray-200'
          ]"
        >
          <MessageSquare :size="14" />
          <span>对话</span>
        </button>
        <button
          @click="router.push('/knowledge')"
          @mouseenter="prefetchRoute('/knowledge')"
          :class="[
            'flex-1 h-8 rounded-md text-xs font-medium inline-flex items-center justify-center gap-1.5 transition-colors',
            currentPath === '/knowledge'
              ? 'bg-white dark:bg-gray-700 text-slate-800 dark:text-white shadow-sm'
              : 'text-slate-500 dark:text-gray-400 hover:text-slate-700 dark:hover:text-gray-200'
          ]"
        >
          <Database :size="14" />
          <span>知识库</span>
        </button>
        <button
          @click="router.push('/wiki')"
          @mouseenter="prefetchRoute('/wiki')"
          :class="[
            'flex-1 h-8 rounded-md text-xs font-medium inline-flex items-center justify-center gap-1.5 transition-colors',
            currentPath === '/wiki' || currentPath.startsWith('/wiki/')
              ? 'bg-white dark:bg-gray-700 text-slate-800 dark:text-white shadow-sm'
              : 'text-slate-500 dark:text-gray-400 hover:text-slate-700 dark:hover:text-gray-200'
          ]"
        >
          <BookOpen :size="14" />
          <span>百科</span>
        </button>
        <button
          v-if="showDevEval"
          @click="router.push('/eval')"
          @mouseenter="prefetchRoute('/eval')"
          :class="[
            'flex-1 h-8 rounded-md text-xs font-medium inline-flex items-center justify-center gap-1.5 transition-colors',
            currentPath === '/eval'
              ? 'bg-white dark:bg-gray-700 text-slate-800 dark:text-white shadow-sm'
              : 'text-slate-500 dark:text-gray-400 hover:text-slate-700 dark:hover:text-gray-200'
          ]"
        >
          <BarChart3 :size="14" />
          <span>评测</span>
        </button>
        </div>
    </div>

    <div v-if="authStore.isAdmin" class="px-3 mb-2">
      <button
        @click="router.push('/dashboard')"
        @mouseenter="prefetchRoute('/dashboard')"
        :class="[
          'w-full h-10 rounded-xl inline-flex items-center justify-between px-3 text-xs font-bold transition-all border',
          currentPath === '/dashboard'
            ? 'bg-slate-900 text-white border-slate-800 shadow-lg shadow-slate-900/20 dark:bg-cyan-500 dark:text-slate-950 dark:border-cyan-400'
            : 'bg-white/70 dark:bg-gray-800/60 text-slate-600 dark:text-gray-300 border-slate-200 dark:border-gray-700 hover:border-cyan-200 hover:bg-cyan-50 hover:text-cyan-700 dark:hover:bg-cyan-900/20'
        ]"
      >
        <span class="inline-flex items-center gap-2">
          <Activity :size="15" />
          运营驾驶舱
        </span>
      </button>
    </div>

    <div v-if="authStore.isAdmin" class="px-3 mb-3">
      <button
        @click="router.push('/feedback')"
        @mouseenter="prefetchRoute('/feedback')"
        :class="[
          'w-full h-10 rounded-xl inline-flex items-center justify-between px-3 text-xs font-bold transition-all border',
          currentPath === '/feedback'
            ? 'bg-wut-600 text-white border-wut-500 shadow-lg shadow-wut-500/20'
            : 'bg-white/70 dark:bg-gray-800/60 text-slate-600 dark:text-gray-300 border-slate-200 dark:border-gray-700 hover:border-wut-200 hover:bg-wut-50 hover:text-wut-700 dark:hover:bg-wut-900/20'
        ]"
      >
        <span class="inline-flex items-center gap-2">
          <MessagesSquare :size="15" />
          反馈收集
        </span>
      </button>
    </div>

    <section class="flex-1 min-h-0 pb-2">
      <FavoritesPanel />
      <ConversationList />
    </section>

    <!-- 底部用户信息 + 退出 -->
    <div class="shrink-0 px-3 py-3 border-t border-slate-200 dark:border-gray-800 relative">
      <div class="flex items-center gap-3">
        <button data-profile-trigger @click="showProfilePanel = !showProfilePanel" class="flex items-center gap-3 flex-1 min-w-0 text-left">
          <div class="w-8 h-8 rounded-full bg-wut-600 flex items-center justify-center text-white text-xs font-bold shrink-0 overflow-hidden">
            <img v-if="authStore.user?.avatar && !avatarFailed" :src="authStore.user.avatar" alt="头像" class="w-full h-full object-cover" @error="avatarFailed = true" />
            <span v-else>{{ (authStore.user?.name || '?')[0] }}</span>
          </div>
          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-1.5">
              <span class="text-sm font-medium text-slate-700 dark:text-gray-200 truncate">{{ authStore.user?.name || '用户' }}</span>
              <span v-if="authStore.isAdmin" class="shrink-0 text-[10px] font-bold px-1.5 py-0.5 rounded-md bg-wut-100 dark:bg-wut-900/40 text-wut-600 dark:text-wut-400 border border-wut-200 dark:border-wut-800/50">Admin</span>
            </div>
          </div>
          <ChevronUp :size="14" class="text-slate-400 dark:text-gray-500 shrink-0 transition-transform" :class="showProfilePanel ? 'rotate-0' : 'rotate-180'" />
        </button>
        <button
          @click="themeStore.toggleDarkMode()"
          class="p-1.5 rounded-lg text-slate-400 dark:text-gray-500 hover:text-wut-600 dark:hover:text-wut-300 hover:bg-wut-50 dark:hover:bg-wut-900/20 transition-colors"
          :title="themeStore.darkMode ? '切换到浅色模式' : '切换到深色模式'"
        >
          <Sun v-if="themeStore.darkMode" :size="16" />
          <Moon v-else :size="16" />
        </button>
        <button
          @click="handleLogout"
          class="p-1.5 rounded-lg text-slate-400 dark:text-gray-500 hover:text-red-600 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
          title="退出登录"
        >
          <LogOut :size="16" />
        </button>
      </div>

      <div v-if="showProfilePanel" class="absolute bottom-full left-3 right-3 mb-2 z-30">
        <ProfilePanel :show="true" @close="showProfilePanel = false" />
      </div>
    </div>
  </div>
</template>
