import { describe, it, expect } from 'vitest';

function getFollowups() {
  delete require.cache[require.resolve('../src/services/rag/rag-followups.service')];
  return require('../src/services/rag/rag-followups.service').buildFollowups;
}

describe('rag-followups 追问建议生成（零 LLM 成本）', () => {
  const buildFollowups = getFollowups();

  const chunks = [
    { parentText: '图书馆服务指南\n一、开放时间\n工作日8:00-22:00\n二、借阅规则\n本科生可借20册' },
    { parentText: '校车班次说明\n### 校园巴士路线\n焕然校区往返南湖' },
  ];
  const sources = [
    { title: '图书馆使用指南', category: '校园服务' },
    { title: '校园交通出行指南', category: '学校概况' },
  ];

  it('从父段落章节标题生成「详细讲讲xxx」', () => {
    const items = buildFollowups({ sources, chunks, question: '图书馆几点开门？' });
    expect(items.length).toBeGreaterThan(0);
    expect(items[0].from).toBe('heading');
    expect(items.some((i) => i.text.includes('详细讲讲'))).toBe(true);
  });

  it('与问题重叠度高的标题被排除（本次已覆盖的主题不再推荐）', () => {
    const items = buildFollowups({
      sources,
      chunks: [{ parentText: '一、图书馆开放时间\n工作日8点开门' }],
      question: '图书馆开放时间是什么时候？',
    });
    // 唯一候选标题与问题高度重叠 → 只剩文档标题兜底
    expect(items.every((i) => !i.text.includes('开放时间'))).toBe(true);
  });

  it('无标题候选时退回引用文档标题「《title》讲了什么？」', () => {
    const items = buildFollowups({
      sources: [{ title: '校园交通出行指南' }],
      chunks: [{ parentText: '没有任何标题形态的普通段落内容。' }],
      question: '校车几点发车？',
    });
    expect(items).toContainEqual(expect.objectContaining({ from: 'doc', text: '《校园交通出行指南》讲了什么？' }));
  });

  it('去重且不超过 max 条', () => {
    const items = buildFollowups({ sources: [{ title: '同一标题' }, { title: '同一标题' }], chunks: [], question: '任意' }, 3);
    const texts = items.map((i) => i.text);
    expect(new Set(texts).size).toBe(texts.length);
    expect(items.length).toBeLessThanOrEqual(3);
  });

  it('停用词标题（目录/参考文献等）与过短内容被过滤', () => {
    const items = buildFollowups({
      sources: [{ title: '目录' }],
      chunks: [{ parentText: '一、目录\n第二章 参考文献' }],
      question: '论文格式要求',
    });
    expect(items.every((i) => !/目录|参考文献/.test(i.text.replace('详细讲讲', '')))).toBe(true);
  });

  it('空输入返回空数组不抛错', () => {
    expect(buildFollowups({})).toEqual([]);
    expect(buildFollowups({ sources: null, chunks: null, question: '' })).toEqual([]);
  });
});
