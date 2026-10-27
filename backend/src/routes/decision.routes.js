'use strict';

/**
 * JEV 结构化决策直连接口。
 *
 *   GET  /api/decision/status   —— 模型可用性（不含密钥），用于运维与前端降级提示
 *   POST /api/decision          —— 一次结构化决策（state + questions），与官方 /v1/decision 对齐
 *
 * 设计取舍：
 *   - 这里只做鉴权、限流、参数透传与错误码映射，校验与协议解析全部在
 *     jev-decision.service（单测覆盖在 service 层，路由层只测映射）。
 *   - 模型未放量（403 MODEL_ACCESS_DENIED）时返回 503 + Retry-After，
 *     不把上游错误原样抛给前端，也避免把内部 Key/端点暴露到响应里。
 */

const { Router } = require('express');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');

const { requireAuth } = require('../middleware/auth.middleware');
const { JevDecisionError } = require('../services/agent/jev-decision.service');
const { logEvent } = require('../services/observability/observability.service');

const STATUS_BY_CODE = Object.freeze({
  JEV_INVALID_REQUEST: 400,
  JEV_ABORTED: 499,
  JEV_TIMEOUT: 504,
  JEV_DISABLED: 503,
  JEV_UNAVAILABLE: 503,
  JEV_MODEL_ACCESS_DENIED: 503,
  JEV_UNAUTHORIZED: 502,
  JEV_FORBIDDEN: 502,
  JEV_LOW_CONFIDENCE: 502,
  JEV_INVALID_RESPONSE: 502,
  JEV_INVALID_ROUTE: 502,
  JEV_API_ERROR: 502,
  JEV_NETWORK_ERROR: 502,
});

const FRIENDLY_MESSAGE = Object.freeze({
  JEV_DISABLED: '决策模型未启用（缺少 JEV_API_KEY 或未开启）',
  JEV_UNAVAILABLE: '决策模型暂不可用（当前账号未在灰度名单内），请稍后再试',
  JEV_MODEL_ACCESS_DENIED: '决策模型暂不可用（当前账号未在灰度名单内），请稍后再试',
  JEV_UNAUTHORIZED: '决策模型鉴权失败，请检查平台 API Key',
  JEV_TIMEOUT: '决策模型响应超时，请稍后重试',
});

function statusForError(error) {
  if (Number.isInteger(error?.httpStatus) && error.httpStatus >= 400) return error.httpStatus;
  return STATUS_BY_CODE[error?.code] || 502;
}

/** handler 与 router 分离，便于单测直接注入 fake service */
function createDecisionHandler(service) {
  if (!service || typeof service.decide !== 'function') {
    throw new Error('createDecisionHandler 需要传入决策服务实例');
  }

  return async function decisionHandler(req, res) {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const controller = new AbortController();
    // 客户端断开时中止上游请求，避免继续占用配额
    const onClose = () => controller.abort();
    req.once('close', onClose);

    try {
      const result = await service.decide({
        state: body.state,
        questions: body.questions,
        signal: controller.signal,
        traceId: res.locals?.traceId || req.traceId || null,
      });
      if (res.headersSent) return;
      return res.json({ success: true, data: result });
    } catch (error) {
      if (res.headersSent || res.writableEnded) return;

      const status = statusForError(error);
      const code = error?.code || 'JEV_DECISION_FAILED';
      if (status === 499) return res.status(499).end();

      const retryAfterMs = Number(error?.retryAfterMs);
      if (status === 503) {
        res.setHeader('Retry-After', String(Math.max(1, Math.ceil((Number.isFinite(retryAfterMs) ? retryAfterMs : 60000) / 1000))));
      }

      logEvent('warn', 'decision_api_failed', {
        code,
        status,
        error: error?.message,
        traceId: res.locals?.traceId || null,
      });

      // 400 是本服务自己的入参校验，直接把原因告诉调用方；其它错误不泄露上游细节
      const message = FRIENDLY_MESSAGE[code]
        || (status === 400 ? (error?.message || '决策请求参数不合法') : '决策请求失败');

      return res.status(status).json({
        success: false,
        code,
        error: message,
        ...(error?.upstreamMessage ? { upstreamMessage: error.upstreamMessage } : {}),
        ...(Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? { retryAfterMs } : {}),
        ...(res.locals?.traceId ? { traceId: res.locals.traceId } : {}),
      });
    } finally {
      req.removeListener('close', onClose);
    }
  };
}

function createDecisionRouter(service) {
  const router = Router();

  // 决策调用虽轻量，仍是上游计费请求：按用户维度单独限流，避免被脚本刷穿
  const decisionLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    message: { success: false, code: 'RATE_LIMIT', error: '决策请求过于频繁，请稍后再试' },
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => req.userId || ipKeyGenerator(req.ip),
  });

  router.use(requireAuth);

  router.get('/status', (req, res) => {
    const availability = typeof service.getAvailability === 'function'
      ? service.getAvailability()
      : { available: false, status: 'unknown' };
    res.json({ success: true, data: availability });
  });

  router.post('/', decisionLimiter, createDecisionHandler(service));

  return router;
}

module.exports = {
  FRIENDLY_MESSAGE,
  STATUS_BY_CODE,
  createDecisionHandler,
  createDecisionRouter,
  statusForError,
  JevDecisionError,
};
