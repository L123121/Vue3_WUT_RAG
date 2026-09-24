"use strict";

const fs = require('fs');
const path = require('path');
const { AsyncLocalStorage } = require('async_hooks');
const multer = require('multer');
const mammoth = require('mammoth');
const JSZip = require('jszip');
const TurndownService = require('turndown');
const { gfm } = require('turndown-plugin-gfm');
const config = require('../config');
// OCR 服务懒加载（mupdf 为 ESM 动态导入，require 本身无副作用）
const { OcrService } = require('./ocr.service');
const { logEvent } = require('./observability.service');
const ocrService = new OcrService();

// 延迟加载 pdf-parse（可能在新版本中有兼容性问题）
let pdfParse = null;
try {
  pdfParse = require('pdf-parse');
} catch (e) {
  logEvent('warn', 'file_upload_pdfparse_load_failed', { message: 'pdf-parse 加载失败，PDF 解析功能不可用', error: e.message });
}

// 配置文件上传
const uploadDir = path.join(__dirname, '../../uploads');
// 媒体附件目录（图片等）
const mediaDir = path.join(__dirname, '../../media');

const DOCUMENT_EXTENSIONS = new Set(['.pdf', '.docx', '.doc', '.pptx', '.txt', '.md']);
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);
const MIME_TYPES_BY_EXTENSION = {
  '.pdf': new Set(['application/pdf']),
  '.docx': new Set([
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/zip',
    'application/octet-stream',
  ]),
  '.doc': new Set(['application/msword', 'application/octet-stream']),
  '.pptx': new Set([
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/zip',
    'application/octet-stream',
  ]),
  '.txt': new Set(['text/plain', 'application/octet-stream']),
  '.md': new Set(['text/markdown', 'text/plain', 'application/octet-stream']),
  '.jpg': new Set(['image/jpeg']),
  '.jpeg': new Set(['image/jpeg']),
  '.png': new Set(['image/png']),
  '.gif': new Set(['image/gif']),
  '.webp': new Set(['image/webp']),
};

// ==================== Turndown（HTML → Markdown） ====================

const turndownService = new TurndownService({
  headingStyle: 'atx',       // ## 标题
  codeBlockStyle: 'fenced',  // ```code```
  emDelimiter: '*',          // *斜体*
  strongDelimiter: '**',     // **加粗**
  bulletListMarker: '-',
});

// 启用 GFM 插件（表格、任务列表等）
turndownService.use(gfm);

// 自定义图片处理：提取并保存 base64 图片
turndownService.addRule('image', {
  filter: 'img',
  replacement: (content, node) => {
    const src = node.getAttribute('src') || '';
    const alt = node.getAttribute('alt') || '图片';

    // base64 图片：保存到 media 目录并替换路径
    if (src.startsWith('data:')) {
      const filename = saveBase64Image(src, alt);
      return `\n![${alt}](media/${filename})\n`;
    }

    // 普通 URL 图片
    return `\n![${alt}](${src})\n`;
  },
});

// 确保 media 目录存在
if (!fs.existsSync(mediaDir)) {
  fs.mkdirSync(mediaDir, { recursive: true });
}

/**
 * 单次 DOCX 解析的图片计数上下文。
 * 旧实现用模块级 `_imageCounter` 做差值统计本次保存的图片数，但
 * turndownService 是模块级单例，多个 parseDocx 并发时会共享同一计数器，
 * 导致 savedImages = _imageCounter - counterBefore 把对方保存的图片也算进来。
 * 改为 AsyncLocalStorage：每次 parseDocx 在自己的 store({ count: 0 }) 里
 * 递增，互不串扰。计数器仅用于统计，不参与文件名生成（文件名用时间戳+随机）。
 */
const docxImageContext = new AsyncLocalStorage();

/**
 * 保存 base64 图片到 media 目录
 * @param {string} dataUri - data:image/png;base64,...
 * @param {string} alt - 图片描述
 * @returns {string} 文件名
 */
