import { describe, it, expect } from 'vitest';

const {
  checkGrounding,
  splitAnswerSentences,
  supportScore,
} = require('../src/services/rag/grounding.service');

describe('grounding.service', () => {
  const CONTEXT = [
    '【文档 1】校园手册（段落 1）',
    '武汉理工大学有 200 个学生社团，覆盖学术科技、文化艺术、体育健身等多个类别。',
    '学校共有 10 个食堂，其中南湖校区 3 个。',
    '========================================',
    '【文档 2】保研指南（段落 2）',
    '推免生需要满足前三年绩点排名位于专业前 20%，且通过英语六级。',
  ].join('\n');

  it('完全基于上下文的回答 → coverage 高，level=high', () => {
    const answer = '武汉理工大学有 200 个学生社团，覆盖多个类别。学校共有 10 个食堂。';
    const result = checkGrounding(answer, CONTEXT);
    expect(result).not.toBeNull();
    expect(result.level).toBe('high');
    expect(result.coverage).toBeGreaterThanOrEqual(0.85);
    expect(result.unsupportedCount).toBe(0);
  });

  it('编造内容的句子会被标记为未溯源', () => {
    const answer = '武汉理工大学有 200 个学生社团。学校在火星设有分校，每年招收三万名外星学生。';
    const result = checkGrounding(answer, CONTEXT);
    expect(result.unsupportedCount).toBeGreaterThan(0);
    expect(result.unsupportedSentences[0].text).toContain('火星');
    expect(result.level).not.toBe('high');
  });

  it('客套话/元话语不计入未溯源（避免误杀）', () => {
    const answer = '根据文档的内容，学校共有 10 个食堂。希望以上内容对你有帮助！如有其他问题欢迎继续提问。';
    const result = checkGrounding(answer, CONTEXT);
    expect(result.totalSentences).toBe(1); // 客套句被过滤，"根据文档…"句含实际陈述保留
    expect(result.supportedCount).toBe(1);
  });

  it('代码块内容不参与溯源判断', () => {
    const answer = `武汉理工大学有 200 个学生社团。\n\n\`\`\`\nconst x = completely_random_gibberish_12345;\n\`\`\``;
    const result = checkGrounding(answer, CONTEXT);
    expect(result.totalSentences).toBe(1);
  });

  it('无上下文或空回答返回 null', () => {
    expect(checkGrounding('', CONTEXT)).toBeNull();
    expect(checkGrounding('回答', '')).toBeNull();
    expect(checkGrounding(null, CONTEXT)).toBeNull();
  });

  it('enabled=false 返回 null', () => {
    expect(checkGrounding('学校有 10 个食堂。', CONTEXT, { enabled: false })).toBeNull();
  });

  it('minSupport 可调：提高阈值会让部分改写句被判未溯源', () => {
    // 改写句：主体与上下文一致，尾部带少量发挥（"管理非常出色"不在上下文）
    const answer = '学校的学生社团覆盖学术科技等多个类别，日常管理非常出色。';
    const lenient = checkGrounding(answer, CONTEXT, { minSupport: 0.15 });
    const strict = checkGrounding(answer, CONTEXT, { minSupport: 0.95 });
    expect(lenient.supportedCount).toBe(1);
    expect(strict.unsupportedCount).toBe(1);
  });

  it('splitAnswerSentences 过滤过短句和列表标记', () => {
    const sentences = splitAnswerSentences('# 标题\n- **重点一**：这是一个足够长的句子。\n好的\n这是第二个完整的句子内容！');
    expect(sentences.length).toBe(2);
    expect(sentences[0]).toContain('重点一');
  });

  it('supportScore：完全一致得 1 分，无关内容接近 0', () => {
    const ctx = charSetOfContext();
    expect(supportScore(new Set(['食堂']), ctx)).toBe(1);
    const unrelated = supportScore(bigramsOf('量子纠缠实验'), charSetOfContext());
    expect(unrelated).toBeLessThan(0.2);
  });
});

function bigramsOf(text) {
  const normalized = String(text || '').toLowerCase().replace(/\s+/g, '');
  const grams = new Set();
  for (let i = 0; i < normalized.length - 1; i++) grams.add(normalized.slice(i, i + 2));
  return grams;
}

function charSetOfContext() {
  return new Set([
    ...bigramsOf('武汉理工大学有200个学生社团，覆盖学术科技、文化艺术、体育健身等多个类别。学校共有10个食堂，其中南湖校区3个。'),
  ]);
}
