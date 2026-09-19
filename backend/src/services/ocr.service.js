"use strict";

/**
 * OCR / 视觉识别服务
 *
 * 解决两类数据接入：
 * 1. 扫描件 PDF：pdf-parse 提取不到文本层 → 用 mupdf 逐页渲染成图片 → 视觉模型识别
 * 2. 图片（含表格截图）：直接交给多模态模型 → 输出结构化 Markdown（表格→Markdown 表格）
 *
 * 视觉模型：StepFun step-1o-turbo-vision（OpenAI 兼容 image_url 格式）
 * - detail=low  ~169 token/图（默认，扫描件文本提取够用）
 * - detail=high 按图片大小计费（表格等细节场景才用）
 *
 * 成本闸门：OCR_ENABLED 总开关、OCR_MAX_PAGES 页数上限、页级并发上限
 * mupdf 1.28 为 ESM-only，CommonJS 中用动态 import() 懒加载，加载失败仅告警不崩。
 */

const config = require('../config');
const { request } = require('../utils/httpClient');
const { logEvent } = require('./observability.service');

class OcrService {
  constructor() {
    this.enabled = config.ocr.enabled;
    this.model = config.ocr.model;
    this.detail = config.ocr.detail;
    this.maxPages = config.ocr.maxPages;
    this.concurrency = config.ocr.concurrency;
    this._mupdfPromise = null; // 懒加载 mupdf
  }

  /**
   * 加载 mupdf（ESM 动态导入，单例）
   */
  _loadMupdf() {
    if (!this._mupdfPromise) {
      this._mupdfPromise = import('mupdf').catch((err) => {
        logEvent('warn', 'ocr_mupdf_load_failed', { message: 'mupdf 加载失败，扫描件 OCR 不可用', error: err.message });
        this._mupdfPromise = null; // 允许下次重试
        throw err;
      });
    }
    return this._mupdfPromise;
  }