function saveBase64Image(dataUri, _alt) {
  // 仅统计本次解析保存的图片数；未运行在 parseDocx 上下文时（理论不会发生）则跳过
  const store = docxImageContext.getStore();
  if (store) store.count++;
  const match = dataUri.match(/^data:image\/(\w+);base64,(.+)$/);
  // 文件名用时间戳+随机后缀保证唯一
  const rand = Math.random().toString(36).slice(2, 8);
  if (!match) return `image-${Date.now()}-${rand}.png`;

  const ext = match[1] === 'jpeg' ? 'jpg' : match[1];
  const data = Buffer.from(match[2], 'base64');
  const filename = `img-${Date.now()}-${rand}.${ext}`;
  const filePath = path.join(mediaDir, filename);

  try {
    fs.writeFileSync(filePath, data);
    logEvent('info', 'file_upload_image_saved', { filename, bytes: data.length });
  } catch (err) {
    logEvent('warn', 'file_upload_image_save_failed', { error: err.message });
  }

  return filename;
}

function isAllowedUpload(file, includeImages = false) {
  const ext = path.extname(file.originalname).toLowerCase();
  const allowedExtensions = includeImages
    ? new Set([...DOCUMENT_EXTENSIONS, ...IMAGE_EXTENSIONS])
    : DOCUMENT_EXTENSIONS;

  if (!allowedExtensions.has(ext)) return false;

  const allowedMimeTypes = MIME_TYPES_BY_EXTENSION[ext];
  const mimetype = String(file.mimetype || '').toLowerCase();
  return !!allowedMimeTypes && allowedMimeTypes.has(mimetype);
}

