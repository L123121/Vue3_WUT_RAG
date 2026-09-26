import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * 自适应截断单元测试 — 覆盖 _adaptiveTruncate 的
 * 断崖检测 / 动态低分过滤 / 硬上限 / 单结果放宽 四条规则。
 */
function getRagService() {
  delete require.cache[require.resolve('../src/services/rag/rag.service')];
  return require('../src/services/rag/rag.service').RagService;
}

// 构造带 _rerankScore 的候选
const c = (id, score) => ({ id, _rerankScore: score });

describe('RagService._adaptiveTruncate', () => {
  let RagService;
  let rag;

  beforeEach(() => {
    vi.clearAllMocks();
    RagService = getRagService();
    rag = new RagService({ getCompletion: vi.fn() });
  });

  it('空数组返回空，单候选原样返回', () => {
    expect(rag._adaptiveTruncate([], 10)).toEqual([]);
    const single = [c('a', 0.9)];
    expect(rag._adaptiveTruncate(single, 10)).toEqual(single);
  });

  it('断崖检测：分差 > 0.05 处截断，保留断崖前全部', () => {
    // 0.90 → 0.42 分差 0.48 > 0.05，断崖在 index 2
    const candidates = [c('a', 0.95), c('b', 0.90), c('c', 0.42), c('d', 0.40), c('e', 0.38)];
    const result = rag._adaptiveTruncate(candidates, 10);
    expect(result.map(x => x.id)).toEqual(['a', 'b', 'c']);
  });

  it('低分过滤：低于动态 minScore 的候选被严格排除', () => {
    // 断崖在 index 3（0.62→0.20 分差 0.42），低分也在 index 3（0.20 < 0.30）
    // 低分过滤优先：0.20 / 0.10 都应被排除，而不是保留断崖后的第一个
    const candidates = [c('a', 0.70), c('b', 0.66), c('c', 0.62), c('d', 0.20), c('e', 0.10)];
    const result = rag._adaptiveTruncate(candidates, 10);
    expect(result.map(x => x.id)).toEqual(['a', 'b', 'c']);
  });

  it('硬上限：结果数量不超过 effectiveMaxCount', () => {
    // 分数都够高、无断崖，但 maxCount=2
    const candidates = [c('a', 0.95), c('b', 0.90), c('c', 0.85), c('d', 0.80)];
    const result = rag._adaptiveTruncate(candidates, 2);
    expect(result).toHaveLength(2);
    expect(result.map(x => x.id)).toEqual(['a', 'b']);
  });

  it('单结果放宽：只剩 1 个且第 2 个分数够高时补充到 2 个', () => {
    // effectiveMaxCount=1 → 初始 1 个；sorted[1]=0.85 > dynamicMinScore=0.25 → 补充
    const candidates = [c('a', 0.90), c('b', 0.85), c('c', 0.10)];
    const result = rag._adaptiveTruncate(candidates, 1);
    expect(result.map(x => x.id)).toEqual(['a', 'b']);
  });

  it('未排序输入也会按 rerank 分数降序后截断', () => {
    const candidates = [c('x', 0.40), c('y', 0.95), c('z', 0.60)];
    const result = rag._adaptiveTruncate(candidates, 10);
    expect(result.map(x => x.id)).toEqual(['y', 'z']);
  });

  it('query 类型配置会覆盖 maxCount（rerankTopK）', () => {
    vi.spyOn(rag, 'getTypeConfig').mockReturnValue({
      type: 'general',
      rerankTopK: 3,
      minScore: 0.5,
      clamp: [0.4, 0.6],
    });
    const candidates = [c('a', 0.95), c('b', 0.90), c('c', 0.85), c('d', 0.80)];
    const result = rag._adaptiveTruncate(candidates, 10, '某类问题');
    // rerankTopK=3 覆盖 maxCount=10
    expect(result).toHaveLength(3);
    expect(rag.getTypeConfig).toHaveBeenCalledWith('某类问题');
  });

  it('请求级覆盖：rerankMinScore 精确生效（不做动态调整/clamp）', () => {
    // 类型配置 clamp=[0.2,0.5]，但显式覆盖 0.6 应精确生效
    vi.spyOn(rag, 'getTypeConfig').mockReturnValue({
      type: 'general', rerankTopK: 10, minScore: 0.3, clamp: [0.2, 0.5],
    });
    const candidates = [c('a', 0.70), c('b', 0.55), c('c', 0.50), c('d', 0.20)];
    const result = rag._adaptiveTruncate(candidates, 10, '某类问题', { rerankMinScore: 0.6 });
    // 0.55 / 0.50 / 0.20 都低于 0.6 → 只留 0.70
    expect(result.map(x => x.id)).toEqual(['a']);
  });

  it('请求级覆盖：rerankDropoff 改变断崖检测阈值', () => {
    // 默认断崖 0.05：0.60→0.58 分差 0.02 不截断 → 全部保留
    const candidates = [c('a', 0.60), c('b', 0.58), c('c', 0.55)];
    const defaultResult = rag._adaptiveTruncate(candidates, 10);
    expect(defaultResult.map(x => x.id)).toEqual(['a', 'b', 'c']);
    // 覆盖 0.01：0.60→0.58 分差 0.02 触发断崖；断崖截断保留分界后的第一个 → ['a','b']
    const tightResult = rag._adaptiveTruncate(candidates, 10, null, { rerankDropoff: 0.01 });
    expect(tightResult.map(x => x.id)).toEqual(['a', 'b']);
  });

  it('请求级覆盖：rerankTopK 硬上限优先于类型配置', () => {
    vi.spyOn(rag, 'getTypeConfig').mockReturnValue({
      type: 'general', rerankTopK: 6, minScore: 0.3, clamp: [0.2, 0.5],
    });
    const candidates = [c('a', 0.95), c('b', 0.90), c('c', 0.85), c('d', 0.80)];
    const result = rag._adaptiveTruncate(candidates, 10, '某类问题', { rerankTopK: 2 });
    expect(result.map(x => x.id)).toEqual(['a', 'b']);
  });

  it('请求级覆盖：不传覆盖参数时行为与默认一致', () => {
    const candidates = [c('a', 0.70), c('b', 0.66), c('c', 0.62), c('d', 0.20)];
    const base = rag._adaptiveTruncate(candidates, 10, null, {});
    const defaultResult = rag._adaptiveTruncate(candidates, 10);
    expect(base.map(x => x.id)).toEqual(defaultResult.map(x => x.id));
  });
});

