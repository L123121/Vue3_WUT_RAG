<template>
  <div class="login-shell relative min-h-screen overflow-hidden bg-slate-950 text-slate-900 dark:text-white">
    <div class="campus-grid absolute inset-0 opacity-70"></div>
    <div class="absolute -left-24 top-10 h-80 w-80 rounded-full bg-wut-500/30 blur-3xl"></div>
    <div class="absolute bottom-0 right-0 h-[30rem] w-[30rem] rounded-full bg-cyan-300/20 blur-3xl"></div>
    <div class="absolute left-1/2 top-1/2 h-96 w-96 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white/10"></div>

    <button
      type="button"
      class="absolute right-5 top-5 z-20 inline-flex h-10 w-10 items-center justify-center rounded-2xl border border-white/15 bg-white/10 text-white shadow-lg shadow-black/10 backdrop-blur transition hover:-translate-y-0.5 hover:bg-white/15 focus:outline-none focus:ring-2 focus:ring-cyan-200/60"
      :aria-label="themeStore.darkMode ? '切换到浅色模式' : '切换到深色模式'"
      @click="themeStore.toggleDarkMode"
    >
      <Sun v-if="themeStore.darkMode" :size="18" />
      <Moon v-else :size="18" />
    </button>

    <main class="relative z-10 mx-auto grid min-h-screen w-full max-w-6xl items-center gap-8 px-4 py-10 lg:grid-cols-[1.05fr_0.95fr] lg:px-8">
      <section class="brand-card hidden lg:block">
        <div class="relative overflow-hidden rounded-[2rem] border border-white/15 bg-white/[0.08] p-8 text-white shadow-2xl shadow-wut-950/30 backdrop-blur-2xl">
          <div class="absolute -right-16 -top-16 h-44 w-44 rounded-full bg-cyan-300/20 blur-2xl"></div>
          <div class="absolute bottom-10 right-10 h-24 w-24 rounded-full border border-white/15"></div>

          <div class="inline-flex items-center gap-2 rounded-full border border-cyan-200/30 bg-cyan-100/10 px-4 py-2 text-sm text-cyan-50">
            <Sparkles :size="16" />
            WUT AI Campus Copilot
          </div>

          <div class="mt-16 max-w-xl">
            <p class="mb-5 text-sm font-semibold uppercase tracking-[0.45em] text-cyan-100/80">武汉理工大学</p>
            <h1 class="text-6xl font-black leading-[0.96] tracking-tight">
              登录后，让校园信息主动找到你。
            </h1>
            <p class="mt-6 max-w-lg text-base leading-8 text-wut-50/80">
              注册账号即可使用 AI 助手、知识库和校园信息查询服务。
            </p>
          </div>

          <div class="mt-14 grid grid-cols-3 gap-3">
            <div v-for="item in featureCards" :key="item.title" class="rounded-3xl border border-white/10 bg-white/10 p-4 backdrop-blur">
              <component :is="item.icon" class="mb-4 h-5 w-5 text-cyan-200" />
              <p class="text-sm font-bold">{{ item.title }}</p>
              <p class="mt-1 text-xs leading-5 text-wut-50/65">{{ item.desc }}</p>
            </div>
          </div>
        </div>
      </section>

      <section class="login-card mx-auto w-full max-w-md">
        <div class="rounded-[2rem] border border-white/60 bg-white/88 shadow-2xl shadow-wut-950/25 backdrop-blur-2xl dark:border-white/10 dark:bg-slate-900/82">
          <div class="px-6 pt-7 sm:px-8">
            <div class="flex items-start justify-between gap-4">
              <div>
                <div class="inline-flex items-center gap-2 rounded-full bg-wut-50 px-3 py-1 text-xs font-bold text-wut-700 dark:bg-wut-500/10 dark:text-wut-200">
                  <ShieldCheck :size="14" />
                  安全登录
                </div>
                <h2 class="mt-5 text-3xl font-black tracking-tight text-slate-950 dark:text-white">武理小精灵</h2>
                <p class="mt-2 text-sm leading-6 text-slate-500 dark:text-slate-400">{{ modeConfig.subtitle }}</p>
              </div>

              <div class="relative h-20 w-20 shrink-0">
                <div class="absolute inset-0 rounded-3xl bg-wut-600/25 blur-xl"></div>
                <div class="relative flex h-20 w-20 items-center justify-center overflow-hidden rounded-3xl border border-white/80 bg-white shadow-lg dark:border-white/10 dark:bg-slate-800">
                  <img :src="logoUrl" alt="武汉理工大学标识" class="h-full w-full object-cover scale-125" />
                </div>
              </div>
            </div>

            </div>

          <form id="login-form" class="space-y-5 px-6 py-7 sm:px-8" novalidate @submit.prevent="handleSubmit">
            <div class="space-y-4">
              <label class="block">
                <span class="mb-2 ml-1 block text-xs font-black uppercase tracking-[0.18em] text-slate-500 dark:text-slate-400">用户名</span>
                <span class="relative block">
                  <User class="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-slate-400 transition group-focus-within:text-wut-700" />
                  <input
                    id="account-username"
                    v-model.trim="accountUsername"
                    type="text"
                    autocomplete="username"
                    :disabled="loading"
                    :aria-invalid="Boolean(accountUsernameError)"
                    class="peer block w-full rounded-2xl border bg-white/80 py-4 pl-12 pr-4 text-slate-950 shadow-sm outline-none transition placeholder:text-slate-400 focus:border-wut-600 focus:bg-white focus:ring-4 focus:ring-blue-600/10 disabled:cursor-not-allowed disabled:opacity-70 dark:bg-slate-800/70 dark:text-white dark:focus:bg-slate-800"
                    :class="accountUsernameError ? 'border-red-300 dark:border-red-500/70' : 'border-slate-200 dark:border-slate-700'"
                    placeholder="3-32 位字母、数字或下划线"
                    @input="clearError"
                  />
                </span>
                <span v-if="accountUsernameError" class="mt-2 block text-xs text-red-500">{{ accountUsernameError }}</span>
              </label>

              <label class="block">
                <span class="mb-2 ml-1 block text-xs font-black uppercase tracking-[0.18em] text-slate-500 dark:text-slate-400">{{ accountMode === 'register' ? '设置密码' : '密码' }}</span>
                <span class="relative block">
                  <Lock class="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-slate-400 transition group-focus-within:text-wut-700" />
                  <input
                    id="account-password"
                    v-model="accountPassword"
                    :type="showPassword ? 'text' : 'password'"
                    autocomplete="current-password"
                    :disabled="loading"
                    :aria-invalid="Boolean(accountPasswordError)"
                    class="block w-full rounded-2xl border bg-white/80 py-4 pl-12 pr-12 text-slate-950 shadow-sm outline-none transition placeholder:text-slate-400 focus:border-wut-600 focus:bg-white focus:ring-4 focus:ring-blue-600/10 disabled:cursor-not-allowed disabled:opacity-70 dark:bg-slate-800/70 dark:text-white dark:focus:bg-slate-800"
                    :class="accountPasswordError ? 'border-red-300 dark:border-red-500/70' : 'border-slate-200 dark:border-slate-700'"
                    placeholder="8-128 位，需包含字母和数字"
                    @input="clearError"
                  />
                  <button
                    type="button"
                    :disabled="loading"
                    class="absolute right-4 top-1/2 -translate-y-1/2 text-slate-400 transition hover:text-wut-700 disabled:cursor-not-allowed dark:hover:text-wut-300"
                    :aria-label="showPassword ? '隐藏密码' : '显示密码'"
                    @click="showPassword = !showPassword"
                  >
                    <EyeOff v-if="showPassword" class="h-5 w-5" />
                    <Eye v-else class="h-5 w-5" />
                  </button>
                </span>
                <span v-if="accountPasswordError" class="mt-2 block text-xs text-red-500">{{ accountPasswordError }}</span>
              </label>

              <label :class="['block', accountMode !== 'register' ? 'invisible pointer-events-none' : '']">
                <span class="mb-2 ml-1 block text-xs font-black uppercase tracking-[0.18em] text-slate-500 dark:text-slate-400">确认密码</span>
                <span class="relative block">
                  <Lock class="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-slate-400 transition group-focus-within:text-wut-700" />
                  <input
                    id="account-confirm-password"
                    v-model="accountConfirmPassword"
                    :type="showPassword ? 'text' : 'password'"
                    autocomplete="new-password"
                    :disabled="loading"
                    :tabindex="accountMode !== 'register' ? -1 : 0"
                    :aria-invalid="Boolean(accountConfirmPasswordError)"
                    class="block w-full rounded-2xl border bg-white/80 py-4 pl-12 pr-12 text-slate-950 shadow-sm outline-none transition placeholder:text-slate-400 focus:border-wut-600 focus:bg-white focus:ring-4 focus:ring-blue-600/10 disabled:cursor-not-allowed disabled:opacity-70 dark:bg-slate-800/70 dark:text-white dark:focus:bg-slate-800"
                    :class="accountConfirmPasswordError ? 'border-red-300 dark:border-red-500/70' : 'border-slate-200 dark:border-slate-700'"
                    placeholder="再次输入密码"
                    @input="clearError"
                  />
                </span>
                <span v-if="accountConfirmPasswordError" class="mt-2 block text-xs text-red-500">{{ accountConfirmPasswordError }}</span>
              </label>

              <label :class="['block', accountMode !== 'register' ? 'invisible pointer-events-none' : '']">
                <span class="mb-2 ml-1 block text-xs font-black uppercase tracking-[0.18em] text-slate-500 dark:text-slate-400">邀请码</span>
                <span class="relative block">
                  <Ticket class="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-slate-400 transition group-focus-within:text-wut-700" />
                  <input
                    id="account-invite-code"
                    v-model.trim="accountInviteCode"
                    type="text"
                    autocomplete="off"
                    :disabled="loading"
                    :tabindex="accountMode !== 'register' ? -1 : 0"
                    class="block w-full rounded-2xl border bg-white/80 py-4 pl-12 pr-4 text-slate-950 shadow-sm outline-none transition placeholder:text-slate-400 focus:border-wut-600 focus:bg-white focus:ring-4 focus:ring-blue-600/10 disabled:cursor-not-allowed disabled:opacity-70 dark:bg-slate-800/70 dark:text-white dark:focus:bg-slate-800"
                    :class="accountInviteCodeError ? 'border-red-300 dark:border-red-500/70' : 'border-slate-200 dark:border-slate-700'"
                    placeholder="站点启用邀请码注册时必填"
                    @input="clearError"
                  />
                </span>
                <span v-if="accountInviteCodeError" class="mt-2 block text-xs text-red-500">{{ accountInviteCodeError }}</span>
              </label>

              <div class="text-center">
                <button
                  type="button"
                  :disabled="loading"
                  class="text-sm text-wut-600 transition hover:text-wut-800 disabled:opacity-50 dark:text-wut-400 dark:hover:text-wut-300"
                  @click="toggleAccountMode"
                >
                  {{ accountMode === 'register' ? '已有账号？立即登录' : '没有账号？立即注册' }}
                </button>
              </div>
            </div>

            <div v-if="loading" class="flex items-start gap-3 rounded-2xl border border-wut-100 bg-wut-50/80 p-4 text-sm text-wut-800 dark:border-wut-500/20 dark:bg-wut-500/10 dark:text-wut-100">
              <Clock3 class="mt-0.5 h-4 w-4 shrink-0" />
              <p>{{ loadingHint }}</p>
            </div>

            <div v-if="error" class="flex items-start gap-3 rounded-2xl border border-red-100 bg-red-50 p-4 text-sm text-red-600 dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-200" role="alert">
              <AlertCircle class="mt-0.5 h-4 w-4 shrink-0" />
              <p>{{ error }}</p>
            </div>

            <button
              id="login-submit-btn"
              type="submit"
              :disabled="loading"
              class="group inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-wut-700 hover:bg-wut-800 px-5 py-4 text-sm font-black text-white shadow-xl shadow-wut-900/25 transition hover:-translate-y-0.5 hover:shadow-2xl hover:shadow-wut-900/30 focus:outline-none focus:ring-4 focus:ring-wut-600/20 active:translate-y-0 disabled:cursor-not-allowed disabled:opacity-70"
            >
              <Loader2 v-if="loading" class="h-4 w-4 animate-spin" />
              <span>{{ loading ? modeConfig.loadingText : modeConfig.buttonText }}</span>
              <ArrowRight v-if="!loading" class="h-4 w-4 transition group-hover:translate-x-1" />
            </button>
          </form>

          <div class="border-t border-slate-100 px-6 py-5 dark:border-slate-800 sm:px-8">
            <p class="text-center text-xs text-slate-400 dark:text-slate-500">
              &copy; {{ currentYear }} 武汉理工大学 WUT
            </p>
          </div>
        </div>
      </section>
    </main>
  </div>
