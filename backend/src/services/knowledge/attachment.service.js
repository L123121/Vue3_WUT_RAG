'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { redis: defaultStore } = require('../memory/memory-store.service');

const uploadDir = path.join(__dirname, '../../uploads');
const attachmentPrefix = 'attachment:';
const attachmentByStorageKey = 'attachments:by-storage';
const attachmentIdsKey = 'attachments:all';
const ATTACHMENT_ID_RE = /^att_[a-zA-Z0-9_-]{20,100}$/;
const STORAGE_NAME_RE = /^upload-[a-zA-Z0-9_.-]+$/;
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const asText = (value, maxLength = 300) => String(value || '').trim().slice(0, maxLength);
const normalizeUserId = (value) => asText(value, 160);
const normalizeConversationId = (value) => asText(value, 160) || null;
const normalizeStorageName = (value) => {
  const rawName = asText(value, 220);
  if (!rawName || rawName !== path.basename(rawName) || rawName.includes('\\')) return '';
  return STORAGE_NAME_RE.test(rawName) ? rawName : '';
};
const normalizeAttachmentId = (value) => {
  const attachmentId = asText(value, 120);
  return ATTACHMENT_ID_RE.test(attachmentId) ? attachmentId : '';
};

const createAttachmentId = () => `att_${crypto.randomUUID().replace(/-/g, '')}`;
const metadataKey = (attachmentId) => `${attachmentPrefix}${attachmentId}`;

const sanitizeOriginalName = (value) => {
  const name = path.basename(asText(value, 240)).replace(/[\r\n"\\]/g, '_');
  return name || '附件';
};

const getAttachmentPath = (attachment) => {
  const storageName = normalizeStorageName(attachment?.storageName);
  if (!storageName) return '';
  const absolutePath = path.resolve(uploadDir, storageName);
  const root = `${path.resolve(uploadDir)}${path.sep}`;
  return absolutePath.startsWith(root) ? absolutePath : '';
};

const createAttachmentService = ({ store = defaultStore, now = Date.now, ttlMs = DEFAULT_TTL_MS } = {}) => {
  const create = async ({
    ownerUserId,
    conversationId = null,
    storageName,
    originalName,
    mimetype,
    size,
    isImage = false,
  } = {}) => {
    const owner = normalizeUserId(ownerUserId);
    const storedName = normalizeStorageName(storageName);
    if (!owner) throw new Error('附件缺少归属用户');
    if (!storedName) throw new Error('附件存储名无效');

    const attachmentId = createAttachmentId();
    const createdAt = now();
    const expiresAt = createdAt + Math.max(60_000, Number(ttlMs) || DEFAULT_TTL_MS);
    const metadata = {
      id: attachmentId,
      ownerUserId: owner,
      conversationId: normalizeConversationId(conversationId),
      storageName: storedName,
      originalName: sanitizeOriginalName(originalName),
      mimetype: asText(mimetype, 160) || 'application/octet-stream',
      size: Math.max(0, Number(size) || 0),
      isImage: isImage === true,
      createdAt,
      expiresAt,
    };

    await store.hset(metadataKey(attachmentId), metadata);
    await store.hset(attachmentByStorageKey, storedName, attachmentId);
    await store.sadd(attachmentIdsKey, attachmentId);
    return metadata;
  };

  const getById = async (attachmentId) => {
    const id = normalizeAttachmentId(attachmentId);
    if (!id) return null;
    const metadata = await store.hgetall(metadataKey(id));
    if (!metadata || metadata.id !== id) return null;
    return metadata;
  };

  const getByStorageName = async (storageName) => {
    const storedName = normalizeStorageName(storageName);
    if (!storedName) return null;
    const attachmentId = await store.hget(attachmentByStorageKey, storedName);
    return attachmentId ? getById(attachmentId) : null;
  };

  const canRead = (metadata, { userId, conversationId } = {}) => {
    if (!metadata) return false;
    const owner = normalizeUserId(userId);
    if (!owner || metadata.ownerUserId !== owner) return false;
    const requestedConversation = normalizeConversationId(conversationId);
    if (metadata.conversationId && metadata.conversationId !== requestedConversation) return false;
    if (metadata.expiresAt && Number(metadata.expiresAt) <= now()) return false;
    return !!getAttachmentPath(metadata);
  };

  const getForUser = async (attachmentId, context = {}) => {
    const metadata = await getById(attachmentId);
    return canRead(metadata, context) ? metadata : null;
  };

  const remove = async (attachmentId) => {
    const metadata = await getById(attachmentId);
    if (!metadata) return false;
    const filePath = getAttachmentPath(metadata);
    if (filePath) await fs.promises.unlink(filePath).catch(() => {});
    await store.hdel(attachmentByStorageKey, metadata.storageName);
    await store.srem(attachmentIdsKey, metadata.id);
    await store.del(metadataKey(metadata.id));
    return true;
  };

  const cleanupExpired = async () => {
    const ids = await store.smembers(attachmentIdsKey);
    let removed = 0;
    for (const id of ids || []) {
      const metadata = await getById(id);
      if (!metadata || Number(metadata.expiresAt) <= now() || !fs.existsSync(getAttachmentPath(metadata))) {
        if (await remove(id)) removed += 1;
      }
    }
    return removed;
  };

  return {
    create,
    getById,
    getByStorageName,
    getForUser,
    canRead,
    getAttachmentPath,
    remove,
    cleanupExpired,
    normalizeAttachmentId,
    normalizeStorageName,
  };
};

const attachmentService = createAttachmentService();

module.exports = {
  ATTACHMENT_ID_RE,
  attachmentService,
  createAttachmentService,
  createAttachmentId,
  getAttachmentPath,
};
