/**
 * 中间件注册 — 从 app.js 拆分
 */
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const { createTraceId, logEvent, sanitizeTraceId } = require('../services/observability/observability.service');
const { operationalMetrics } = require('../services/observability/operational-metrics.service');
const { withHttpRootSpan } = require('../services/observability/otel-tracing.service');

function applyMiddleware(app) {
  const isProduction = process.env.NODE_ENV === 'production';

  app.use((req, res, next) => {
    // HTTP 根 span：OTel 启用时包住整个请求（fn 内异步链共享 span 上下文），
    // 关闭时直通；traceId 优先上游头，否则在 OTel 启用时采用 OTel traceId（两边同源）
    // 注意 withHttpRootSpan 关闭时按契约回传 null，解构默认值对 null 不生效
    withHttpRootSpan(req, res, (spanInfo) => {
      const otelTraceId = spanInfo && spanInfo.otelTraceId;
      const incomingTraceId = req.get('x-trace-id') || req.get('x-request-id');
      const traceId = sanitizeTraceId(incomingTraceId) || otelTraceId || createTraceId('req');
      req.traceId = traceId;
      res.locals.traceId = traceId;
      res.setHeader('X-Trace-Id', traceId);

      const startedAt = Date.now();
      res.on('finish', () => {
        const durationMs = Date.now() - startedAt;
        const requestPath = req.path || String(req.originalUrl || '').split('?')[0];
        operationalMetrics.recordRequest({ method: req.method, path: requestPath, statusCode: res.statusCode, durationMs, traceId });
        if (process.env.HTTP_TRACE_LOGS === 'false') return;
        logEvent('info', 'http_request', {
          traceId,
          method: req.method,
          path: requestPath,
          statusCode: res.statusCode,
          durationMs,
          userId: req.userId || null,
        });
      });

      next();
    });
  });

  // CORS — 允许前端跨域 + cookie
  // 生产环境必须显式配置 CORS_ORIGIN 白名单，缺失时 fail-fast 而非回退到 origin:true，
  // 否则任意第三方站点可携带 httpOnly cookie 发起跨域请求（CSRF 式凭证泄露）
  let corsOrigin;
  if (isProduction) {
    const origin = process.env.CORS_ORIGIN;
    if (!origin) {
      logEvent('error', 'cors_origin_missing', { message: '生产环境未配置 CORS_ORIGIN，拒绝启动。请在环境变量中设置允许的前端域名。' });
      process.exit(1);
    }
    corsOrigin = origin.split(',').map(s => s.trim()).filter(Boolean);
  } else {
    corsOrigin = ['http://localhost:5173', 'http://127.0.0.1:5173'];
  }
  app.use(cors({
    origin: corsOrigin,
    credentials: true,
  }));

  // Cookie 解析（JWT httpOnly cookie 必需）
  app.use(cookieParser());

  // 安全头 + CSP
  // 注意：CSP 在 nginx 层面配置，此处禁用 helmet 的 CSP 以避免冲突
  // HTTP 模式下禁用 Cross-Origin-Opener-Policy，避免浏览器警告
  app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginOpenerPolicy: false,
  }));

  morgan.token('traceId', req => req.traceId || '-');
  const logFormat = isProduction
    ? ':remote-addr - :remote-user [:date[clf]] ":method :url HTTP/:http-version" :status :res[content-length] ":referrer" ":user-agent" traceId=:traceId'
    : ':method :url :status :response-time ms traceId=:traceId';
  app.use(morgan(logFormat));

  // 请求体解析
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true }));

  // JWT 鉴权中间件（从 cookie 读取 token）
  const { authMiddleware } = require('../middleware/auth.middleware');
  app.use(authMiddleware);

  // 用户级配额中间件
  const { quotaMiddleware } = require('../middleware/quota.middleware');
  app.use(quotaMiddleware);

  // 聊天接口速率限制
  const chatLimiter = rateLimit({
    windowMs: 1 * 60 * 1000,
    max: 60,
    message: { success: false, error: '请求过于频繁，请稍后再试' },
    standardHeaders: true,
    legacyHeaders: false,
  });

  return chatLimiter;
}

module.exports = { applyMiddleware };