</template>

<script setup>
import { computed, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  AlertCircle,
  ArrowRight,
  Clock3,
  Eye,
  EyeOff,
  GraduationCap,
  Loader2,
  Lock,
  Moon,
  ShieldCheck,
  Sparkles,
  Sun,
  Ticket,
  User,
} from 'lucide-vue-next';
import logoUrl from '../assets/wuhan-university-logo.png';
import { useAuthStore } from '../stores/auth.store.js';
import { useConversationStore } from '../stores/conversation.store.js';
import { useThemeStore } from '../stores/theme.store.js';
import { validatePasswordPolicy } from '../utils/passwordPolicy.js';
import { prefetchRoute, prefetchAll } from '../utils/prefetch.js';

const ERROR_MESSAGES = {
  INVALID_CREDENTIALS: '账号或密码错误，请重新输入',
  MISSING_CREDENTIALS: '请完整填写账号和密码',
  RATE_LIMIT: '登录尝试过于频繁，请稍后再试',
  NETWORK_ERROR: '网络连接失败，请确认后端服务已启动',
  INVALID_RESPONSE: '登录响应异常，请稍后重试',
};

const MODE_CONFIG = {
  subtitle: '注册账号即可使用 AI 助手、知识库和校园信息查询服务。',
  buttonText: '登录',
  loadingText: '正在验证账号...',
};

