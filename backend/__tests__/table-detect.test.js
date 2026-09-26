import { describe, it, expect, vi, afterEach } from 'vitest';

/**
 * 文本型 PDF 表格页检测 + 按页 OCR 重建的纯函数单测
 *
 * - detectTablePages / isTableLikePage / replaceTablePages 为纯函数，直接加载模块即可
 * - config 开关测试沿用 ocr.service.test.js 的模式：
 *   vi.stubEnv + vi.resetModules + delete require.cache + 动态 import
 *   （vitest 4 中 vi.mock 对 CJS require 链路不生效）
 */
import { detectTablePages, isTableLikePage, replaceTablePages } from '../src/services/knowledge/file-upload.service';

describe('detectTablePages 表格页检测', () => {
  it('无分页符（无法定位页）时返回空数组', () => {
    expect(detectTablePages('纯文本\n没有表格\n不应误判')).toEqual([]);
  });

  it('检测到含 Markdown 竖线表格的页', () => {
    const text = [
      '第一页正文内容，没有表格。\n第一页第二行。',
      '| 序号 | 名称 | 数量 |\n| --- | --- | --- |\n| 1 | 一食堂 | 3 |\n| 2 | 二食堂 | 5 |',
      '最后一页纯文字。',
    ].join('\f');
    expect(detectTablePages(text)).toEqual([1]);
  });

  it('检测到 ASCII 表格（+---+ 分隔符行）', () => {
    const text = [
      '页一',
      '名称    数量\n+------+-----+\n一食堂    3\n二食堂    5\n+------+-----+',
      '页三',
    ].join('\f');
    expect(detectTablePages(text)).toEqual([1]);
  });

  it('检测到列对齐表格（多字段行 + 表头关键词）', () => {
    const text = [
      '顶部说明。',
      '序号    名称    金额\n1      一食堂    120\n2      二食堂    80\n3      图书馆    50\n4      体育场    30',
      '结尾',
    ].join('\f');
    expect(detectTablePages(text)).toEqual([1]);
  });

  it('纯文本页不误报', () => {
    const text = [
      '这是一段普通正文。\n今天天气很好，适合去图书馆学习。',
      '第二页也是普通文字描述，没有表格结构。',
    ].join('\f');
    expect(detectTablePages(text)).toEqual([]);
  });
});

describe('isTableLikePage 单页判断', () => {
  it('竖线行 ≥3 判为表格', () => {
    expect(isTableLikePage('a | b\n---\n1 | 2\n3 | 4')).toBe(true);
  });

  it('普通正文不判为表格', () => {
    expect(isTableLikePage('这是普通段落\n今天天气很好\n我们一起去学习')).toBe(false);
  });
});

describe('replaceTablePages 按页替换', () => {
  it('将命中页替换为 OCR 结果，其余页保留', () => {
    const text = ['页一内容', '表格页原文', '页三内容'].join('\f');
    const out = replaceTablePages(text, [
      { pageIndex: 1, text: '| 序号 | 名称 |\n| --- | --- |\n| 1 | 一食堂 |' },
    ]);
    const pages = out.split('\f');
    expect(pages[0]).toBe('页一内容');
    expect(pages[1]).toContain('| 序号 | 名称 |');
    expect(pages[2]).toBe('页三内容');
  });

  it('越界页索引被忽略，不影响其余页', () => {
    const text = ['页一', '页二'].join('\f');
    const out = replaceTablePages(text, [{ pageIndex: 5, text: 'x' }]);
    expect(out).toBe(text);
  });

  it('空 OCR 结果不替换', () => {
    const text = 'a\fb';
    expect(replaceTablePages(text, [{ pageIndex: 0, text: '   ' }])).toBe(text);
  });
});

describe('OCR_TABLE_ENABLED 配置开关', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  async function loadConfig() {
    vi.resetModules();
    // 清掉 CJS require.cache：config 为原生 require 加载，否则重载仍拿到旧配置
    delete require.cache[require.resolve('../src/config')];
    const mod = await import('../src/config');
    return mod.default || mod;
  }

  it('默认开启', async () => {
    vi.stubEnv('OCR_TABLE_ENABLED', '');
    const config = await loadConfig();
    expect(config.ocr.tableOcrEnabled).toBe(true);
  });

  it('OCR_TABLE_ENABLED=false 可关闭', async () => {
    vi.stubEnv('OCR_TABLE_ENABLED', 'false');
    const config = await loadConfig();
    expect(config.ocr.tableOcrEnabled).toBe(false);
  });
});
