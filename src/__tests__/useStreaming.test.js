import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';

// useStreaming 是全项目最复杂的状态机(SSE 流式),此前零测试——1ff55b9 的
// views 渲染事故正发生在这种盲区。本文件锁定六个核心不变量:
// 收敛唯一性 / RAF 合并 / 活动型超时 / 重试清理 / 后台 Tab 冲刷 / 会话切换中止。

vi.mock('../api/chat.js', () => ({
  sendMessageStream: vi.fn(),
  connectionManager: {
    subscribe: vi.fn(() => () => {}),
    isConnected: true,
  },
}));

import { sendMessageStream } from '../api/chat.js';
import { useConversationStore } from '../stores/conversation.store.js';
import { useStreaming } from '../composables/useStreaming.js';

// 取最近一次 sendMessageStream 收到的 callbacks(第三参数)
const capturedCallbacks = () => vi.mocked(sendMessageStream).mock.calls.at(-1)?.[2];
const capturedOptions = () => vi.mocked(sendMessageStream).mock.calls.at(-1)?.[3];

const modelMessage = (store) =>
  store.conversations[0].messages.find((m) => m.role === 'model');
// AI 消息初始只有 content 字段,text 在首次流式写入时才创建
const msgText = (store) => modelMessage(store)?.text ?? '';

const setVisibility = (state) => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
};

