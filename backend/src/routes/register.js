/**
 * 路由注册 — 从 app.js 拆分
 */
const express = require('express');
const path = require('path');
const config = require('../config');
const { logEvent } = require('../services/observability/observability.service');
const { getEmbeddingHealth } = require('../services/knowledge/embedding.service');

function applyRoutes(app, chatLimiter) {
  const { router: apiRoutes } = require('./index');
  const { streamHandler } = require('../controllers/chat.controller');
  const { speechHandler } = require('../controllers/audio.controller');
  const { chatUpload, parseFile } = require('../services/knowledge/file-upload.service');
  const { attachmentService } = require('../services/knowledge/attachment.service');
  const { requireAuth } = require('../middleware/auth.middleware');
  const { router: authRoutes } = require('./auth.routes');
  const { router: metricsRoutes } = require('./metrics.routes');

  const isProduction = process.env.NODE_ENV === 'production';

  // 健康检查
  app.get('/api/health', (req, res) => {
    const hasApiConfig = !!config.ai.apiKey;
    res.json({
      status: 'ok',
      message: '武理小精灵后端服务运行正常',
      timestamp: new Date().toISOString(),
      ai_service: {
        enabled: hasApiConfig,
        provider: 'StepFun (阶跃星辰)',
        model: config.ai.model || 'step-3.7-flash',
        status: hasApiConfig ? '配置正常' : '模拟模式',
      },
      storage: 'sqlite',
      // 检索侧质量信号：embedding 的 isAvailable 恒为 true（降级后仍能产出向量），
      // 只看它会复现 round-22 的"健康检查全绿但检索质量已塌"。
      // 这里额外读降级计数，模型未加载/推理失败时 status 会变成 degraded。
      retrieval: {
        embedding: getEmbeddingHealth(),
      },
    });
  });

  // API 列表：从实际路由栈动态生成，避免手写清单与实现脱节
  app.get('/api', (req, res) => {
    res.json({
      app: '武理小精灵后端',
      version: '1.0.0',
      endpoints: listRoutes(app._router?.stack),
    });
  });

  // 认证路由
  app.use('/api/auth', authRoutes);

  // 指标路由
  app.use('/api/metrics', metricsRoutes);

  // 子路由（RAG、评测、工具、记忆）
  // 直连 RAG 也属于高成本聊天入口，与 /api/stream 共用请求级限流。
  app.use('/api/rag/chat', chatLimiter);
  app.use('/api', apiRoutes);

  // SSE 流式聊天
  app.post('/api/stream', chatLimiter, streamHandler);

  // AI 回复语音合成（服务端代理，避免在浏览器暴露 StepFun API Key）
  app.post('/api/audio/speech', requireAuth, chatLimiter, speechHandler);

  // 聊天文件上传
  app.post('/api/chat/upload', requireAuth, chatUpload.single('file'), async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ success: false, error: '请上传文件' });
    }

    try {
      const file = req.file;
      const originalName = fixFilenameEncoding(file.originalname);
      const isImage = file.mimetype.startsWith('image/');
      let textContent = null;

      // 文档与图片都尝试解析：图片走视觉模型识别（表格截图→Markdown），
      // 识别失败（OCR 未启用/网络异常）降级为 null，不阻塞上传
      try {
        textContent = await parseFile(file.path, originalName);
      } catch (e) {
        logEvent('warn', 'chat_upload_parse_failed', { error: e.message });
      }

      if (textContent && Buffer.isBuffer(textContent)) {
        textContent = textContent.toString('utf8');
      }

      const attachment = await attachmentService.create({
        ownerUserId: req.userId,
        conversationId: req.body?.conversationId,
        storageName: file.filename,
        originalName,
        mimetype: file.mimetype,
        size: file.size,
        isImage,
      });

      res.json({
        success: true,
        data: {
          attachmentId: attachment.id,
          url: `/api/chat/attachments/${attachment.id}${attachment.conversationId ? `?conversationId=${encodeURIComponent(attachment.conversationId)}` : ''}`,
          name: attachment.originalName,
          type: attachment.mimetype,
          size: attachment.size,
          textContent,
          isImage: attachment.isImage,
          expiresAt: attachment.expiresAt,
        }
      });
    } catch (error) {
      if (req.file?.path) {
        try { require('fs').unlinkSync(req.file.path); } catch { /* 清理失败由定期任务兜底 */ }
      }
      logEvent('error', 'chat_upload_failed', { error: error.message, stack: error.stack });
      res.status(500).json({ success: false, error: '文件上传失败' });
    }
  });

  // 私有附件下载：资源必须属于当前用户，且不允许公共/代理缓存。
  const uploadStaticDir = path.join(__dirname, '../../uploads');
  const sendPrivateAttachment = async (req, res, attachment) => {
    if (!attachment || !attachmentService.canRead(attachment, {
      userId: req.userId,
      conversationId: req.query?.conversationId,
    })) {
      return res.status(404).json({ success: false, error: '附件不存在或无权访问' });
    }

    const filePath = attachmentService.getAttachmentPath(attachment);
    if (!filePath) return res.status(404).json({ success: false, error: '附件不存在' });
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Type', attachment.mimetype || 'application/octet-stream');
    if (!attachment.isImage) {
      const safeName = String(attachment.originalName || 'attachment').replace(/[\r\n"\\]/g, '_');
      res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
    }
    return res.sendFile(path.basename(filePath), { root: uploadStaticDir }, (error) => {
      if (error && !res.headersSent) res.status(error.statusCode || 404).json({ success: false, error: '附件不存在' });
    });
  };

  app.get('/api/chat/attachments/:attachmentId', requireAuth, async (req, res, next) => {
    try {
      const attachment = await attachmentService.getById(req.params.attachmentId);
      await sendPrivateAttachment(req, res, attachment);
    } catch (error) {
      next(error);
    }
  });

  // 兼容新附件在旧消息中保存的存储名 URL；没有归属元数据的旧文件不再开放。
  app.get('/uploads/:storageName', requireAuth, async (req, res, next) => {
    try {
      const attachment = await attachmentService.getByStorageName(req.params.storageName);
      await sendPrivateAttachment(req, res, attachment);
    } catch (error) {
      next(error);
    }
  });

  // 生产环境托管前端
  if (isProduction) {
    const frontendDist = path.join(__dirname, '../../../dist');
    app.use(express.static(frontendDist));

    app.get('*', (req, res) => {
      if (req.path.startsWith('/api') || req.path.startsWith('/uploads')) return;

      // 禁止浏览器缓存 index.html，确保每次加载最新前端（配合 hash 资源文件）
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');

      res.sendFile(path.join(frontendDist, 'index.html'));
    });
  }
}

/**
 * 从 Express 路由栈提取已注册端点：route 层取 method+path；
 * router 挂载层从 regexp 反解字面量挂载前缀后递归（所有挂载均为字符串路径）。
 */
function listRoutes(stack, prefix = '', out = []) {
  for (const layer of stack || []) {
    if (layer.route) {
      const methods = Object.keys(layer.route.methods || {}).map((m) => m.toUpperCase()).join('|');
      out.push({ method: methods || 'GET', path: prefix + layer.route.path });
    } else if (layer.name === 'router' && Array.isArray(layer.handle?.stack)) {
      const mounted = String(layer.regexp?.source || '')
        .replace(/^\^/, '')
        .replace(/\\\/\?\(\?=\\\/\|\$\)$/, '')
        .replace(/\\\//g, '/');
      listRoutes(layer.handle.stack, prefix + mounted, out);
    }
  }
  return out;
}

/**
 * 修复 multer 可能将 UTF-8 文件名误读为 Latin-1 的编码问题
 */
function fixFilenameEncoding(name) {
  if (!name) return name;
  try {
    const reencoded = Buffer.from(name, 'latin1').toString('utf8');
    const origChinese = (name.match(/[\u00c0-\u00ff]/g) || []).length;
    const fixedChinese = (reencoded.match(/[\u4e00-\u9fff]/g) || []).length;
    if (fixedChinese > origChinese) {
      return reencoded;
    }
  } catch (err) {
    logEvent('warn', 'file_upload_name_fix_failed', { error: err.message });
  }
  return name;
}

module.exports = { applyRoutes };
