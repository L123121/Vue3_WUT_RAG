<script setup>
import { ref, computed } from 'vue';
import { useAuthStore } from '../../stores/auth.store.js';
import { useThemeStore } from '../../stores/theme.store.js';
import { useToastStore } from '../../stores/toast.store.js';
import { validatePasswordPolicy } from '../../utils/passwordPolicy.js';
import { Moon, Sun, Upload, Lock, Loader2 } from 'lucide-vue-next';

defineProps({ show: Boolean });
const emit = defineEmits(['close']);

const authStore = useAuthStore();
const themeStore = useThemeStore();
const toastStore = useToastStore();

const draftAvatar = computed(() => authStore.user?.avatar || '');
const showChangePassword = ref(false);
const changePasswordLoading = ref(false);
const currentPassword = ref('');
const newPassword = ref('');
const confirmPassword = ref('');

const handleAvatarUpload = (event) => {
  const file = event.target.files[0];
  if (!file) return;
  if (!file.type.startsWith('image/')) { toastStore.error('请选择图片文件'); return; }
  if (file.size > 5 * 1024 * 1024) { toastStore.error('图片大小不能超过5MB'); return; }
  const reader = new FileReader();
  reader.onload = (e) => {
    authStore.updateUser({ avatar: e.target.result });
    toastStore.success('头像已更新');
  };
  reader.onerror = () => { toastStore.error('图片读取失败'); };
  reader.readAsDataURL(file);
};

const resetPasswordForm = () => {
  currentPassword.value = '';
  newPassword.value = '';
  confirmPassword.value = '';
  showChangePassword.value = false;
};

const handleChangePassword = async () => {
  if (!currentPassword.value) { toastStore.error('请输入当前密码'); return; }
  const policyError = validatePasswordPolicy(newPassword.value);
  if (policyError) { toastStore.error(`新密码${policyError}`); return; }
  if (newPassword.value !== confirmPassword.value) { toastStore.error('两次密码输入不一致'); return; }

  changePasswordLoading.value = true;
  try {
    await authStore.changePassword(currentPassword.value, newPassword.value);
    toastStore.success('密码修改成功');
    resetPasswordForm();
  } catch (err) {
    toastStore.error(err.message || '密码修改失败');
  } finally {
    changePasswordLoading.value = false;
  }
};
</script>

<template>
  <div
    v-if="show"
    class="profile-panel w-full rounded-xl border border-slate-200 dark:border-gray-700 bg-white/95 dark:bg-gray-900/95 backdrop-blur-sm shadow-xl p-4 overflow-y-auto"
    style="max-height: 400px"
  >
    <div class="flex items-center justify-between mb-3">
      <h3 class="text-sm font-bold text-slate-800 dark:text-gray-100">个人中心</h3>
      <button @click="emit('close')" class="text-xs text-slate-400 hover:text-slate-600 dark:hover:text-gray-200">关闭</button>
    </div>

    <div class="flex items-center gap-4 p-3 rounded-lg bg-slate-50 dark:bg-gray-800/60 border border-slate-200 dark:border-gray-700 mb-3">
      <div class="w-16 h-16 rounded-full overflow-hidden flex items-center justify-center text-white text-xl font-bold shrink-0">
        <template v-if="draftAvatar">
          <img :src="draftAvatar" alt="头像" class="w-full h-full object-cover bg-white" @error="draftAvatar = ''" />
        </template>
        <template v-else>
          <div class="w-full h-full bg-wut-600 flex items-center justify-center">
            {{ authStore.user?.name?.charAt(0)?.toUpperCase() || 'U' }}
          </div>
        </template>
      </div>
      <div class="flex-1 min-w-0">
        <p class="text-sm font-semibold text-slate-800 dark:text-gray-100">{{ authStore.user?.name }}</p>
        <p class="text-xs text-slate-500 dark:text-gray-400 mb-2">更换头像</p>
        <div class="flex gap-2">
          <label class="cursor-pointer h-7 px-2.5 rounded-md text-xs bg-violet-100 dark:bg-violet-900/30 text-violet-700 dark:text-violet-300 hover:bg-violet-200 dark:hover:bg-violet-900/50 transition-colors inline-flex items-center gap-1">
            <input type="file" accept="image/*" class="hidden" @change="handleAvatarUpload" />
            <Upload :size="12" />
            <span>上传图片</span>
          </label>
        </div>
      </div>
    </div>

    <button @click="themeStore.toggleDarkMode()" class="w-full h-9 rounded-lg inline-flex items-center justify-center gap-2 text-sm border border-slate-200 dark:border-gray-700 bg-slate-50 dark:bg-gray-800 text-slate-700 dark:text-gray-200 hover:bg-slate-100 dark:hover:bg-gray-700 transition-colors">
      <Moon v-if="themeStore.darkMode" :size="14" />
      <Sun v-else :size="14" />
      <span>{{ themeStore.darkMode ? '夜间模式' : '日间模式' }}</span>
    </button>

    <div class="mt-3">
      <button v-if="!showChangePassword" @click="showChangePassword = true" class="w-full h-9 rounded-lg inline-flex items-center justify-center gap-2 text-sm border border-slate-200 dark:border-gray-700 bg-slate-50 dark:bg-gray-800 text-slate-700 dark:text-gray-200 hover:bg-slate-100 dark:hover:bg-gray-700 transition-colors">
        <Lock :size="14" />
        <span>修改密码</span>
      </button>

      <div v-else class="space-y-2 p-3 rounded-lg bg-slate-50 dark:bg-gray-800/60 border border-slate-200 dark:border-gray-700">
        <input v-model="currentPassword" type="password" class="block w-full h-8 rounded-md border border-slate-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-2.5 text-xs text-slate-900 dark:text-gray-100 placeholder-slate-400 outline-none focus:border-wut-500" placeholder="当前密码" />
        <input v-model="newPassword" type="password" class="block w-full h-8 rounded-md border border-slate-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-2.5 text-xs text-slate-900 dark:text-gray-100 placeholder-slate-400 outline-none focus:border-wut-500" placeholder="新密码（8 位以上，含字母和数字）" />
        <input v-model="confirmPassword" type="password" class="block w-full h-8 rounded-md border border-slate-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-2.5 text-xs text-slate-900 dark:text-gray-100 placeholder-slate-400 outline-none focus:border-wut-500" placeholder="确认新密码" />
        <div class="flex gap-2">
          <button @click="handleChangePassword" :disabled="changePasswordLoading" class="flex-1 h-7 rounded-md text-xs font-medium bg-wut-600 text-white hover:bg-wut-700 transition-colors disabled:opacity-50 inline-flex items-center justify-center gap-1">
            <Loader2 v-if="changePasswordLoading" class="h-3 w-3 animate-spin" />
            <span>{{ changePasswordLoading ? '修改中...' : '确认' }}</span>
          </button>
          <button @click="resetPasswordForm" class="h-7 px-3 rounded-md text-xs border border-slate-200 dark:border-gray-700 text-slate-600 dark:text-gray-300 hover:bg-slate-100 dark:hover:bg-gray-700 transition-colors">取消</button>
        </div>
      </div>
    </div>
  </div>
</template>
