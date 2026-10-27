import { describe, it, expect, vi, afterEach } from 'vitest';

/**
 * OCR 服务单测：降级路径（不调用真实 API / 不读真实凭证）
 *
 * ⚠️ vitest 4 中 vi.mock 对 CJS require 链路不生效（ESM import 生效、CJS require 不生效），
 * 且 ocr.service 内部通过 CJS require 读 config——直接改 ESM 侧 config 实例无效。
 * 因此这里用 vi.stubEnv + vi.resetModules + delete require.cache + 动态 import，
 * 让服务在受控环境变量下重建（首次求值后 config 会被 require.cache 缓存，必须手动清除）：
 * 1. OCR_ENABLED=false → recognizeImage / ocrPdf 抛错（调用方降级，不发请求）
 * 2. AI_API_KEY 为空 → recognizeImage 抛错（调用方降级，不发请求）
 * 3. detail 默认 low（可用 OCR_DETAIL 覆盖）
 */
async function loadOcrService() {
  vi.resetModules();
  // 清掉 CJS require.cache：config 与 ocr.service 均为原生 require 加载，
  // 否则第二次 stub 环境变量后重载仍拿到首次求值时的旧配置
  delete require.cache[require.resolve('../src/config')];
  delete require.cache[require.resolve('../src/services/media/ocr.service')];
  const mod = await import('../src/services/media/ocr.service');
  return mod.OcrService;
}

describe('OcrService 降级路径', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('OCR 未启用时 recognizeImage 抛错，不发起请求', async () => {
    vi.stubEnv('OCR_ENABLED', 'false');
    vi.stubEnv('AI_API_KEY', 'test-key');
    const OcrService = await loadOcrService();
    const svc = new OcrService();
    await expect(svc.recognizeImage(Buffer.from('x'), 'image/png')).rejects.toThrow('OCR 未启用');
  });

  it('无 AI_API_KEY 时 recognizeImage 抛错，不发起请求', async () => {
    vi.stubEnv('OCR_ENABLED', 'true');
    vi.stubEnv('AI_API_KEY', '');
    const OcrService = await loadOcrService();
    const svc = new OcrService();
    await expect(svc.recognizeImage(Buffer.from('x'), 'image/png')).rejects.toThrow('AI_API_KEY');
  });

  it('OCR 未启用时 ocrPdf 抛错，不加载 mupdf', async () => {
    vi.stubEnv('OCR_ENABLED', 'false');
    const OcrService = await loadOcrService();
    const svc = new OcrService();
    await expect(svc.ocrPdf('/nonexistent.pdf')).rejects.toThrow('OCR 未启用');
  });

  it('detail 配置默认 low，可用 OCR_DETAIL 覆盖', async () => {
    vi.stubEnv('OCR_ENABLED', 'true');
    vi.stubEnv('AI_API_KEY', 'test-key');
    vi.stubEnv('OCR_DETAIL', '');
    let OcrService = await loadOcrService();
    expect(new OcrService().detail).toBe('low');

    vi.stubEnv('OCR_DETAIL', 'high');
    OcrService = await loadOcrService();
    expect(new OcrService().detail).toBe('high');
  });

  it('Content-Length 按 UTF-8 字节数计算（中文提示词不被截断）', async () => {
    // 回归：曾用 body.length（UTF-16 码元）当 Content-Length，中文提示词比字节数短，
    // 请求体被截断 → 上游报 "Body is not valid JSON"，OCR 图片识别全部失败。
    const httpClient = require('../src/utils/httpClient');
    const originalRequest = httpClient.request;
    let captured = null;
    httpClient.request = async (options, body) => {
      captured = { options, body };
      return { data: { choices: [{ message: { content: '## ok' } }] } };
    };

    try {
      vi.stubEnv('OCR_ENABLED', 'true');
      vi.stubEnv('AI_API_KEY', 'test-key');
      vi.stubEnv('OCR_BASE_URL', 'https://vision.test/v1');
      const OcrService = await loadOcrService();
      const svc = new OcrService();
      await expect(svc.recognizeImage(Buffer.from('x'), 'image/png')).resolves.toBe('## ok');
    } finally {
      httpClient.request = originalRequest;
    }

    const byteLength = Buffer.byteLength(captured.body, 'utf8');
    expect(captured.options.headers['Content-Length']).toBe(byteLength);
    // 中文提示词：字节数必须大于字符数，否则说明又退回按字符计数
    expect(byteLength).toBeGreaterThan(captured.body.length);
    // 端点版本前缀只保留一份（/v1 + /chat/completions）
    expect(captured.options.path).toBe('/v1/chat/completions');
  });

  it('OCR 可独立指定 Provider，未配置时回退 ai.*', async () => {
    vi.stubEnv('OCR_ENABLED', 'true');
    vi.stubEnv('AI_API_KEY', 'test-key');
    vi.stubEnv('AI_BASE_URL', 'https://chat.test/v1');
    vi.stubEnv('OCR_BASE_URL', '');
    vi.stubEnv('OCR_API_KEY', '');
    let OcrService = await loadOcrService();
    expect(new OcrService().baseUrl).toBe('https://chat.test/v1');

    vi.stubEnv('OCR_BASE_URL', 'https://vision.test/v1');
    vi.stubEnv('OCR_API_KEY', 'vision-key');
    OcrService = await loadOcrService();
    const svc = new OcrService();
    expect(svc.baseUrl).toBe('https://vision.test/v1');
    expect(svc.apiKey).toBe('vision-key');
  });
});
