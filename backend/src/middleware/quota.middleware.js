"use strict";

const quotaService = require("../services/auth/quota.service");
const { logEvent } = require('../services/observability/observability.service');

/**
 * 用户级配额中间件
 * 在请求处理前原子预占配额，超限时返回 429。
 * 对明确失败的非 2xx 响应回滚预占，避免并发请求突破日限额。
 */
async function quotaMiddleware(req, res, next) {
  // 管理员账号无配额限制（authMiddleware 已注入 req.role）
  if (req.role === 'admin') {
    return next();
  }

  // 仅对需要消耗 LLM 配额的路由启用
  // 在白名单中的路径跳过配额检查
  const skipPaths = [
    "/api/health",
    "/api/auth/login", "/api/auth/register", "/api/auth/logout", "/api/auth/me",
    "/api/metrics",
    "/api/rag/stats", "/api/rag/documents",
  ];
  // API 列表页本身精确跳过；但注意 "/api" 不能作为前缀匹配，
  // 否则 /api/chat、/api/stream 等消耗 LLM 的接口也会被误跳过（配额失效）
  if (req.path === "/api") return next();
  if (skipPaths.some(p => req.path === p || req.path.startsWith(p + "/"))) {
    return next();
  }

  // SPA 首页和静态资源跳过（不消耗 LLM 配额）
  if (req.path === "/") return next();
  if (req.path.startsWith("/assets/")) return next();
  if (req.path.startsWith("/uploads/")) return next();

  try {
    const result = await quotaService.reserve(req.userId);
    if (!result.ok) {
      return res.status(429).json({
        success: false,
        error: "今日配额已用完，请明天再试",
        quota: result.usage,
      });
    }

    let settled = false;
    const releaseReservation = () => {
      quotaService.release(req.userId).catch((err) => {
        logEvent('error', 'quota_rollback_failed', { error: err.message });
      });
    };
    const onFinish = () => {
      if (settled) return;
      settled = true;
      res.removeListener("close", onClose);
      if (res.statusCode >= 200 && res.statusCode < 300) return;
      releaseReservation();
    };
    const onClose = () => {
      if (settled) return;
      settled = true;
      res.removeListener("finish", onFinish);
      releaseReservation();
    };

    res.once("finish", onFinish);
    res.once("close", onClose);

    next();
  } catch (err) {
    logEvent('error', 'quota_reserve_failed', { error: err.message });
    next(); // 配额系统故障时不阻塞请求
  }
}

module.exports = { quotaMiddleware };
