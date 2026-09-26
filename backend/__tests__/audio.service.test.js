import { describe, expect, it, vi } from 'vitest';

const { AudioService, normalizeSpeechText } = require('../src/services/media/audio.service');

describe('audio.service', () => {
  it('将 Markdown 回答转换成适合朗读的纯文本', () => {
    const text = normalizeSpeechText('# 标题\n- 查看[培养方案](https://example.com)\n```js\nalert(1)\n```');

    expect(text).toBe('标题 查看培养方案 代码内容已省略。');
  });

  it('调用 StepFun TTS 并返回音频 Buffer', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => 'audio/mpeg' },
      arrayBuffer: async () => Uint8Array.from([1, 2, 3]).buffer,
    });
    const service = new AudioService({
      fetch: fetchMock,
      config: {
        apiKey: 'test-key',
        baseUrl: 'https://api.stepfun.com/v1',
        model: 'stepaudio-2.5-tts',
        voice: 'cixingnansheng',
        responseFormat: 'mp3',
        speed: 1,
        instruction: '自然亲切',
        timeout: 1000,
        maxInputLength: 1000,
      },
    });

    const result = await service.synthesize('你好，欢迎使用武理小精灵。');

    expect(result.buffer).toEqual(Buffer.from([1, 2, 3]));
    expect(result.characters).toBe('你好，欢迎使用武理小精灵。'.length);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.stepfun.com/v1/audio/speech',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer test-key' }),
      }),
    );
    const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(requestBody).toMatchObject({
      model: 'stepaudio-2.5-tts',
      voice: 'cixingnansheng',
      instruction: '自然亲切',
    });
  });

  it('将上游额度耗尽映射为可识别的客户端错误', async () => {
    const service = new AudioService({
      fetch: vi.fn().mockResolvedValue({
        ok: false,
        status: 402,
        text: async () => JSON.stringify({ error: { type: 'quota_exceeded' } }),
      }),
      config: {
        apiKey: 'test-key',
        baseUrl: 'https://api.stepfun.com/v1',
        model: 'stepaudio-2.5-tts',
        voice: 'cixingnansheng',
        responseFormat: 'mp3',
        speed: 1,
        timeout: 1000,
        maxInputLength: 1000,
      },
    });

    await expect(service.synthesize('测试朗读')).rejects.toMatchObject({
      statusCode: 402,
      code: 'TTS_QUOTA_EXCEEDED',
    });
  });

  it('缓存相同配置与文本的语音结果', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => 'audio/mpeg' },
      arrayBuffer: async () => Uint8Array.from([4, 5, 6]).buffer,
    });
    const service = new AudioService({
      fetch: fetchMock,
      config: {
        apiKey: 'test-key',
        baseUrl: 'https://api.stepfun.com/v1',
        model: 'stepaudio-2.5-tts',
        voice: 'cixingnansheng',
        responseFormat: 'mp3',
        speed: 1,
        instruction: '自然亲切',
        timeout: 1000,
        maxInputLength: 1000,
        cacheTtlMs: 60000,
        cacheMaxEntries: 10,
        cacheMaxBytes: 1024,
      },
    });

    const first = await service.synthesize('重复朗读内容');
    const second = await service.synthesize('重复朗读内容');

    expect(first.cacheHit).toBe(false);
    expect(second.cacheHit).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('合并同时发生的相同语音请求并只标记一次实际调用', async () => {
    let resolveResponse;
    const fetchMock = vi.fn(() => new Promise((resolve) => {
      resolveResponse = resolve;
    }));
    const service = new AudioService({
      fetch: fetchMock,
      config: {
        apiKey: 'test-key',
        baseUrl: 'https://api.stepfun.com/v1',
        model: 'stepaudio-2.5-tts',
        voice: 'cixingnansheng',
        responseFormat: 'mp3',
        speed: 1,
        instruction: '',
        timeout: 1000,
        maxInputLength: 1000,
        maxAudioBytes: 1024,
        cacheEnabled: true,
      },
    });

    const firstRequest = service.synthesize('并发朗读内容');
    const secondRequest = service.synthesize('并发朗读内容');

    expect(fetchMock).toHaveBeenCalledOnce();
    resolveResponse({
      ok: true,
      headers: { get: () => 'audio/mpeg' },
      arrayBuffer: async () => Uint8Array.from([7, 8, 9]).buffer,
    });

    const results = await Promise.all([firstRequest, secondRequest]);
    expect(results.map((result) => result.cacheHit).sort()).toEqual([false, true]);
    expect(results[0].buffer).toEqual(results[1].buffer);
  });

  it('单个调用方取消时不会中断仍有消费者的共享请求', async () => {
    let providerSignal;
    let resolveResponse;
    const fetchMock = vi.fn((_url, options) => {
      providerSignal = options.signal;
      return new Promise((resolve) => {
        resolveResponse = resolve;
      });
    });
    const service = new AudioService({
      fetch: fetchMock,
      config: {
        apiKey: 'test-key',
        baseUrl: 'https://api.stepfun.com/v1',
        model: 'stepaudio-2.5-tts',
        voice: 'cixingnansheng',
        responseFormat: 'mp3',
        speed: 1,
        instruction: '',
        timeout: 1000,
        maxInputLength: 1000,
        maxAudioBytes: 1024,
      },
    });
    const controller = new AbortController();

    const cancelledRequest = service.synthesize('共享朗读内容', { signal: controller.signal });
    const activeRequest = service.synthesize('共享朗读内容');
    controller.abort();

    await expect(cancelledRequest).rejects.toMatchObject({ name: 'AbortError' });
    expect(providerSignal.aborted).toBe(false);

    resolveResponse({
      ok: true,
      headers: { get: () => 'audio/mpeg' },
      arrayBuffer: async () => Uint8Array.from([10, 11]).buffer,
    });
    await expect(activeRequest).resolves.toMatchObject({ cacheHit: false });
  });

  it('读取响应体期间仍受超时控制', async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn((_url, options) => Promise.resolve({
        ok: true,
        headers: { get: () => 'audio/mpeg' },
        arrayBuffer: () => new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () => {
            const error = new Error('Aborted');
            error.name = 'AbortError';
            reject(error);
          }, { once: true });
        }),
      }));
      const service = new AudioService({
        fetch: fetchMock,
        config: {
          apiKey: 'test-key',
          baseUrl: 'https://api.stepfun.com/v1',
          model: 'stepaudio-2.5-tts',
          voice: 'cixingnansheng',
          responseFormat: 'mp3',
          speed: 1,
          instruction: '',
          timeout: 20,
          maxInputLength: 1000,
          maxAudioBytes: 1024,
        },
      });

      const request = service.synthesize('响应体超时');
      const rejection = expect(request).rejects.toMatchObject({ statusCode: 504 });
      await vi.advanceTimersByTimeAsync(25);

      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });

  it('在读取前拒绝超过大小上限的音频响应', async () => {
    const arrayBuffer = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: {
        get: (name) => name === 'content-length' ? '2048' : 'audio/mpeg',
      },
      arrayBuffer,
    });
    const service = new AudioService({
      fetch: fetchMock,
      config: {
        apiKey: 'test-key',
        baseUrl: 'https://api.stepfun.com/v1',
        model: 'stepaudio-2.5-tts',
        voice: 'cixingnansheng',
        responseFormat: 'mp3',
        speed: 1,
        instruction: '',
        timeout: 1000,
        maxInputLength: 1000,
        maxAudioBytes: 1024,
      },
    });

    await expect(service.synthesize('过大的音频')).rejects.toMatchObject({ statusCode: 502 });
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it('外部取消信号会终止正在进行的模型请求', async () => {
    const fetchMock = vi.fn((_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        const error = new Error('Aborted');
        error.name = 'AbortError';
        reject(error);
      }, { once: true });
    }));
    const service = new AudioService({
      fetch: fetchMock,
      config: {
        apiKey: 'test-key',
        baseUrl: 'https://api.stepfun.com/v1',
        model: 'stepaudio-2.5-tts',
        voice: 'cixingnansheng',
        responseFormat: 'mp3',
        speed: 1,
        instruction: '',
        timeout: 10000,
        maxInputLength: 1000,
      },
    });
    const controller = new AbortController();

    const request = service.synthesize('取消这次朗读', { signal: controller.signal });
    controller.abort();

    await expect(request).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('拒绝超过单次模型限制的文本', async () => {
    const service = new AudioService({
      fetch: vi.fn(),
      config: {
        apiKey: 'test-key',
        maxInputLength: 5,
      },
    });

    await expect(service.synthesize('超过五个字符')).rejects.toMatchObject({ statusCode: 400 });
  });
});
