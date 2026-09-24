import { beforeEach, describe, expect, it, vi } from 'vitest';
import { shallowMount } from '@vue/test-utils';
import { routerKey } from 'vue-router';
import { createPinia, setActivePinia } from 'pinia';
import MessageBubble from '../components/chat/MessageBubble.vue';

const FragmentStub = {
  name: 'MessageFragmentRenderer',
  props: ['message'],
  template: '<div data-testid="fragment-renderer">{{ message.content }}</div>',
};

const ActionsStub = { name: 'MessageActions', template: '<div data-testid="actions" />' };
const CitationStub = { name: 'CitationPopup', template: '<div data-testid="citation" />' };

describe('MessageBubble Fragment 接入', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it('保留消息气泡交互并将正文交给 Fragment 渲染器', () => {
    const wrapper = shallowMount(MessageBubble, {
      props: {
        message: {
          id: 'm1',
          role: 'model',
          content: '回答内容',
          fragments: [{ type: 'text', ref: 'text' }],
        },
      },
      global: {
        stubs: {
          MessageFragmentRenderer: FragmentStub,
          MessageActions: ActionsStub,
          CitationPopup: CitationStub,
        },
        provide: {
          [routerKey]: { push: vi.fn() },
        },
      },
    });

    expect(wrapper.find('[data-testid="fragment-renderer"]').text()).toBe('回答内容');
    expect(wrapper.find('[data-testid="actions"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="citation"]').exists()).toBe(true);
    expect(wrapper.findComponent({ name: 'MarkdownRenderer' }).exists()).toBe(false);
  });
});