describe('useStreaming 状态机', () => {
  let wrapper;
  let api;

  const setup = () => {
    // 组件内 useStreaming 与测试代码必须共用同一个 pinia 实例,
    // 否则消息会写进组件内新建的空 store,测试读到的是另一份状态
    const pinia = createPinia();
    setActivePinia(pinia);
    const store = useConversationStore();
    store.conversations.push(
      { id: 'conv1', title: '测试会话', messages: [], createdAt: '', updatedAt: '' },
      { id: 'conv2', title: '另一会话', messages: [], createdAt: '', updatedAt: '' },
    );
    store.currentConversationId = 'conv1';

    const Host = {
      setup() {
        api = useStreaming();
        return () => null;
      },
    };
    wrapper = mount(Host, { global: { plugins: [pinia] } });
    return useConversationStore();
  };

  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
    vi.clearAllMocks();
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame'],
    });
    setVisibility('visible');
  });

  afterEach(() => {
    wrapper?.unmount();
    wrapper = null;
    vi.useRealTimers();
    setVisibility('visible');
  });

  it('chunk 经 RAF 合并:同帧多次到达只写一次,完成后剩余内容立即落盘', async () => {
    const store = setup();
    const promise = api.sendMessage('你好');
    const cb = capturedCallbacks();

    cb.onChunk('a');
    cb.onChunk('b');
    cb.onChunk('c');
    // 帧未执行:内容在 pendingContent 中,消息尚未写入
    expect(msgText(store)).toBe('');

    vi.advanceTimersToNextFrame();
    expect(msgText(store)).toBe('abc');

    // 帧后再来一个 chunk,未及渲染就收尾:onDone 必须冲刷,不能丢字
    cb.onChunk('d');
    cb.onDone();
    await promise;

    expect(msgText(store)).toBe('abcd');
    expect(api.isLoading.value).toBe(false);
    expect(api.currentStreamingId.value).toBeNull();
  });

  it('onRetry 清空已写入的半截内容,重发后不出现"半截+完整"拼接', async () => {
    const store = setup();
    const promise = api.sendMessage('你好');
    const cb = capturedCallbacks();

    cb.onChunk('hel');
    vi.advanceTimersToNextFrame();
    expect(msgText(store)).toBe('hel');

    cb.onRetry();
    expect(msgText(store)).toBe('');
    expect(api.isReconnecting.value).toBe(true);
    expect(api.reconnectAttempt.value).toBe(1);

    // 重试从头流式输出完整内容
    cb.onChunk('hello');
    vi.advanceTimersToNextFrame();
    expect(msgText(store)).toBe('hello');

    cb.onDone();
    await promise;
    expect(msgText(store)).toBe('hello');
  });

  it('onDone 后再次触发 onError 不会二次收敛(resolved 唯一性)', async () => {
    const store = setup();
    const promise = api.sendMessage('你好');
    const cb = capturedCallbacks();

    cb.onChunk('最终内容');
    cb.onDone();
    await promise;
    expect(msgText(store)).toBe('最终内容');
    expect(modelMessage(store).isError).toBeUndefined();

    // 迟到的错误回调:状态已 resolved,不应改写消息或复活 isLoading
    cb.onError(new Error('late failure'));
    expect(msgText(store)).toBe('最终内容');
    expect(modelMessage(store).isError).toBeUndefined();
    expect(api.isLoading.value).toBe(false);
  });

  it('切换会话后旧流被中止:pending 冲刷一次,后续 chunk 不再写入', async () => {
    const store = setup();
    const promise = api.sendMessage('你好');
    const cb = capturedCallbacks();

    cb.onChunk('前半');
    // 用户切到另一个会话
    store.currentConversationId = 'conv2';
    cb.onChunk('后半');

    expect(capturedOptions().signal.aborted).toBe(true);
    expect(api.isLoading.value).toBe(false);
    // 中止前 pendingContent('前半')被冲刷保住,'后半'不再写入
    vi.advanceTimersToNextFrame();
    expect(msgText(store)).toBe('前半');

    cb.onAbort();
    await promise;
  });

  it('后台 Tab(hidden)时 pendingContent 立即冲刷,不等 RAF', async () => {
    const store = setup();
    const promise = api.sendMessage('你好');
    const cb = capturedCallbacks();

    cb.onChunk('后台内容');
    expect(msgText(store)).toBe('');

    setVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));

    expect(msgText(store)).toBe('后台内容');

    setVisibility('visible');
    cb.onDone();
    await promise;
  });

  it('旧 run 的迟到回调不会清空新 run 的状态或写入新消息', async () => {
    const store = setup();
    const firstPromise = api.sendMessage('第一问');
    const firstCallbacks = capturedCallbacks();
    const firstOptions = capturedOptions();

    expect(firstOptions.streamVersion).toBe(1);
    expect(firstOptions.runId).toMatch(/^run_/);
    api.abortCurrentRequest();
    expect(api.isLoading.value).toBe(false);

    const secondPromise = api.sendMessage('第二问');
    const secondCallbacks = capturedCallbacks();
    const secondOptions = capturedOptions();
    expect(secondOptions.runId).not.toBe(firstOptions.runId);

    // 旧请求随后迟到：只能结束自己的 Promise，不能改动第二次运行。
    firstCallbacks.onChunk('旧回答');
    firstCallbacks.onDone();

    secondCallbacks.onEvent({
      v: 1,
      runId: secondOptions.runId,
      attempt: 0,
      seq: 1,
      type: 'run.started',
      traceId: 'trace_second',
      data: {},
    });
    secondCallbacks.onEvent({
      v: 1,
      runId: secondOptions.runId,
      attempt: 0,
      seq: 2,
      type: 'message.delta',
      traceId: 'trace_second',
      data: { content: '新回答', decision: false },
    });
    vi.advanceTimersToNextFrame();
    secondCallbacks.onEvent({
      v: 1,
      runId: secondOptions.runId,
      attempt: 0,
      seq: 3,
      type: 'run.completed',
      traceId: 'trace_second',
      data: {},
    });

    await Promise.all([firstPromise, secondPromise]);
    const modelMessages = store.conversations[0].messages.filter((message) => message.role === 'model');
    expect(modelMessages[0].text || '').toBe('');
    expect(modelMessages[1].text).toBe('新回答');
    expect(api.isLoading.value).toBe(false);
    expect(api.activeRunId.value).toBeNull();
  });

  it('流无活动超过安全阈值时 reject 并中止请求;持续活动则不误杀', async () => {
    setup();
    const promise = api.sendMessage('你好');
    const cb = capturedCallbacks();

    // 每 30s 一个 chunk(慢但健康):安全超时(65s)持续被重置,不该触发
    for (let i = 0; i < 3; i += 1) {
      vi.advanceTimersByTime(30000);
      cb.onChunk(`chunk-${i}`);
      vi.advanceTimersToNextFrame();
    }
    expect(api.isLoading.value).toBe(true);

    // 此后彻底静默:超过 65s 活动型超时触发
    vi.advanceTimersByTime(66000);
    await expect(promise).rejects.toThrow('响应超时');
    expect(capturedOptions().signal.aborted).toBe(true);
  });
});
