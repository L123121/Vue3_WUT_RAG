import { describe, it, expect, afterAll } from 'vitest';

// 防止 config 在测试中生成/复用随机管理员密码文件
process.env.ADMIN_USERNAME = 'admin';
process.env.ADMIN_PASSWORD = 'test-admin-password-123';

const fs = require('fs');
const os = require('os');
const path = require('path');
const JSZip = require('jszip');

/**
 * file-upload.service 安全面与解析分发测试
 *
 * 重点覆盖两条此前无回归保护的路径:
 * 1. isAllowedUpload — 扩展名 + MIME 双白名单(上传安全的第一道闸)
 * 2. parseFile 分发 — .doc 明确报错、文本解析、JSZip 现场构造 PPTX 的真实解析
 */

const {
  parseFile,
  cleanupFile,
  isAllowedUpload,
} = require('../src/services/knowledge/file-upload.service');

const tmpDirs = [];
const makeTempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-upload-test-'));
  tmpDirs.push(dir);
  return dir;
};

afterAll(() => {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('isAllowedUpload(扩展名 + MIME 双白名单)', () => {
  const file = (name, mimetype) => ({ originalname: name, mimetype });

  it.each([
    ['report.pdf', 'application/pdf'],
    ['doc.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ['doc.docx', 'application/octet-stream'],
    ['notes.txt', 'text/plain'],
    ['README.MD', 'text/markdown'],
  ])('放行合法文档: %s + %s', (name, mimetype) => {
    expect(isAllowedUpload(file(name, mimetype))).toBe(true);
  });

  it('扩展名大小写不敏感', () => {
    expect(isAllowedUpload(file('REPORT.PDF', 'application/pdf'))).toBe(true);
  });

  it.each([
    ['payload.exe', 'application/octet-stream', '可执行扩展名'],
    ['shell.php', 'application/x-php', '脚本扩展名'],
    ['page.html', 'text/html', 'HTML 扩展名'],
    ['report.pdf', 'text/html', 'PDF 扩展名配 HTML MIME(伪装)'],
    ['doc.docx', 'text/html', 'DOCX 扩展名配 HTML MIME(伪装)'],
    ['notes.txt', 'application/javascript', 'TXT 配脚本 MIME'],
  ])('拒绝危险或伪装组合: %s + %s (%s)', (name, mimetype) => {
    expect(isAllowedUpload(file(name, mimetype))).toBe(false);
  });

  it('文档上传默认拒绝图片扩展名', () => {
    expect(isAllowedUpload(file('pic.png', 'image/png'))).toBe(false);
  });

  it('聊天上传(includeImages)放行图片', () => {
    expect(isAllowedUpload(file('pic.png', 'image/png'), true)).toBe(true);
    expect(isAllowedUpload(file('pic.jpg', 'image/jpeg'), true)).toBe(true);
    expect(isAllowedUpload(file('pic.png', 'application/octet-stream'), true)).toBe(false);
  });

  it('MIME 大小写不敏感', () => {
    expect(isAllowedUpload(file('a.pdf', 'APPLICATION/PDF'))).toBe(true);
  });

  it('恶意文件名只影响扩展名提取,不产生路径穿越面', () => {
    // multer 存储名由服务端生成,originalname 只取扩展名
    expect(path.extname('../../etc/evil.pdf').toLowerCase()).toBe('.pdf');
    expect(isAllowedUpload(file('../../etc/evil.pdf', 'application/pdf'))).toBe(true);
    expect(isAllowedUpload(file('..\\..\\evil.exe', 'application/pdf'))).toBe(false);
  });
});

describe('parseFile 分发', () => {
  it('旧版 .doc 给出明确指引而不是解析报错', async () => {
    await expect(parseFile('whatever.doc', 'legacy.doc'))
      .rejects.toThrow('另存为 .docx');
  });

  it('未知扩展名直接拒绝', async () => {
    await expect(parseFile('evil.exe', 'evil.exe'))
      .rejects.toThrow('不支持的文件类型');
  });

  it('解析 txt/md 为 UTF-8 文本', async () => {
    const dir = makeTempDir();
    const filePath = path.join(dir, 'note.md');
    fs.writeFileSync(filePath, '# 标题\n\n正文内容', 'utf-8');

    await expect(parseFile(filePath, 'note.md')).resolves.toBe('# 标题\n\n正文内容');
  });

  it('解析 JSZip 现场构造的 PPTX:按页序输出且解码 XML 实体', async () => {
    const dir = makeTempDir();
    const filePath = path.join(dir, 'slides.pptx');

    const slideXml = (texts) =>
      `<?xml version="1.0"?><p:sld xmlns:p="p" xmlns:a="a"><p:txBody>` +
      texts.map((t) => `<a:t>${t}</a:t>`).join('') +
      `</p:txBody></p:sld>`;

    const zip = new JSZip();
    zip.file('ppt/slides/slide1.xml', slideXml(['第一页 &amp; 标题', '副标题']));
    zip.file('ppt/slides/slide2.xml', slideXml(['第二页']));
    zip.file('ppt/slides/slide10.xml', slideXml(['第十页']));
    // 非法命名文件应被过滤,不参与页序
    zip.file('ppt/slides/slideX.xml', slideXml(['无效页']));
    zip.file('ppt/media/image1.png', Buffer.alloc(4));
    fs.writeFileSync(filePath, await zip.generateAsync({ type: 'nodebuffer' }));

    const markdown = await parseFile(filePath, 'slides.pptx');

    expect(markdown).toContain('## 第 1 页');
    expect(markdown).toContain('第一页 & 标题');
    expect(markdown.indexOf('第 1 页')).toBeLessThan(markdown.indexOf('第 2 页'));
    expect(markdown.indexOf('第 2 页')).toBeLessThan(markdown.indexOf('第 10 页'));
    expect(markdown).not.toContain('无效页');
  });
});

describe('cleanupFile', () => {
  it('删除存在的文件,不存在的路径静默通过', () => {
    const dir = makeTempDir();
    const filePath = path.join(dir, 'temp-upload.txt');
    fs.writeFileSync(filePath, 'x');

    cleanupFile(filePath);
    expect(fs.existsSync(filePath)).toBe(false);

    expect(() => cleanupFile(path.join(dir, 'already-gone.txt'))).not.toThrow();
  });
});
