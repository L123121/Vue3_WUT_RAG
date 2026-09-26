import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';

const { createSpeechHandler } = require('../src/controllers/audio.controller');
const { operationalMetrics } = require('../src/services/observability/operational-metrics.service');

function createResponse() {
  const response = new EventEmitter();
  response.destroyed = false;
  response.setHeader = vi.fn();
  response.send = vi.fn();
  return response;
}

describe('audio.controller', () => {
  afterEach(() => vi.restoreAllMocks());

  it('客户端断开时把取消信号传给语音服务', async () => {
    let receivedSignal;
    const service = {
      synthesize: vi.fn((_text, options) => {
        receivedSignal = options.signal;
        return new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () => {
            const error = new Error('Aborted');
            error.name = 'AbortError';
            reject(error);
          }, { once: true });
        });
      }),
    };
    const request = new EventEmitter();
    request.body = { text: '正在生成的语音' };
    const response = createResponse();
    const next = vi.fn();

    const pending = createSpeechHandler(service)(request, response, next);
    request.emit('aborted');
    await pending;

    expect(receivedSignal.aborted).toBe(true);
    expect(next).not.toHaveBeenCalled();
    expect(response.send).not.toHaveBeenCalled();
  });

  it('返回缓存命中状态', async () => {
    const recordUsage = vi.spyOn(operationalMetrics, 'recordTtsUsage').mockImplementation(() => {});
    const service = {
      synthesize: vi.fn().mockResolvedValue({
        buffer: Buffer.from([1]),
        contentType: 'audio/mpeg',
        format: 'mp3',
        model: 'stepaudio-2.5-tts',
        characters: 4,
        cacheHit: true,
      }),
    };
    const request = new EventEmitter();
    request.body = { text: '缓存语音' };
    const response = createResponse();

    await createSpeechHandler(service)(request, response, vi.fn());

    expect(response.setHeader).toHaveBeenCalledWith('X-Audio-Cache', 'HIT');
    expect(response.send).toHaveBeenCalledWith(Buffer.from([1]));
    expect(recordUsage).not.toHaveBeenCalled();
  });

  it('只对真实模型调用记录 TTS 成本', async () => {
    const recordUsage = vi.spyOn(operationalMetrics, 'recordTtsUsage').mockImplementation(() => {});
    const service = {
      synthesize: vi.fn().mockResolvedValue({
        buffer: Buffer.from([2]),
        contentType: 'audio/mpeg',
        format: 'mp3',
        model: 'stepaudio-2.5-tts',
        characters: 6,
        cacheHit: false,
      }),
    };
    const request = new EventEmitter();
    request.body = { text: '真实模型调用' };
    request.traceId = 'trace-audio';
    const response = createResponse();

    await createSpeechHandler(service)(request, response, vi.fn());

    expect(recordUsage).toHaveBeenCalledWith(expect.objectContaining({
      model: 'stepaudio-2.5-tts',
      characters: 6,
      traceId: 'trace-audio',
    }));
  });
});
