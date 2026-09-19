"use strict";

/**
 * 对话分享快照 API
 *
 * POST /api/share   — 生成分享快照（需登录），返回短码 code
 * GET  /api/share/:code — 公开读取快照（只读，无需登录）
 *
 * 快照存于 MemoryStore hash：key=`share:snapshots`，field=code，
 * 与会话存储同库，重启不丢。
 */
const { Router } = require('express');
const crypto = require('crypto');
const { requireAuth } = require('../middleware/auth.middleware');
const { redis: store } = require('../services/memory-store');
const { logEvent } = require('../services/observability.service');

const router = Router();
const SNAPSHOT_KEY = 'share:snapshots';
const MAX_MESSAGES = 200;

// 生成 8 位随机短码（base62，避免歧义字符）
function generateCode() {
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const bytes = crypto.randomBytes(8);
  let code = '';
  for (const b of bytes) code += alphabet[b % alphabet.length];
  return code;
}

// 清洗消息：只保留展示所需的只读字段，去掉 trace/feedback 等内部数据
function sanitizeMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter((m) => m && m.id !== 'welcome' && m.text && String(m.text).trim())
    .slice(0, MAX_MESSAGES)
    .map((m) => ({
      role: m.role === 'user' ? 'user' : 'model',
      text: String(m.text),
      timestamp: m.timestamp || null,
    }));
}

router.post('/', requireAuth, async (req, res) => {
  try {
    const { title, messages } = req.body || {};
    const cleanMessages = sanitizeMessages(messages);
    if (cleanMessages.length === 0) {
      return res.status(400).json({ success: false, error: '没有可分享的消息内容' });
    }

    const code = generateCode();
    const snapshot = {
      code,
      title: String(title || '对话记录').trim().slice(0, 100) || '对话记录',
      messages: cleanMessages,
      createdAt: new Date().toISOString(),
      createdBy: req.userId || null,
    };
    await store.hset(SNAPSHOT_KEY, code, snapshot);

    res.json({ success: true, data: { code, url: `/share/${code}`, createdAt: snapshot.createdAt } });
  } catch (error) {
    logEvent('error', 'share_snapshot_create_failed', { error: error.message });
    res.status(500).json({ success: false, error: '创建分享失败' });
  }
});

router.get('/:code', async (req, res) => {
  try {
    const code = String(req.params.code || '').trim();
    if (!code || !/^[a-zA-Z0-9]{8}$/.test(code)) {
      return res.status(400).json({ success: false, error: '分享链接无效' });
    }
    const snapshot = await store.hget(SNAPSHOT_KEY, code);
    if (!snapshot) {
      return res.status(404).json({ success: false, error: '分享已失效或不存在' });
    }
    res.json({ success: true, data: snapshot });
  } catch (error) {
    logEvent('error', 'share_snapshot_read_failed', { error: error.message });
    res.status(500).json({ success: false, error: '读取分享失败' });
  }
});

module.exports = router;
