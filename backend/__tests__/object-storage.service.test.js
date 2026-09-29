import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { LocalObjectStorage, S3ObjectStorage, normalizeKey } = require('../src/services/storage/object-storage.service');

const dirs = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});

describe('object-storage.service', () => {
  it('local backend 以受控 key 读写、列举和删除私有对象', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'wut-object-store-'));
    dirs.push(rootDir);
    const storage = new LocalObjectStorage({ rootDir });

    await storage.putObject('attachments/att_1/file.txt', 'hello', { contentType: 'text/plain' });
    const object = await storage.getObject('attachments/att_1/file.txt');
    expect(object.body.toString()).toBe('hello');
    expect(await storage.exists('attachments/att_1/file.txt')).toBe(true);
    expect(await storage.list('attachments')).toEqual([expect.objectContaining({ key: 'attachments/att_1/file.txt', size: 5 })]);
    expect(await storage.deleteObject('attachments/att_1/file.txt')).toBe(true);
    expect(await storage.getObject('attachments/att_1/file.txt')).toBeNull();
  });

  it('拒绝路径穿越和非法 object key', async () => {
    expect(normalizeKey('../secret')).toBe('');
    expect(normalizeKey('/attachments/../secret')).toBe('');
    expect(normalizeKey('attachments/a.txt')).toBe('attachments/a.txt');
  });

  it('S3 配置不完整时报告 unavailable', () => {
    expect(new S3ObjectStorage({ s3: {} }).getHealth()).toMatchObject({ status: 'unavailable', backend: 's3' });
  });
});