  /**
   * 单张图片 → 结构化 Markdown 文本（表格 → Markdown 表格）
   * @param {Buffer|Uint8Array} imageBuffer 图片二进制
   * @param {string} [mimeType='image/png'] 图片 MIME 类型
   * @param {Object} [opts] { detail, timeout }
   * @returns {Promise<string>} 识别出的 Markdown 文本
   */
  async recognizeImage(imageBuffer, mimeType = 'image/png', opts = {}) {
    if (!this.enabled) {
      throw new Error('OCR 未启用（OCR_ENABLED=false）');
    }
    if (!config.ai.apiKey) {
      throw new Error('OCR 需要 AI_API_KEY');
    }

    const detail = opts.detail || this.detail;
    const base64 = Buffer.from(imageBuffer).toString('base64');
    const dataUrl = `data:${mimeType};base64,${base64}`;

    const body = JSON.stringify({
      model: this.model,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: '请识别图片中的所有文字内容并转换为 Markdown：\n' +
                '1. 表格必须用 Markdown 表格语法输出（保留行列结构与表头）；\n' +
                '2. 标题保留层级（#/##/###）；\n' +
                '3. 只输出识别结果，不要任何解释、前言或总结。',
            },
            {
              type: 'image_url',
              image_url: { url: dataUrl, detail },
            },
          ],
        },
      ],
      max_tokens: 4096,
      temperature: 0,
      stream: false,
    });

    const options = this._buildOptions('/v2/chat/completions', body.length, opts.timeout);
    const start = Date.now();
    const result = await request(options, body);
    const content = result.data?.choices?.[0]?.message?.content || '';

    if (!content) {
      logEvent('warn', 'ocr_empty_content', { message: '视觉模型返回空内容' });
      return '';
    }
    logEvent('info', 'ocr_image_done', { chars: content.length, detail, latencyMs: Date.now() - start });
    return content.trim();
  }

  /**
   * PDF → 逐页渲染 → 视觉模型识别为 Markdown
   *
   * 用途：
   * 1. 扫描件 PDF（无文本层）：默认识别全部页
   * 2. 文本型 PDF 表格页重建（opts.pages）：只识别指定的页索引（0-based），
   *    复用视觉模型保留 Markdown 表格结构，成本只花在命中页
   *
   * @param {string} filePath PDF 路径
   * @param {Object} [opts] { maxPages, concurrency, pages, returnMap }
   *   - pages: number[] 只识别这些页（0-based，越界忽略）；缺省识别全部
   *   - returnMap: true 时返回 [{ pageIndex, text }]，否则返回拼接的 Markdown 文本
   */
  async ocrPdf(filePath, opts = {}) {
    if (!this.enabled) {
      throw new Error('OCR 未启用（OCR_ENABLED=false）');
    }
    const mupdf = await this._loadMupdf();
    const fs = require('fs');
    const buffer = await fs.promises.readFile(filePath);

    const doc = mupdf.Document.openDocument(buffer, 'application/pdf');
    const totalPages = doc.countPages();
    const maxPages = Math.min(totalPages, opts.maxPages || this.maxPages);

    // 页选择：默认全部页；opts.pages 指定页索引（去重、越界忽略、升序）
    const targets = Array.isArray(opts.pages) && opts.pages.length > 0
      ? [...new Set(opts.pages)].filter((p) => p >= 0 && p < maxPages).sort((a, b) => a - b)
      : Array.from({ length: maxPages }, (_, i) => i);

    logEvent('info', 'ocr_pdf_start', { totalPages, pages: targets.length });

    // 并发识别：渲染快、识别慢，页级并发控制成本与限流
    const concurrency = Math.min(opts.concurrency || this.concurrency, targets.length);
    const results = new Array(targets.length);
    let nextIdx = 0;

    const worker = async () => {
      while (nextIdx < targets.length) {
        const pos = nextIdx++;
        const pageIndex = targets[pos];
        try {
          const page = doc.loadPage(pageIndex);
          const pixmap = page.toPixmap(
            mupdf.Matrix.scale(2, 2),       // 2x 渲染，兼顾清晰度与 token 成本
            mupdf.ColorSpace.DeviceRGB,
            false,
          );
          const png = pixmap.asPNG();
          const text = await this.recognizeImage(png, 'image/png', opts);
          results[pos] = { pageIndex, text };
        } catch (err) {
          logEvent('warn', 'ocr_page_failed', { page: pageIndex + 1, error: err.message });
          results[pos] = { pageIndex, text: '' };
        }
      }
    };

    await Promise.all(Array.from({ length: concurrency }, worker));
    doc.destroy();

    const valid = results.filter((r) => r.text && r.text.trim().length > 0);

    if (opts.returnMap) {
      return valid;
    }

    return valid
      .map((r) => `## 第 ${r.pageIndex + 1} 页\n\n${r.text}`)
      .join('\n\n---\n\n');
  }

  /**
   * 构建 OpenAI 兼容请求选项（与 ai.service 同构，复用共享 httpClient）
   */
  _buildOptions(path, bodyLength, timeout) {
    const baseUrl = config.ai.baseUrl || 'https://api.stepfun.com/v1';
    // baseUrl 已含 /v1 时，剥离路径中的版本号前缀（与 ai.service._buildOptions 一致）
    let finalPath = path;
    const baseHasVersion = baseUrl.match(/\/v\d+$/);
    if (baseHasVersion) {
      finalPath = path.replace(/^\/v\d+/, '');
    }
    const urlObj = new URL(baseUrl + finalPath);
    return {
      hostname: urlObj.hostname,
      port: urlObj.port || 443,
      path: urlObj.pathname + urlObj.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Authorization': `Bearer ${config.ai.apiKey}`,
        'Content-Length': bodyLength,
      },
      timeout: timeout || 90000,
    };
  }
}

module.exports = { OcrService };
