import { describe, expect, it } from 'vitest';
import {
  appendUnknownMessageFragment,
  clearMessageAttemptState,
  createDecisionDraftFragment,
  getMessageFragmentSignature,
  getMessageFragments,
  hasRenderableMessageContent,
  hydrateMessageFragments,
  mergeMessageLists,
  patchMessageForEvent,
  toLlmHistoryMessage,
  MESSAGE_FRAGMENT_TYPES,
} from '../utils/messageFragments.js';

const source = { docId: 'doc-1', title: '校园手册' };

describe('message fragments', () => {
  it('将旧扁平消息 hydration 为兼容的已知 fragments', () => {
    const message = hydrateMessageFragments({
      id: 'm1',
      role: 'model',
      content: '回答正文',
      files: [{ url: '/uploads/a.txt', name: 'a.txt' }],
      sources: [source],
      processCard: { summary: '办理', steps: [{ title: '提交' }] },
      intent: { route: 'rag' },
      usage: { total_tokens: 3 },
    });

    expect(message.content).toBe('回答正文');
    expect(message.text).toBeUndefined();
    expect(message.fragmentVersion).toBe(1);
    expect(message.fragments.map((fragment) => fragment.type)).toEqual([
      MESSAGE_FRAGMENT_TYPES.ATTACHMENTS,
      MESSAGE_FRAGMENT_TYPES.TEXT,
      MESSAGE_FRAGMENT_TYPES.PROCESS_CARD,
      MESSAGE_FRAGMENT_TYPES.INTENT_BADGE,
      MESSAGE_FRAGMENT_TYPES.USAGE,
    ]);
    expect(getMessageFragmentSignature(message)).toContain('fragment:text');
  });

  it('decision 字段归一为 decision-badge fragment，紧随 process-card 之后、intent-badge 之前', () => {
    const message = hydrateMessageFragments({
      id: 'm-decision',
      role: 'model',
      content: '答案',
      decision: { provider: 'jev', status: 'applied', applied: true, confidence: 0.9 },
      intent: { route: 'rag' },
    });

    expect(message.fragments.map((fragment) => fragment.type)).toEqual([
      MESSAGE_FRAGMENT_TYPES.TEXT,
      MESSAGE_FRAGMENT_TYPES.DECISION_BADGE,
      MESSAGE_FRAGMENT_TYPES.INTENT_BADGE,
    ]);
  });

  it('decision-draft 是渲染时合成的瞬态 fragment，不进入 hydrate 派生管线', () => {
    const message = hydrateMessageFragments({ id: 'm-draft', role: 'model', content: '' });
    expect(message.fragments.some((fragment) => fragment.type === MESSAGE_FRAGMENT_TYPES.DECISION_DRAFT)).toBe(false);

    const draft = createDecisionDraftFragment('思考中的文本');
    expect(draft).toMatchObject({ type: MESSAGE_FRAGMENT_TYPES.DECISION_DRAFT, data: { text: '思考中的文本' } });
  });

  it('patchMessageForEvent 按声明式规则做整体替换/追加，无需在调用方手写合并代码', () => {
    let message = { id: 'm-patch', role: 'model', sources: [], toolCalls: [] };

    message = patchMessageForEvent(message, 'sources', [{ docId: 'doc-1' }]);
    expect(message).toMatchObject({ sources: [{ docId: 'doc-1' }], answerMode: 'rag', usedRag: true });

    message = patchMessageForEvent(message, 'toolCall', { name: 'calculate' });
    message = patchMessageForEvent(message, 'toolCall', { name: 'search_knowledge_base' });
    expect(message.toolCalls).toEqual([{ name: 'calculate' }, { name: 'search_knowledge_base' }]);
    expect(message.answerMode).toBe('agent');

    message = patchMessageForEvent(message, 'intent', null);
    expect(message.intent).toBeUndefined();
    message = patchMessageForEvent(message, 'unknown-event', 'x');
    expect(message.sources).toEqual([{ docId: 'doc-1' }]);
  });

  it('保留未知 fragment 的原始类型、数据和来源', () => {
    const message = hydrateMessageFragments({
      id: 'm-unknown',
      role: 'model',
      fragments: [{
        id: 'node-1',
        type: 'ui.chart',
        data: { points: [1, 2] },
        origin: { seq: 9, traceId: 'trace-1' },
      }],
    });

    expect(message.fragments).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'node-1',
        type: MESSAGE_FRAGMENT_TYPES.UNKNOWN,
        originalType: 'ui.chart',
        data: { points: [1, 2] },
        origin: { seq: 9, traceId: 'trace-1' },
      }),
    ]));
  });

  it('未知实时事件按 attempt/seq 幂等追加', () => {
    const first = appendUnknownMessageFragment({ id: 'm1', role: 'model', content: 'x' }, {
      type: 'ui.chart',
      data: { value: 1 },
      origin: { attempt: 0, seq: 7, traceId: 'trace-1' },
    });
    const second = appendUnknownMessageFragment(first, {
      type: 'ui.chart',
      data: { value: 2 },
      origin: { attempt: 0, seq: 7, traceId: 'trace-1' },
    });

    expect(second.fragments.filter((fragment) => fragment.type === MESSAGE_FRAGMENT_TYPES.UNKNOWN)).toHaveLength(1);
    expect(second.fragments.find((fragment) => fragment.type === MESSAGE_FRAGMENT_TYPES.UNKNOWN).data).toEqual({ value: 2 });
  });

  it('模型历史统一转换为 assistant，并排除临时扩展数据', () => {
    expect(toLlmHistoryMessage({ id: 'm1', role: 'model', content: '回答', fragments: [{ type: 'unknown', data: { secret: true } }] })).toEqual({
      role: 'assistant',
      content: '回答',
    });
    expect(toLlmHistoryMessage({ id: 'welcome', role: 'model', content: '欢迎' })).toBeNull();
    expect(toLlmHistoryMessage({ id: 'error', role: 'model', content: '错误', isError: true })).toBeNull();
  });

  it('重试清空上一轮所有派生状态但保留消息身份', () => {
    const reset = clearMessageAttemptState({
      id: 'm1',
      role: 'model',
      content: '旧回答',
      sources: [source],
      decision: { provider: 'jev', status: 'applied' },
      toolCalls: [{ name: 'calculate' }],
      grounding: { coverage: 1 },
      fragments: [{ type: 'unknown', data: { value: 1 } }],
    });

    expect(reset.id).toBe('m1');
    expect(reset.content).toBe('');
    expect(reset.sources).toEqual([]);
    expect(reset.decision).toBeNull();
    expect(reset.toolCalls).toEqual([]);
    expect(reset.grounding).toBeNull();
    expect(reset.fragments).toEqual([]);
  });

  it('同长度消息合并时保留 richer fragments', () => {
    const merged = mergeMessageLists(
      [{ id: 'm1', role: 'model', content: '回答', fragments: [{ type: 'ui.chart', data: { points: [1] } }] }],
      [{ id: 'm1', role: 'model', content: '回答' }],
    );

    expect(merged).toHaveLength(1);
    expect(merged[0].fragments).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: MESSAGE_FRAGMENT_TYPES.UNKNOWN, originalType: 'ui.chart' }),
    ]));
  });

  it('只有未知节点也属于可渲染消息内容', () => {
    expect(hasRenderableMessageContent({ id: 'm1', role: 'model', fragments: [{ type: 'ui.chart', data: {} }] })).toBe(true);
    expect(hasRenderableMessageContent({ id: 'welcome', role: 'model', content: '欢迎' })).toBe(false);
  });
});
