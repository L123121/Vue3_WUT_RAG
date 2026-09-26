import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * MMR 去重 + 自动类别过滤单元测试
 * 覆盖：
 * 1. _charBigrams / _jaccardBigrams 相似度
 * 2. _mmrDedupe 剔除与已选父段高度相似的冗余段落
 * 3. _inferDocCategory 按关键词自动推断文档类别（低置信返回 null）
 * 4. _mmrDedupe 在 mmrEnabled=false 时原样返回
 */
function getRagService() {
  delete require.cache[require.resolve('../src/config')];
  delete require.cache[require.resolve('../src/services/rag/rag.service')];
  return require('../src/services/rag/rag.service').RagService;
}

// 构造带 _rerankScore 和 parentText 的父段候选（docId 用于同文档内去重判定）
const parent = (id, text, score, docId = 'doc-same') => ({
  id,
  parentText: text,
  bestChunk: { score, text },
  _rerankScore: score,
  docId,
});

describe('RagService 相似度', () => {
  let RagService;
  let rag;

  beforeEach(() => {
    vi.clearAllMocks();
    RagService = getRagService();
    rag = new RagService({ getCompletion: vi.fn() });
  });

  it('字符 bigram 集合与 Jaccard 相似度', () => {
    expect(rag._charBigrams('')).toEqual(new Set());
    expect(rag._charBigrams('学校')).toEqual(new Set(['学校']));
    // 相同文本相似度为 1
    const a = rag._charBigrams('武汉理工大学校训是厚德博学');
    const b = rag._charBigrams('武汉理工大学校训是厚德博学');
    expect(rag._jaccardBigrams(a, b)).toBe(1);
    // 完全无关文本相似度为 0
    const c = rag._charBigrams('图书馆开放时间为八点到十点');
    expect(rag._jaccardBigrams(a, c)).toBeLessThan(0.3);
  });
});

describe('RagService._mmrDedupe', () => {
  let RagService;
  let rag;

  beforeEach(() => {
    vi.clearAllMocks();
    RagService = getRagService();
    rag = new RagService({ getCompletion: vi.fn() });
  });

  it('空数组/单候选原样返回', () => {
    expect(rag._mmrDedupe([], 10)).toEqual([]);
    const single = [parent('p1', '内容', 0.9)];
    expect(rag._mmrDedupe(single, 10)).toEqual(single);
  });

  it('高度相似的重复父段被剔除，保留多样来源', () => {
    const candidates = [
      parent('p1', '武汉理工大学校训是厚德博学、追求卓越，学校坐落于武汉市洪山区。', 0.95),
      // 与 p1 近乎相同的重复段落（仅标点差异）
      parent('p2', '武汉理工大学校训是厚德博学追求卓越，学校坐落于武汉市洪山区', 0.94),
      parent('p3', '图书馆开放时间为周一至周日八点到晚十点，节假日另行通知。', 0.85),
    ];
    const result = rag._mmrDedupe(candidates, 3);
    const ids = result.map(c => c.id);
    // p1 与 p2 高度相似（bigram Jaccard ≥ mmrMaxSim 0.85），只能保留其一
    expect(ids).toContain('p1');
    expect(ids).toContain('p3');
    expect(ids).not.toContain('p2');
  });

  it('跨文档高度相似不剔除（保留第二个相关文档）', () => {
    // doc_9a78 与 doc_4dcd 内容几乎相同（bigram Jaccard = 1.0），但属于不同文档，
    // 相似度剔除仅限同 docId 内，两个都应保留（2026-08-09 回归修复）
    const candidates = [
      parent('p1', '武汉理工大学\nWUHAN UNIVERSITY OF TECHNOLOGY\n校园', 0.95, 'doc_9a78'),
      parent('p2', '武汉理工大学\nWUHAN UNIVERSITY OF TECHNOLOGY\n校园', 0.94, 'doc_4dcd'),
    ];
    const result = rag._mmrDedupe(candidates, 3);
    const ids = result.map(c => c.id);
    expect(ids).toContain('p1');
    expect(ids).toContain('p2');
    expect(result).toHaveLength(2);
  });

  it('mmrMaxSim=1 时不去重（阈值放宽到完全一致才算冗余）', () => {
    rag.mmrMaxSim = 1.0;
    const candidates = [
      parent('p1', '武汉理工大学校训是厚德博学追求卓越。', 0.95),
      parent('p2', '武汉理工大学校训厚德博学追求卓越。', 0.94),
    ];
    const result = rag._mmrDedupe(candidates, 2);
    expect(result).toHaveLength(2);
  });

  it('mmrEnabled=false 时原样返回（不触发去重）', () => {
    rag.mmrEnabled = false;
    const candidates = [
      parent('p1', '武汉理工大学校训是厚德博学追求卓越。', 0.95),
      parent('p2', '武汉理工大学校训厚德博学追求卓越。', 0.94),
    ];
    const result = rag._mmrDedupe(candidates, 2);
    expect(result).toHaveLength(2);
  });

  it('maxCount 限制输出数量', () => {
    const candidates = [
      parent('p1', '武汉理工大学校训是厚德博学追求卓越。', 0.95),
      parent('p2', '图书馆开放时间为早八点到晚十点。', 0.90),
      parent('p3', '食堂共两层，提供各地风味美食。', 0.85),
    ];
    const result = rag._mmrDedupe(candidates, 2);
    expect(result).toHaveLength(2);
  });
});

describe('RagService._inferDocCategory', () => {
  let RagService;
  let rag;

  beforeEach(() => {
    vi.clearAllMocks();
    RagService = getRagService();
    rag = new RagService({ getCompletion: vi.fn() });
  });

  it('命中 ≥2 个类别关键词时推断对应类别', () => {
    expect(rag._inferDocCategory('武汉理工大学校训是什么，食堂在哪里')).toBe('学校概况');
    expect(rag._inferDocCategory('离散数学课程的复习重点和考试范围')).toBe('专业课程');
    expect(rag._inferDocCategory('面试刷题怎么准备，面经和算法题')).toBe('面试刷题');
    expect(rag._inferDocCategory('RAG 大模型智能体怎么学习')).toBe('AI学习');
  });

  it('低置信度（<2 个关键词命中）返回 null，不设过滤', () => {
    expect(rag._inferDocCategory('你好')).toBeNull();
    expect(rag._inferDocCategory('这是什么')).toBeNull();
  });

  it('空查询返回 null', () => {
    expect(rag._inferDocCategory('')).toBeNull();
    expect(rag._inferDocCategory('   ')).toBeNull();
  });

  it('autoCategoryFilter=false 时始终返回 null', () => {
    rag.autoCategoryFilter = false;
    expect(rag._inferDocCategory('武汉理工大学校训食堂社团')).toBeNull();
  });
});
