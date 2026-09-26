import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 消息分叉集成测试：真实 SQLite 存储（与控制器集成测试同一模式）
 * forkConversation = getConversation → 截取消息 → createConversation → saveConversation
 */
function getStore() {
  delete require.cache[require.resolve('../src/services/memory/memory-store.service')];
  return require('../src/services/memory/memory-store.service').conversationStore;
}

describe('ConversationStore.forkConversation（真实 SQLite）', () => {
  const USER = 'fork_it_user';
  let CONV_ID;

  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = getStore();
    const conv = await store.createConversation(USER, '原始会话');
    CONV_ID = conv.id;
    await store.saveConversation(USER, CONV_ID, {
      messages: [
        { id: 'm1', role: 'user', content: '第一个问题' },
        { id: 'm2', role: 'model', content: '第一个回答' },
        { id: 'm3', role: 'user', content: '第二个问题' },
        { id: 'm4', role: 'model', content: '第二个回答' },
      ],
    });
  });

  it('从中间消息分叉：新会话只含该消息及之前的历史，原会话不变', async () => {
    const store = getStore();

    const forked = await store.forkConversation(USER, CONV_ID, 'm2');
    expect(forked).not.toBeNull();
    expect(forked.id).not.toBe(CONV_ID);
    expect(forked.title).toBe('原始会话（分叉）');
    expect(forked.messages.map((m) => m.id)).toEqual(['m1', 'm2']);

    const original = await store.getConversation(USER, CONV_ID);
    expect(original.messages).toHaveLength(4);

    await store.deleteConversation(USER, forked.id);
  });

  it('不传 messageId：默认复制到最后一条', async () => {
    const store = getStore();

    const forked = await store.forkConversation(USER, CONV_ID, null);
    expect(forked.messages).toHaveLength(4);

    await store.deleteConversation(USER, forked.id);
  });

  it('会话或消息不存在返回 null', async () => {
    const store = getStore();

    expect(await store.forkConversation(USER, 'missing_conv', 'm1')).toBeNull();
    expect(await store.forkConversation(USER, CONV_ID, 'missing_msg')).toBeNull();
  });
});
