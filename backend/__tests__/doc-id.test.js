import { describe, it, expect } from 'vitest';

const { deriveDocId, DOC_ID_SCHEME } = require('../src/utils/doc-id');

/**
 * docId 必须确定性派生：评测数据集硬编码了文档 ID，随机 ID 意味着
 * 换台机器重新入库就对不上，指标无法被他人复现。
 */
describe('deriveDocId（确定性文档 ID）', () => {
  it('同输入永远同输出', () => {
    const a = deriveDocId('武汉理工大学校园资料手册', '学校概况');
    const b = deriveDocId('武汉理工大学校园资料手册', '学校概况');
    expect(a).toBe(b);
  });

  it('标题或类别任一不同即不同 ID', () => {
    const base = deriveDocId('图书馆使用指南', '学校概况');
    expect(deriveDocId('图书馆使用指南', '专业课程')).not.toBe(base);
    expect(deriveDocId('图书馆使用指南（修订）', '学校概况')).not.toBe(base);
  });

  it('保留 doc_ 前缀，与既有存储键与 point ID 约定兼容', () => {
    const id = deriveDocId('任意标题', 'general');
    expect(id.startsWith('doc_')).toBe(true);
    expect(id).toMatch(/^doc_[0-9a-f]{32}$/);
  });

  it('标题首尾空白不影响结果（入库前会被 trim）', () => {
    expect(deriveDocId('  图书馆使用指南  ', '学校概况')).toBe(deriveDocId('图书馆使用指南', '学校概况'));
  });

  it('类别缺省按 general 处理，与 document.service 的默认值一致', () => {
    expect(deriveDocId('标题')).toBe(deriveDocId('标题', 'general'));
    expect(deriveDocId('标题', null)).toBe(deriveDocId('标题', 'general'));
  });

  it('ID 方案名写死在常量里，便于清单与文档引用同一说法', () => {
    expect(DOC_ID_SCHEME).toContain('sha256');
  });
});