const router = useRouter();
const route = useRoute();
const authStore = useAuthStore();
const convStore = useConversationStore();
const themeStore = useThemeStore();

const accountMode = ref('login'); // 'login' | 'register'
const accountUsername = ref('');
const accountPassword = ref('');
const accountConfirmPassword = ref('');
const accountInviteCode = ref('');
const loading = ref(false);
const error = ref('');
const showPassword = ref(false);
const submitted = ref(false);
const currentYear = new Date().getFullYear();

const featureCards = [
  { title: '统一会话', desc: '登录状态由安全 Cookie 维护', icon: ShieldCheck },
  { title: '知识库', desc: '校园文档智能检索与问答', icon: GraduationCap },
  { title: 'AI 助手', desc: '结合知识库回答校园问题', icon: Sparkles },
];
const modeConfig = computed(() => ({
  subtitle: MODE_CONFIG.subtitle,
  buttonText: accountMode.value === 'register' ? '注册并登录' : '登录',
  loadingText: accountMode.value === 'register' ? '正在注册...' : '正在登录...',
}));
const loadingHint = '正在验证账号信息，请稍候。';
const redirectTarget = computed(() => {
  const redirect = Array.isArray(route.query.redirect) ? route.query.redirect[0] : route.query.redirect;
  if (typeof redirect === 'string' && redirect.startsWith('/') && !redirect.startsWith('/login')) {
    return redirect;
  }
  return '/chat';
});

