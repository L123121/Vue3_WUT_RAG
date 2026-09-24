"use strict";

const { Router } = require('express');
const { requireAuth, requireAdmin } = require('../middleware/auth.middleware');
const wikiController = require('../controllers/wiki.controller');

const router = Router();

// 百科阅读需登录；免登录公开读是独立开关，不在这里放松鉴权
router.use(requireAuth);

router.get('/entries', wikiController.listEntries);
router.get('/entries/:docId/revisions', requireAdmin, wikiController.getEntryRevisions);
router.get('/entries/:idOrSlug', wikiController.getEntry);

// 上架/下架仅管理员
router.put('/entries/:docId/visibility', requireAdmin, wikiController.setEntryVisibility);
// 手动重算互链（编译期产物，默认由上架异步触发，这里给管理员一个显式入口）
router.post('/entries/:docId/relations/recompile', requireAdmin, wikiController.recompileEntryRelations);

module.exports = router;
