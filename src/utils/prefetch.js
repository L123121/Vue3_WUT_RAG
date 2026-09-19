/**
 * 路由预取工具 — 提前加载路由 chunk，加速页面切换
 *
 * 使用方式:
 *   import { prefetchRoute, prefetchAll } from '../utils/prefetch.js';
 *
 *   // 悬停时预取单个路由
 *   @mouseenter="prefetchRoute('/chat')"
 *
 *   // 登录后预取全部路由
 *   prefetchAll();
 */

// 路由路径 → 动态 import 映射（与 router/index.js 保持一致）
const routeImports = {
  '/chat': () => import('../views/AIChat.vue'),
  '/knowledge': () => import('../views/KnowledgeBase.vue'),
  '/wiki': () => import('../views/WikiBrowse.vue'),
  '/eval': () => import('../views/EvalScoring.vue'),
  '/feedback': () => import('../views/RagFeedback.vue'),
};

/**
 * 预取单个路由的 chunk
 * 调用 import() 让 Vite 在后台加载对应模块，浏览器会缓存该 chunk
 * @param {string} path — 路由路径，如 '/chat', '/knowledge'
 */
export function prefetchRoute(path) {
  const loader = routeImports[path];
  if (loader) {
    loader().catch(() => {
      // 预取失败不报错，不影响用户体验
    });
  }
}

/**
 * 预取所有路由 chunk（首次加载空闲时调用）
 * @returns {Promise<Array>}
 */
export function prefetchAll() {
  return Promise.allSettled(
    Object.values(routeImports).map((loader) => loader())
  );
}