const accountUsernameError = computed(() => {
  if (!submitted.value) return '';
  if (!accountUsername.value.trim()) return '请输入用户名';
  if (accountUsername.value.trim().length < 3) return '用户名至少 3 位';
  return '';
});
const accountPasswordError = computed(() => {
  if (!submitted.value || accountMode.value !== 'register') return '';
  if (!accountPassword.value) return '请输入密码';
  return validatePasswordPolicy(accountPassword.value);
});
const accountConfirmPasswordError = computed(() => {
  if (!submitted.value || accountMode.value !== 'register') return '';
  if (!accountConfirmPassword.value) return '请再次输入密码';
  if (accountPassword.value !== accountConfirmPassword.value) return '两次密码输入不一致';
  return '';
});
const accountInviteCodeError = computed(() => {
  if (!submitted.value || accountMode.value !== 'register') return '';
  // 邀请码是否必填由后端 AUTH_INVITE_CODE 决定，这里仅在报错后提示补填
  return '';
});
const isFormValid = computed(() => (
  accountMode.value === 'register'
    ? Boolean(accountUsername.value.trim() && accountPassword.value && accountConfirmPassword.value)
      && !accountPasswordError.value && !accountConfirmPasswordError.value
    : Boolean(accountUsername.value.trim() && accountPassword.value)
));

