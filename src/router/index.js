import { createRouter, createWebHistory } from 'vue-router';
import { useAuthStore } from '../stores/auth.store.js';
import { clearChunkRecoveryMarker, recoverFromChunkLoadError } from '../utils/chunkRecovery.js';

const routes = [
  {
    path: '/',
    redirect: '/chat'
  },
  {
    path: '/login',
    name: 'Login',
    component: () => import('../views/Login.vue')
  },
  {
    path: '/chat',
    name: 'Chat',
    component: () => import('../views/AIChat.vue'),
    meta: { requiresAuth: true }
  },
  {
    path: '/knowledge',
    name: 'Knowledge',
    component: () => import('../views/KnowledgeBase.vue'),
    meta: { requiresAuth: true }
  },
  {
    path: '/wiki',
    name: 'Wiki',
    component: () => import('../views/WikiBrowse.vue'),
    meta: { requiresAuth: true }
  },
  {
    path: '/wiki/:idOrSlug',
    name: 'WikiEntry',
    component: () => import('../views/WikiEntry.vue'),
    meta: { requiresAuth: true }
  },
  {
    path: '/eval',
    name: 'Eval',
    component: () => import('../views/EvalScoring.vue'),
    meta: { requiresAuth: true }
  },
  {
    path: '/feedback',
    name: 'Feedback',
    component: () => import('../views/RagFeedback.vue'),
    meta: { requiresAuth: true, requiresAdmin: true }
  },  {
    path: '/dashboard',
    name: 'OperationsDashboard',
    component: () => import('../views/OperationsDashboard.vue'),
    meta: { requiresAuth: true, requiresAdmin: true }
  },
  {
    path: '/share/:code',
    name: 'SharedConversation',
    component: () => import('../views/SharedConversation.vue'),
    // 公开只读分享页：无需登录，也不显示侧边栏
    meta: { publicShare: true }
  },
  {
    path: '/:pathMatch(.*)*',
    redirect: '/chat'
  },
];

const router = createRouter({
  history: createWebHistory(),
  routes,
});

router.beforeEach(async (to, from, next) => {
  const authStore = useAuthStore();

  if ((to.meta.requiresAuth || to.path === '/login') && !authStore.hasCheckedSession) {
    await authStore.fetchCurrentUser();
  } else if (to.path === '/login' && authStore.isAuthenticated) {
    await authStore.fetchCurrentUser();
  }

  if (to.meta.requiresAuth && !authStore.isAuthenticated) {
    next({ path: '/login', query: { redirect: to.fullPath } });
  } else if (to.meta.requiresAdmin && !authStore.isAdmin) {
    next('/chat');
  } else if (to.path === '/login' && authStore.isAuthenticated) {
    next('/chat');
  } else {
    next();
  }
});

router.onError((error, to) => {
  recoverFromChunkLoadError(error, to);
});

router.afterEach((_, __, failure) => {
  if (!failure) clearChunkRecoveryMarker();
});

export default router;
