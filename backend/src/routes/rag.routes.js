"use strict";

const { Router } = require('express');
const { requireAuth, requireAdmin } = require('../middleware/auth.middleware');
const ragController = require('../controllers/rag.controller');

const router = Router();

// RAG 接口需要登录
router.use(requireAuth);

// RAG 聊天接口（普通用户可用）
router.post('/chat', ragController.ragChat);
router.post('/chat/stream', ragController.ragChatStream);
router.get('/feedback', ragController.listFeedback);
router.post('/feedback', ragController.submitFeedback);
// 反馈 → 评测集数据飞轮（仅管理员）：queued 入队 / exported 已导出
router.post('/feedback/eval-status', requireAdmin, ragController.updateFeedbackEvalStatus);

// 离线评估
router.post('/retrieval/parents', ragController.retrieveParentCandidates);

// 文档查看接口（已登录用户可查看）
router.get('/documents', ragController.listDocuments);
router.get('/documents/:id', ragController.getDocument);

// 文档管理接口（仅管理员可增删改）
router.post('/documents', requireAdmin, ragController.addDocument);
router.post('/documents/upload', requireAdmin, ragController.uploadMiddleware, ragController.uploadDocument);
router.post('/documents/reindex', requireAdmin, ragController.reindexDocuments);
router.delete('/documents/:id', requireAdmin, ragController.deleteDocument);

// 统计信息
router.get('/stats', ragController.getStats);

module.exports = router;