const clearError = () => {
  error.value = '';
};

const toggleAccountMode = () => {
  accountMode.value = accountMode.value === 'register' ? 'login' : 'register';
  submitted.value = false;
  error.value = '';
  showPassword.value = false;
};

const formatLoginError = (loginError) => {
  if (loginError?.code === 'INVALID_CREDENTIALS') {
    return '用户名或密码错误';
  }
  if (loginError?.code === 'USERNAME_EXISTS') {
    return '用户名已存在，请换一个';
  }
  if (loginError?.code === 'INVALID_INVITE_CODE') {
    return '邀请码无效，请核对后重新输入';
  }
  return ERROR_MESSAGES[loginError?.code] || loginError?.message || '登录失败，请稍后重试';
};

async function handleSubmit() {
  if (loading.value) return;

  submitted.value = true;
  error.value = '';

  if (!isFormValid.value) {
    error.value = accountMode.value === 'register' ? '请完整填写注册信息' : '请输入用户名和密码';
    return;
  }

  loading.value = true;

  try {
    if (accountMode.value === 'register') {
      await authStore.register(accountUsername.value, accountPassword.value, accountInviteCode.value);
    } else {
      await authStore.login(accountUsername.value, accountPassword.value);
    }

    convStore.resetConversationState();
    prefetchRoute(redirectTarget.value);
    prefetchAll();
    await router.replace(redirectTarget.value);
  } catch (loginError) {
    console.error('[Login] failed:', loginError);
    error.value = formatLoginError(loginError);
  } finally {
    loading.value = false;
  }
}
</script>

<style scoped>
.login-shell {
  background:
    radial-gradient(circle at 10% 10%, rgba(14, 165, 233, 0.26), transparent 34rem),
    radial-gradient(circle at 90% 90%, rgba(37, 99, 235, 0.24), transparent 30rem),
    linear-gradient(135deg, #061b46 0%, #0f285e 42%, #07111f 100%);
}

.campus-grid {
  background-image:
    linear-gradient(rgba(255, 255, 255, 0.08) 1px, transparent 1px),
    linear-gradient(90deg, rgba(255, 255, 255, 0.08) 1px, transparent 1px);
  background-size: 42px 42px;
  mask-image: linear-gradient(to bottom, rgba(0, 0, 0, 0.9), transparent 88%);
}
</style>
