import { describe, expect, it } from 'vitest';
import { shallowMount } from '@vue/test-utils';
import MessageFragmentRenderer from '../components/chat/MessageFragmentRenderer.vue';
import ProcessCard from '../components/chat/ProcessCard.vue';

const TextStub = {
  name: 'MessageTextFragment',
  props: ['content'],
  template: '<div data-testid="text-fragment">{{ content }}</div>',
};

const UnknownStub = {
  name: 'UnknownMessageFragment',
  props: ['originalType', 'data'],
  template: '<div data-testid="unknown-fragment">{{ originalType }}</div>',
};

describe('Message Fragment 渲染边界', () => {
  it('按注册表渲染正文并安全兜底未知节点', () => {
    const wrapper = shallowMount(MessageFragmentRenderer, {
      props: {
        message: {
          id: 'm1',
          role: 'model',
          content: '正常回答',
          fragments: [{
            type: 'ui.chart',
            data: { html: '<img src=x onerror=alert(1)>' },
          }],
        },
      },
      global: {
        stubs: {
          MessageTextFragment: TextStub,
          UnknownMessageFragment: UnknownStub,
        },
      },
    });

    expect(wrapper.find('[data-testid="text-fragment"]').text()).toBe('正常回答');
    expect(wrapper.find('[data-testid="unknown-fragment"]').text()).toBe('ui.chart');
    expect(wrapper.find('img').exists()).toBe(false);
  });

  it('decision 字段渲染为 decision-badge，decisionDraft prop 合成瞬态草稿 fragment 且不写回 message', () => {
    const message = {
      id: 'm-decision',
      role: 'model',
      content: '答案',
      decision: { provider: 'jev', status: 'applied', applied: true, confidence: 0.9 },
    };
    const wrapper = shallowMount(MessageFragmentRenderer, {
      props: { message, decisionDraft: '思考中的文本' },
      global: { stubs: { MessageTextFragment: TextStub } },
    });

    const rendered = wrapper.findAllComponents({ name: 'DecisionDraftFragment' });
    expect(rendered).toHaveLength(1);
    expect(rendered[0].props('text')).toBe('思考中的文本');
    // 合成的草稿 fragment 只影响渲染输出，不会被写回传入的 message 对象
    expect(message.fragments).toBeUndefined();

    const badge = wrapper.findAllComponents({ name: 'MessageStatusFragment' });
    expect(badge.some((instance) => instance.props('variant') === 'decision-badge')).toBe(true);
  });

  it('流程卡片 props 更新后刷新步骤内容', async () => {
    const wrapper = shallowMount(ProcessCard, {
      props: {
        card: { summary: '办理', steps: [{ title: '第一步' }], materials: [] },
      },
    });

    expect(wrapper.text()).toContain('第一步');
    await wrapper.setProps({
      card: { summary: '办理', steps: [{ title: '更新后的步骤' }], materials: [] },
    });
    expect(wrapper.text()).toContain('更新后的步骤');
    expect(wrapper.text()).not.toContain('第一步');
  });
});