// 确保上传目录存在
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// multer 配置
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const timestamp = Date.now();
    const random = Math.round(Math.random() * 1E9);
    cb(null, `upload-${timestamp}-${random}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB
  },
  fileFilter: (req, file, cb) => {
    cb(null, isAllowedUpload(file));
  }
});

// 聊天文件上传（允许图片 + 文档）
const chatUpload = multer({
  storage,
  limits: {
    fileSize: 20 * 1024 * 1024 // 20MB
  },
  fileFilter: (req, file, cb) => {
    cb(null, isAllowedUpload(file, true));
  }
});

/**
 * 解析文件内容
 */
async function parseFile(filePath, originalName) {
  const ext = path.extname(originalName).toLowerCase();

  switch (ext) {
    case '.pdf':
      return parsePDF(filePath);

    case '.docx':
      return parseDocx(filePath);

    case '.doc':
      // mammoth 仅支持 .docx；旧版二进制 .doc 直接明确报错，避免解析失败后误判
      throw new Error('暂不支持旧版 .doc 格式，请将文档另存为 .docx 后重试');

    case '.pptx':
      return parsePptx(filePath);

    case '.txt':
    case '.md':
      return parseText(filePath);

    case '.jpg':
    case '.jpeg':
    case '.png':
    case '.gif':
    case '.webp':
      return parseImage(filePath, ext);

    default:
      throw new Error(`不支持的文件类型: ${ext}`);
  }
}

// ==================== 表格页检测（文本层启发式，零成本） ====================

// 表头常见关键词（辅助判断：多字段行 + 表头词 → 强信号）
const TABLE_HEADER_KEYWORDS = [
  '序号', '名称', '数量', '金额', '价格', '单价', '日期', '姓名', '学号',
  '电话', '部门', '项目', '备注', '合计', '成绩', '编号', '型号', '规格',
];

/**
 * 文本型 PDF 表格页检测（纯启发式，零 API 成本）
 *
 * 背景：pdf-parse 对表格只输出纯文本流，行列结构丢失。这里在文本层上做廉价
 * 检测，命中页交给视觉模型按页 OCR 重建 Markdown 表格（复用 ocr.service.js）。
 *
 * @param {string} text pdf-parse 提取的全文（页间以 \f 分页符分隔）
 * @returns {number[]} 疑似表格页的 0-based 页索引数组
 */
function detectTablePages(text) {
  const pages = String(text || '').split('\f');
  // 无分页符（无法定位页）或单页：不做按页 OCR，避免整本误伤
  if (pages.length <= 1) return [];
  const hits = [];
  pages.forEach((pageText, i) => {
    if (isTableLikePage(pageText)) hits.push(i);
  });
  return hits;
}

/**
 * 单页表格特征判断（任一强信号命中即判为表格页）
 * 信号：① | 竖线密度 ② ASCII 表格分隔符 ③ 列对齐（多字段行）④ 表头关键词
 */
function isTableLikePage(pageText) {
  const lines = String(pageText || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length < 3) return false;

  let pipeLines = 0; // 含 | 的行数
  let separatorLines = 0; // ASCII 表格分隔符行（---- / +---+ / ====）
  let headerHintLines = 0; // 含表头关键词且字段数 ≥2 的行数
  const fieldCountMap = new Map(); // 字段数 → 出现次数（列对齐信号）

  for (const line of lines) {
    if (line.includes('|')) pipeLines++;
    // ASCII 表格分隔符：去空格后全是 + - = | 且长度 ≥ 4
    const compact = line.replace(/ /g, '');
    if (/^[+\-=|]+$/.test(compact) && compact.length >= 4) separatorLines++;

    // 按 2+ 连续空格切分字段（列对齐场景，如 "姓名    学号    电话"）
    const fields = line.split(/\s{2,}/).filter(Boolean);
    if (fields.length >= 2) {
      fieldCountMap.set(fields.length, (fieldCountMap.get(fields.length) || 0) + 1);
      if (TABLE_HEADER_KEYWORDS.some((kw) => line.includes(kw))) headerHintLines++;
    }
  }

  const totalMultiField = [...fieldCountMap.values()].reduce((a, b) => a + b, 0);

  // 信号①：Markdown/CSV 竖线表格
  if (pipeLines >= 3) return true;
  // 信号②：ASCII 表格（分隔符行 ≥2 且存在多字段行）
  if (separatorLines >= 2 && totalMultiField >= 3) return true;
  // 信号③：列对齐（同一字段数出现 ≥4 次且多字段总行数 ≥5）
  if ([...fieldCountMap.values()].some((n) => n >= 4) && totalMultiField >= 5) return true;
  // 信号④：表头关键词 + 多字段行 ≥2 行
  if (headerHintLines >= 2 && totalMultiField >= 4) return true;
  return false;
}

/**
 * 将视觉模型 OCR 结果按页替换回 pdf-parse 原文（页间以 \f 分隔）
 * @param {string} text pdf-parse 原文
 * @param {Array<{pageIndex:number, text:string}>} ocrResults 按页 OCR 结果
 * @returns {string} 替换后的全文
 */
function replaceTablePages(text, ocrResults) {
  const pages = String(text || '').split('\f');
  for (const { pageIndex, text: pageText } of ocrResults) {
    if (pageIndex >= 0 && pageIndex < pages.length && pageText && pageText.trim().length > 0) {
      // 整页替换：视觉模型输出包含整页 Markdown（含重建后的表格结构）
      pages[pageIndex] = pageText.trim();
    }
  }
  return pages.join('\f');
}

/**
 * 解析 PDF 文件
 * 优先 pdf-parse 提取文本层；提取文本过短（如扫描件无文本层）时，
 * 自动降级到视觉模型 OCR（mupdf 渲染逐页识别）。
 */
async function parsePDF(filePath) {
  const minChars = config.ocr.pdfMinChars;
  let text = '';

  // 第一步：pdf-parse 文本层提取（免费、快）
  if (pdfParse) {
    try {
      const dataBuffer = await fs.promises.readFile(filePath);
      const data = await pdfParse(dataBuffer);
      text = data.text || '';
    } catch (err) {
      logEvent('warn', 'file_upload_pdf_extract_failed', { error: err.message });
    }
  }

  // 第二步：文本过短 → 判定为扫描件 → OCR 兜底
  if (text.trim().length < minChars) {
    if (!ocrService.enabled) {
      if (pdfParse) return text;
      throw new Error('PDF 解析功能不可用，请检查 pdf-parse 安装');
    }
    logEvent('info', 'file_upload_scanned_pdf_detected', { textChars: text.trim().length, message: 'PDF 文本层过短，判定为扫描件，转 OCR 识别' });
    try {
      const ocrText = await ocrService.ocrPdf(filePath);
      if (ocrText && ocrText.trim().length > 0) {
        // 前置说明，标注识别来源，便于排查
        return `> 📄 该 PDF 为扫描件，已通过视觉模型 OCR 识别\n\n${ocrText}`;
      }
    } catch (err) {
      logEvent('warn', 'file_upload_scanned_ocr_failed', { error: err.message });
    }
    return text;
  }

  // 第三步：文本型 PDF 表格页重建（2026-08-13）
  // pdf-parse 对表格只输出纯文本流（行列结构丢失），此处检测疑似表格页，
  // 按页渲染走视觉模型重建 Markdown 表格（复用扫描件 OCR 基建，成本仅命中页）。
  // 关闭（OCR_TABLE_ENABLED=false）或检测失败时回退原文，不阻塞入库。
  if (config.ocr.tableOcrEnabled && ocrService.enabled) {
    try {
      const tablePages = detectTablePages(text);
      if (tablePages.length > 0) {
        logEvent('info', 'file_upload_table_pages_detected', {
          count: tablePages.length,
          pageNumbers: tablePages.map((p) => p + 1).join(','),
        });
        const ocrResults = await ocrService.ocrPdf(filePath, {
          pages: tablePages,
          returnMap: true,
        });
        if (ocrResults.length > 0) {
          text = replaceTablePages(text, ocrResults);
        }
      }
    } catch (err) {
      logEvent('warn', 'file_upload_table_ocr_failed_fallback', { error: err.message });
    }
  }

  return text;
}

/**
 * 解析图片文件（表格截图等）→ 视觉模型识别为 Markdown
 */
async function parseImage(filePath, ext) {
  const mimeTypes = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
  };
  if (!ocrService.enabled) {
    throw new Error('图片识别未启用（OCR_ENABLED=false）');
  }
  const buffer = await fs.promises.readFile(filePath);
  const text = await ocrService.recognizeImage(buffer, mimeTypes[ext] || 'image/png');
  if (!text || text.trim().length === 0) {
    throw new Error('图片识别结果为空');
  }
  return text;
}

/**
 * 解析 DOCX 文件（增强版：保留表格、提取图片、标注公式）
 *
 * 处理策略：
 * - 表格 → Markdown 表格语法（行列结构完整保留）
 * - 图片 → 提取 base64 存为文件，替换为 ![描述](media/文件名)
 * - 公式 → mammoth 不直接支持 Office Math，尝试提取原始 XML 中的公式文本
 */
async function parseDocx(filePath) {
  // 本次解析的图片计数容器；saveBase64Image 在 ALS 上下文内递增它，
  // 并发解析各自独立，互不串扰（详见 docxImageContext 注释）。
  const imageStore = { count: 0 };

  // 第一步：用 convertToHtml 保留表格和图片（图片保存发生在下面 turndown 阶段，
  // 不在 mammoth 内，故 mammoth 调用本身不需要 ALS 上下文）
  const { value: html, messages } = await mammoth.convertToHtml({
    path: filePath,
  });

  // 统计 mammoth 报告的消息
  const warningMsgs = messages || [];
  const imageCount = warningMsgs.filter(m => m.type === 'warning' && /image|picture/i.test(m.message)).length;

  // 第二步：提取公式（Office Math）
  const formulas = await extractDocxFormulas(filePath);

  // 第三步：HTML → Markdown。turndown 的 image rule 会调 saveBase64Image，
  // 必须在 ALS 上下文内执行，该解析保存的图片才会计入 imageStore.count。
  const markdown = docxImageContext.run(imageStore, () => turndownService.turndown(html));

  // 第四步：在顶部添加摘要
  const notes = [];
  const savedImages = imageStore.count; // 本次解析实际保存的图片数
  if (imageCount > 0 || savedImages > 0) {
    const totalImages = Math.max(imageCount, savedImages);
    notes.push(`> 📷 本文档包含 ${totalImages} 张图片，已保存至附件目录 (media/)`);
  }
  if (formulas.length > 0) {
    // 在对应位置插入公式文本
    notes.push(`> 📐 本文档包含 ${formulas.length} 个公式`);
  }

  const header = notes.length > 0 ? notes.join('\n') + '\n\n' : '';

  // 第五步：追加公式文本（如果有）
  let formulaAppendix = '';
  if (formulas.length > 0) {
    formulaAppendix = '\n\n---\n### 公式列表\n\n' +
      formulas.map((f, i) => `公式 ${i + 1}：${f}`).join('\n\n');
  }

  return header + markdown + formulaAppendix;
}

/**
 * 从 DOCX 中提取 Office Math（公式）文本
 * DOCX 本质是 ZIP，OMML 存储在 word/document.xml 中的 <m:oMath> 元素
 */
async function extractDocxFormulas(filePath) {
  try {
    const fileBuffer = await fs.promises.readFile(filePath);
    const archive = await JSZip.loadAsync(fileBuffer);
    const docFile = archive.files['word/document.xml'];
    if (!docFile) return [];

    const xml = await docFile.async('text');
    const formulas = [];

    // 匹配 <m:oMath>...</m:oMath> 块
    const mathBlocks = [...xml.matchAll(/<m:oMath(?:\s[^>]*)?>([\s\S]*?)<\/m:oMath>/g)];

    for (const [, inner] of mathBlocks) {
      // 提取所有 <m:t> 标签内的文本（OMML 的文本元素）
      const textParts = [...inner.matchAll(/<m:t[^>]*>([\s\S]*?)<\/m:t>/g)];
      const text = textParts
        .map(m => decodeXmlText(m[1]))
        .filter(Boolean)
        .join('');

      if (text) {
        formulas.push(text);
      }
    }

    return formulas;
  } catch (err) {
    logEvent('warn', 'file_upload_formula_extract_failed', { error: err.message });
    return [];
  }
}

async function parsePptx(filePath) {
  const fileBuffer = await fs.promises.readFile(filePath);
  const archive = await JSZip.loadAsync(fileBuffer);
  const slideFiles = Object.values(archive.files)
    .filter(file => /^ppt\/slides\/slide\d+\.xml$/.test(file.name))
    .sort((left, right) => getPptxPartIndex(left.name) - getPptxPartIndex(right.name));

  const slideTexts = [];
  for (const slideFile of slideFiles) {
    const xml = await slideFile.async('text');
    const text = extractPptxXmlText(xml);
    if (text) {
      slideTexts.push(`## 第 ${getPptxPartIndex(slideFile.name)} 页\n\n${text}`);
    }
  }

  return slideTexts.join('\n\n---\n\n');
}

