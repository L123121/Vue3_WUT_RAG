import { describe, expect, it, vi } from 'vitest';

/**
 * quota.service 匿名分桶单元测试。
 * 只验证 key 派生策略（不涉及存储），因此不加载 store：
 * 不同 IP 必须落在不同桶，且桶名里不能出现原始 IP（避免明文 IP 进持久化存储）。
 */
vi.mock('../src/services/memory/memory-store.service', () => ({ redis: {} }));

const quotaService = require('../src/services/auth/quota.service');

describe('quota.service 匿名配额分桶', () => {
  it('不同客户端 IP 落在不同的配额桶', () => {
    const first = quotaService._key(null, '203.0.113.9');
    const second = quotaService._key(null, '198.51.100.7');
    expect(first).not.toBe(second);
    expect(first).not.toContain('203.0.113.9');
    expect(second).not.toContain('198.51.100.7');
  });

  it('同一 IP 稳定映射到同一桶（每日配额按客户端累计而非随机）', () => {
    expect(quotaService._key(null, '203.0.113.9')).toBe(quotaService._key(null, '203.0.113.9'));
  });

  it('缺少 IP 时回退到原有 anonymous 桶，行为与改动前一致', () => {
    expect(quotaService._key(null)).toBe('quota:usage:anonymous');
    expect(quotaService._key(null, '')).toBe('quota:usage:anonymous');
    expect(quotaService._key(null, '   ')).toBe('quota:usage:anonymous');
  });

  it('登录用户仍然按 userId 分桶，不受 IP 影响', () => {
    expect(quotaService._key('u1', '203.0.113.9')).toBe('quota:usage:u1');
    expect(quotaService._key('u1')).toBe('quota:usage:u1');
  });
});
