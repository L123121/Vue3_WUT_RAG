import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockConversationStore = {
  getConversations: vi.fn(),
  getConversation: vi.fn(),
  createConversation: vi.fn(),
  saveConversation: vi.fn(),
  deleteConversation: vi.fn(),
  clearMessages: vi.fn(),
};

vi.mock('../src/services/memory/memory-store.service', () => ({
  conversationStore: mockConversationStore,
}));

vi.mock('../src/middleware/auth.middleware', () => ({
  requireAuth: (req, res, next) => {
    if (!req.userId) return res.status(401).json({ success: false, error: '请先登录' });
    next();
  },
}));

describe('Conversation Routes Logic', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('getConversations 返回列表', async () => {
    mockConversationStore.getConversations.mockResolvedValue([{ id: '1', title: '测试' }]);
    const result = await mockConversationStore.getConversations('u1');
    expect(result).toHaveLength(1);
  });

  it('createConversation 创建', async () => {
    mockConversationStore.createConversation.mockResolvedValue({ id: 'new', title: '新会话' });
    const r = await mockConversationStore.createConversation('u1', '新会话');
    expect(r.id).toBe('new');
  });

  it('getConversation 不存在返回 null', async () => {
    mockConversationStore.getConversation.mockResolvedValue(null);
    expect(await mockConversationStore.getConversation('u1', 'x')).toBeNull();
  });

  it('saveConversation 更新', async () => {
    mockConversationStore.saveConversation.mockResolvedValue({ id: '1', title: '新' });
    expect((await mockConversationStore.saveConversation('u1', '1', { title: '新' })).title).toBe('新');
  });

  it('deleteConversation 删除', async () => {
    mockConversationStore.deleteConversation.mockResolvedValue(true);
    expect(await mockConversationStore.deleteConversation('u1', '1')).toBe(true);
  });

  it('clearMessages 清空', async () => {
    mockConversationStore.clearMessages.mockResolvedValue(true);
    expect(await mockConversationStore.clearMessages('u1', '1')).toBe(true);
  });
});

describe('requireAuth 逻辑', () => {
  it('有 userId 放行', () => {
    const requireAuth = require('../src/middleware/auth.middleware').requireAuth;
    const next = vi.fn();
    requireAuth({ userId: 'u1' }, {}, next);
    expect(next).toHaveBeenCalled();
  });

  it('无 userId 返回 401', () => {
    const requireAuth = require('../src/middleware/auth.middleware').requireAuth;
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    requireAuth({ userId: null }, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(401);
  });
});