describe('RagService._evalOverrides', () => {
  let rag;

  beforeEach(() => {
    vi.clearAllMocks();
    rag = new (getRagService())({ getCompletion: vi.fn() });
  });

  it('提取合法数值覆盖', () => {
    const o = rag._evalOverrides({ rerankMinScore: 0.4, rerankDropoff: 0.08, rerankTopK: 6, maxContextLength: 4000 });
    expect(o).toEqual({ rerankMinScore: 0.4, rerankDropoff: 0.08, rerankTopK: 6, maxContextLength: 4000 });
  });

  it('非法值被过滤（越界/非数字/空字符串）', () => {
    const o = rag._evalOverrides({
      rerankMinScore: 1.5,      // > 1 非法
      rerankDropoff: 'abc',     // 非数字 → NaN
      rerankTopK: 500,          // > 100 非法
      maxContextLength: 100,    // < 500 非法
    });
    expect(Object.keys(o)).toHaveLength(0);
  });

  it('未传任何覆盖时返回空对象', () => {
    expect(rag._evalOverrides({ category: '学校概况' })).toEqual({});
    expect(rag._evalOverrides()).toEqual({});
  });
});

describe('RagService._buildContextFromParents maxContextLength 覆盖', () => {
  let rag;

  beforeEach(() => {
    vi.clearAllMocks();
    rag = new (getRagService())({ getCompletion: vi.fn() });
    // mock documentService，避免真实数据库访问
    rag.documentService = {
      getDocument: vi.fn(async (docId) => ({ id: docId, title: `文档${docId}`, category: 'test', content: '' })),
    };
  });

  it('默认使用 this.maxContextLength', async () => {
    const { context } = await rag._buildContextFromParents([{ docId: 'd1', parentText: 'x'.repeat(100), _rerankScore: 0.9 }]);
    // 默认 6000，单段 100 字不截断
    expect(context.length).toBeGreaterThan(0);
  });

  it('覆盖 maxContextLength 后按覆盖值截断', async () => {
    const parent = { docId: 'd1', parentText: 'x'.repeat(1000), _rerankScore: 0.9 };
    const full = await rag._buildContextFromParents([parent], { maxContextLength: 10000 });
    const capped = await rag._buildContextFromParents([parent], { maxContextLength: 500 });
    // 覆盖值生效：capped 上下文显著短于 full
    expect(capped.context.length).toBeLessThan(full.context.length);
    expect(capped.context.length).toBeLessThanOrEqual(500 + 200); // 截断余量
  });
});
