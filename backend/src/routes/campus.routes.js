'use strict';

const { Router } = require('express');
const { rateLimit } = require('express-rate-limit');
const { requireAuth } = require('../middleware/auth.middleware');
const { successResponse, errorResponse } = require('../utils/response');
const { CampusWorkbenchService } = require('../services/campus/campus-workbench.service');

function createCampusRouter({ service = new CampusWorkbenchService() } = {}) {
  const router = Router();
  router.use(requireAuth);
  router.use((req, res, next) => {
    if (['POST', 'PUT'].includes(req.method) && (!req.body || typeof req.body !== 'object' || Array.isArray(req.body))) {
      return errorResponse(res, '请求体必须为 JSON 对象', 400);
    }
    next();
  });
  const wrap = action => async (req, res, next) => {
    try { successResponse(res, await action(req)); } catch (error) { next(error); }
  };
  const checkLimiter = rateLimit({
    windowMs: 60_000, limit: 12, standardHeaders: true, legacyHeaders: false,
    keyGenerator: req => String(req.userId),
    message: { success: false, message: '检查过于频繁，请稍后再试' },
  });
  router.get('/', wrap(req => service.overview(req.userId)));
  router.get('/tasks/:id', wrap(req => service.detail(req.userId, req.params.id)));
  router.post('/tasks', checkLimiter, wrap(req => service.create(req.userId, req.body)));
  router.put('/tasks/:id', wrap(req => service.update(req.userId, req.params.id, req.body)));
  router.delete('/tasks/:id', wrap(req => service.remove(req.userId, req.params.id, Number(req.query.version))));
  router.post('/subscriptions', checkLimiter, wrap(req => service.subscribe(req.userId, req.body?.docId)));
  router.put('/subscriptions/:docId', wrap(req => service.updateSubscription(req.userId, req.params.docId, req.body)));
  router.post('/refresh', checkLimiter, wrap(req => service.refresh(req.userId)));
  router.post('/evidence', checkLimiter, wrap(req => service.reviewEvidence(req.body)));
  return router;
}

module.exports = { createCampusRouter };
