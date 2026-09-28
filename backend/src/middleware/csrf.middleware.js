"use strict";

const { logEvent } = require('../services/observability/observability.service');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * 跨站请求伪造防护 —— 基于 Origin/Referer 同源校验
 *
 * 背景：本服务用 httpOnly cookie 承载 JWT，且 CORS 开启 credentials:true。
 * 仅靠 cookie 的 SameSite=Lax 不足以覆盖所有场景（Lax 允许顶级导航发起的
 * GET，且旧浏览器/部分客户端行为不一致）。这里在服务端再校验一次来源：
 * 所有非安全方法的请求，Origin 必须落在允许的前端域名白名单内。
 *
 * 为什么用 Origin/Referer 而不是 CSRF token：
 * - 前端是同域部署（默认 API_BASE=/api）或已知白名单域名，无第三方回调场景；
 * - 引入 token 需要前端全量改造 + 接口暴露 token 端点，成本高且易漏配；
 * - Origin 头由浏览器强制附加、JS 不可改写，对主流浏览器防护强度足够。
 * 若未来需要支持第三方站点回调，再改为 double-submit token 方案。
 *
 * 豁免规则：
 * - 安全方法（GET/HEAD/OPTIONS）不校验；
 * - Origin 与 Referer 都缺失时放行 —— 合规客户端（curl/服务端调用/旧浏览器）
 *   可能不发这两个头，而浏览器发起的跨站请求一定带 Origin；缺失场景按
 *   "非浏览器来源"处理，风险由接口自身的鉴权（requireAuth）承担。
 */
function normalizeOrigins(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}

function createCsrfMiddleware({ allowedOrigins = [] } = {}) {
  const allowList = new Set(normalizeOrigins(allowedOrigins).map((origin) => origin.toLowerCase()));

  const isAllowed = (origin) => {
    if (!origin) return false;
    const normalized = String(origin).trim().replace(/\/+$/, '').toLowerCase();
    if (allowList.has(normalized)) return true;
    // 兼容 CORS_ORIGIN 里配置了通配子域的情况（*.example.com）
    for (const allowed of allowList) {
      if (!allowed.startsWith('*.')) continue;
      const suffix = allowed.slice(1); // ".example.com"
      if (normalized.endsWith(suffix)) return true;
    }
    return false;
  };

  return function csrfGuard(req, res, next) {
    if (SAFE_METHODS.has(req.method)) return next();
    // 未配置白名单时不生效（生产环境 CORS_ORIGIN 缺失会在启动阶段 fail-fast，
    // 这里只兜住测试/本地直连等未配置的场景，保持与改动前一致的行为）
    if (allowList.size === 0) return next();

    const origin = req.get('origin');
    const referer = req.get('referer');
    if (!origin && !referer) return next();

    // Origin 缺失时回退 Referer：取协议+host 部分再比对
    const candidate = origin || (() => {
      try {
        const url = new URL(referer);
        return url.origin;
      } catch {
        return '';
      }
    })();

    if (isAllowed(candidate)) return next();

    logEvent('warn', 'csrf_origin_rejected', {
      path: req.path,
      method: req.method,
      origin: origin || null,
      refererHost: referer ? String(referer).slice(0, 200) : null,
      traceId: req.traceId || null,
    });
    return res.status(403).json({
      success: false,
      error: '跨站请求被拒绝（来源不在允许列表内）',
      code: 'CSRF_ORIGIN_REJECTED',
    });
  };
}

module.exports = { createCsrfMiddleware, SAFE_METHODS };
