const { Router } = require('express');
const conversationsRoutes = require('./conversations.routes');
const ragRoutes = require('./rag.routes');
const evalRoutes = require('./eval.routes');
const shareRoutes = require('./share.routes');
const wikiRoutes = require('./wiki.routes');

const router = Router();

// 聊天接口（/api/stream）已在 register.js 中注册
router.use('/conversations', conversationsRoutes);
router.use('/rag', ragRoutes);
router.use('/eval', evalRoutes);
router.use('/share', shareRoutes);
router.use('/wiki', wikiRoutes);

module.exports = { router };
