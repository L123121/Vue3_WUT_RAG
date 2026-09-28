import { describe, expect, it } from 'vitest';

const {
  emptyDraft,
  accumulate,
  discard,
  finalize,
  applyEvent,
} = require('../src/utils/decision-draft');

const {
  INTENT_TYPES,
  ROUTES,
  ALLOWED_ROUTES,
  routeOfIntent,
  intentOfRoute,
  isAllowedRoute,
} = require('../src/services/agent/route-registry');

describe('decision-draft 状态机（agent 思考草稿的唯一实现）', () => {
  it('decision 内容累积进 pending，不进正文', () => {
    let draft = emptyDraft();
    draft = accumulate(draft, { content: '我先想想', decision: true });
    draft = accumulate(draft, { content: '……', decision: true });
    expect(draft.pending).toBe('我先想想……');
    expect(draft.reply).toBe('');
  });

  it('非 decision 内容取代草稿并写入正文', () => {
    let draft = emptyDraft();
    draft = accumulate(draft, { content: '草稿', decision: true });
    draft = accumulate(draft, { content: '正式回答' });
    expect(draft.pending).toBe('');
    expect(draft.reply).toBe('正式回答');
  });

  it('tool_call 作废草稿（不计入最终回答）', () => {
    let draft = emptyDraft();
    draft = accumulate(draft, { content: '草稿', decision: true });
    draft = discard(draft);
    expect(finalize(draft).reply).toBe('');
  });

  it('直答场景：未作废的草稿收尾时转正为正文', () => {
    let draft = emptyDraft();
    draft = accumulate(draft, { content: '直接回答', decision: true });
    expect(finalize(draft).reply).toBe('直接回答');
  });

  it('applyEvent 按事件类型分派，done 事件不累积', () => {
    let draft = emptyDraft();
    draft = applyEvent(draft, { type: 'content', content: '草稿', decision: true });
    draft = applyEvent(draft, { type: 'tool_call', tool_call: { name: 'calculate' } });
    expect(draft.pending).toBe('');
    draft = applyEvent(draft, { type: 'content', content: '尾巴', done: true });
    expect(draft.reply).toBe('');
  });
});

describe('route-registry 路由分类唯一事实来源', () => {
  it('意图与路由双向映射自洽', () => {
    expect(routeOfIntent(INTENT_TYPES.KNOWLEDGE_QUERY)).toBe('rag');
    expect(routeOfIntent(INTENT_TYPES.GENERAL_CHAT)).toBe('chat');
    expect(routeOfIntent(INTENT_TYPES.COMPLEX_TASK)).toBe('agent');
    expect(intentOfRoute('rag')).toBe(INTENT_TYPES.KNOWLEDGE_QUERY);
    expect(intentOfRoute('chat')).toBe(INTENT_TYPES.GENERAL_CHAT);
    expect(intentOfRoute('agent')).toBe(INTENT_TYPES.COMPLEX_TASK);
  });

  it('计算任务复用 agent 链路', () => {
    expect(routeOfIntent(INTENT_TYPES.CALCULATION_TASK)).toBe('agent');
  });

  it('未知意图/路由有安全兜底，不会产出 undefined 路由', () => {
    expect(routeOfIntent('not_an_intent')).toBe('chat');
    expect(intentOfRoute('nope')).toBe(INTENT_TYPES.GENERAL_CHAT);
  });

  it('路由白名单校验（Jev 外部决策输出靠它兜底）', () => {
    expect(isAllowedRoute('rag')).toBe(true);
    expect(isAllowedRoute('delete_all')).toBe(false);
    expect(isAllowedRoute('')).toBe(false);
    expect([...ALLOWED_ROUTES]).toEqual(Object.keys(ROUTES));
  });
});
