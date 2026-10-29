'use strict';

const { Router } = require('express');
const { rateLimit } = require('express-rate-limit');
const { requireAuth, requireAdmin } = require('../middleware/auth.middleware');
const { successResponse, errorResponse } = require('../utils/response');
const { getRunCoordinator } = require('../services/agent-runtime/run-coordinator.service');

function createAgentRunsRouter({ coordinator = getRunCoordinator() } = {}) {
  const router = Router();
  router.use(requireAuth);
  router.use((req, res, next) => {
    if (['POST', 'PUT'].includes(req.method) && (!req.body || typeof req.body !== 'object' || Array.isArray(req.body))) return errorResponse(res, '请求体必须为JSON对象', 400);
    next();
  });
  const writes = rateLimit({ windowMs: 60000, limit: 40, keyGenerator: req => String(req.userId), standardHeaders: true, legacyHeaders: false, message: { success: false, message: '操作过于频繁，请稍后重试' } });
  router.use((req, res, next) => ['POST', 'PUT', 'DELETE'].includes(req.method) ? writes(req, res, next) : next());
  const wrap = action => async (req, res, next) => {
    try { successResponse(res, await action(req)); } catch (error) { next(error); }
  };
  router.get('/tools', wrap(async req => {
    const principal = await coordinator.actor(req.userId);
    const catalog = await coordinator.policy.catalog();
    return { ...catalog, history: principal.role === 'admin' ? catalog.history : [], runtimeEnabled: process.env.AGENT_RUNTIME_ENABLED !== 'false' };
  }));
  router.put('/tools/policy', requireAdmin, wrap(async req => coordinator.policy.update(await coordinator.actor(req.userId), req.body)));
  router.get('/', wrap(req => coordinator.list(req.userId)));
  const enabled = (req, res, next) => process.env.AGENT_RUNTIME_ENABLED === 'false' ? errorResponse(res, '持久Agent任务未启用', 403) : next();
  router.post('/', enabled, wrap(req => coordinator.create(req.userId, req.body)));
  router.get('/:id', wrap(req => coordinator.get(req.userId, req.params.id)));
  router.put('/:id/plan', wrap(req => coordinator.edit(req.userId, req.params.id, req.body)));
  router.post('/:id/start', enabled, wrap(req => coordinator.start(req.userId, req.params.id, req.body)));
  router.post('/:id/pause', wrap(req => coordinator.stop(req.userId, req.params.id, req.body, true)));
  router.post('/:id/cancel', wrap(req => coordinator.stop(req.userId, req.params.id, req.body)));
  router.post('/:id/resume', enabled, wrap(req => coordinator.resume(req.userId, req.params.id, req.body)));
  router.post('/:id/steps/:stepId/approval', wrap(req => coordinator.approval(req.userId, req.params.id, req.params.stepId, req.body)));
  router.get('/:id/events', wrap(req => coordinator.events(req.userId, req.params.id, { after: Number(req.query.after || 0), limit: Number(req.query.limit || 100) })));
  router.get('/:id/replay', wrap(req => coordinator.replay(req.userId, req.params.id, Number(req.query.through))));
  router.delete('/:id', wrap(req => coordinator.remove(req.userId, req.params.id, Number(req.query.version))));
  return router;
}

module.exports = { createAgentRunsRouter };
