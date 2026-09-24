import { describe, expect, it } from 'vitest';

const { createAttachmentService } = require('../src/services/attachment.service');

const createStore = () => {
  const hashes = new Map();
  const sets = new Map();
  const getHash = (key) => hashes.get(key) || {};
  return {
    async hset(key, values) {
      const current = { ...getHash(key) };
      const patch = typeof values === 'object' ? values : {};
      Object.assign(current, patch);
      hashes.set(key, current);
      return Object.keys(patch).length;
    },
    async hgetall(key) {
      const value = hashes.get(key);
      return value ? { ...value } : null;
    },
    async hget(key, field) {
      return getHash(key)[field] ?? null;
    },
    async hdel(key, field) {
      const current = getHash(key);
      if (!(field in current)) return 0;
      delete current[field];
      hashes.set(key, current);
      return 1;
    },
    async del(key) {
      const existed = hashes.delete(key);
      sets.delete(key);
      return existed ? 1 : 0;
    },
    async sadd(key, value) {
      const set = sets.get(key) || new Set();
      set.add(String(value));
      sets.set(key, set);
      return 1;
    },
    async srem(key, value) {
      return sets.get(key)?.delete(String(value)) ? 1 : 0;
    },
    async smembers(key) {
      return [...(sets.get(key) || [])];
    },
  };
};

describe('attachment.service', () => {
  it('创建 opaque 附件并按用户/会话校验访问', async () => {
    const service = createAttachmentService({ store: createStore(), now: () => 1_000_000, ttlMs: 60_000 });
    const attachment = await service.create({
      ownerUserId: 'user-a',
      conversationId: 'conv-a',
      storageName: 'upload-123-456.pdf',
      originalName: '../成绩\n单.pdf',
      mimetype: 'application/pdf',
      size: 128,
    });

    expect(attachment.id).toMatch(/^att_[a-z0-9]{32}$/);
    expect(attachment.conversationId).toBe('conv-a');
    expect(attachment.originalName).toBe('成绩_单.pdf');
    expect(attachment.url).toBeUndefined();
    expect(await service.getForUser(attachment.id, { userId: 'user-a', conversationId: 'conv-a' })).toEqual(attachment);
    expect(await service.getForUser(attachment.id, { userId: 'user-a' })).toBeNull();
    expect(await service.getForUser(attachment.id, { userId: 'user-b', conversationId: 'conv-a' })).toBeNull();
    expect(await service.getForUser(attachment.id, { userId: 'user-a', conversationId: 'conv-b' })).toBeNull();
  });

  it('过期、路径穿越和非法 storageName 不可读取', async () => {
    let timestamp = 2_000_000;
    const service = createAttachmentService({ store: createStore(), now: () => timestamp, ttlMs: 60_000 });
    const attachment = await service.create({
      ownerUserId: 'user-a',
      storageName: 'upload-1-2.txt',
      originalName: 'notes.txt',
      mimetype: 'text/plain',
    });

    expect(service.normalizeStorageName('../upload-1-2.txt')).toBe('');
    expect(service.normalizeStorageName('upload-1-2.txt')).toBe('upload-1-2.txt');
    timestamp += 61_000;
    expect(await service.getForUser(attachment.id, { userId: 'user-a' })).toBeNull();
  });
});