function getPptxPartIndex(name) {
  const match = name.match(/(slide|notesSlide)(\d+)\.xml$/);
  return match ? Number(match[2]) : Number.MAX_SAFE_INTEGER;
}

function extractPptxXmlText(xml) {
  const matches = [...String(xml || '').matchAll(/<a:t[^>]*>([\s\S]*?)<\/a:t>/g)];
  return matches
    .map(match => decodeXmlText(match[1]))
    .filter(Boolean)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function decodeXmlText(text) {
  return String(text || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 解析文本文件
 */
async function parseText(filePath) {
  return fs.promises.readFile(filePath, 'utf-8');
}

/**
 * 清理上传的文件
 */
function cleanupFile(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (error) {
    logEvent('warn', 'file_upload_cleanup_file_failed', { error: error.message });
  }
}

// ==================== 上传目录定期清理 ====================
// 聊天上传的文件由 attachment.service 记录用户/会话归属并设置 TTL；
// RAG 文档上传解析后即 cleanupFile 删除。此任务定期清除残留文件和元数据。

const UPLOADS_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 天
const UPLOADS_CLEAN_INTERVAL_MS = 24 * 60 * 60 * 1000; // 每天一次

function cleanOldUploads() {
  try {
    if (!fs.existsSync(uploadDir)) return;
    const now = Date.now();
    let removed = 0;
    for (const name of fs.readdirSync(uploadDir)) {
      const fullPath = path.join(uploadDir, name);
      try {
        const stat = fs.statSync(fullPath);
        if (stat.isFile() && now - stat.mtimeMs > UPLOADS_MAX_AGE_MS) {
          fs.unlinkSync(fullPath);
          removed++;
        }
      } catch (err) {
        logEvent('warn', 'file_upload_cleanup_entry_failed', { file: name, error: err.message });
      }
    }
    if (removed > 0) logEvent('info', 'file_upload_cleanup_done', { removed });
    void require('./attachment.service').attachmentService.cleanupExpired()
      .then((metadataRemoved) => {
        if (metadataRemoved > 0) logEvent('info', 'attachment_metadata_cleanup_done', { removed: metadataRemoved });
      })
      .catch((error) => logEvent('warn', 'attachment_metadata_cleanup_failed', { error: error.message }));
  } catch (error) {
    logEvent('warn', 'file_upload_cleanup_failed', { error: error.message });
  }
}

/**
 * 启动上传目录定期清理（启动时立即执行一次，之后每天执行）
 */
function startUploadsCleanup() {
  cleanOldUploads();
  const timer = setInterval(cleanOldUploads, UPLOADS_CLEAN_INTERVAL_MS);
  timer.unref();
  return timer;
}

module.exports = {
  upload,
  chatUpload,
  parseFile,
  cleanupFile,
  isAllowedUpload,
  detectTablePages,
  isTableLikePage,
  replaceTablePages,
  startUploadsCleanup,
};
