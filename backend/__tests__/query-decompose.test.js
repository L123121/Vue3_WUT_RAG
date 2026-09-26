import { describe, it, expect } from 'vitest';

const {
  decomposeQuery,
  splitComparisonQuery,
  splitEnumerationQuery,
  cleanEntity,
} = require('../src/services/rag/query-decompose.service');

describe('query-decompose.service', () => {
  it('对比类问题拆出两个实体', () => {
    expect(splitComparisonQuery('武汉理工大学和华中科技大学的校训有什么区别？')).toEqual([
      '武汉理工大学',
      '华中科技大学',
    ]);
  });

  it('对比类支持"与/跟/vs"连接词', () => {
    expect(splitComparisonQuery('保研与考研的区别是什么')).toEqual(['保研', '考研']);
    expect(splitComparisonQuery('快速排序 vs 归并排序，两者差异')).toEqual(['快速排序', '归并排序']);
  });

  it('二选一类问题（还是…哪个更好）可拆分', () => {
    const result = decomposeQuery('转专业还是辅修哪个更适合我？');
    expect(result.type).toBe('comparison');
    expect(result.subQueries).toHaveLength(2);
  });

  it('列举类问题拆出多个实体（≥2 个才拆）', () => {
    expect(splitEnumerationQuery('保研、考研、就业分别有什么要求？')).toEqual(['保研', '考研', '就业']);
    // 只有 1 个实体 → 不算列举
    expect(splitEnumerationQuery('保研有什么要求？')).toEqual([]);
  });

  it('普通单实体问题不分解', () => {
    expect(decomposeQuery('学校图书馆几点开门？')).toEqual({ subQueries: [], type: null });
    // 含"和"但无对比线索词
    expect(decomposeQuery('我和朋友去食堂吃饭').subQueries).toEqual([]);
  });

  it('纯指代词/过短实体被过滤', () => {
    expect(cleanEntity('它们、')).toBe('它们');
    expect(decomposeQuery('这个和那个的区别').subQueries).toEqual([]);
  });

  it('maxSubQueries 上限生效', () => {
    const { subQueries } = decomposeQuery('苹果、香蕉、橙子、西瓜、葡萄分别有哪些营养？', 3);
    expect(subQueries).toHaveLength(3);
  });

  it('decomposeQuery 返回类型标记', () => {
    expect(decomposeQuery('离散数学和高数的关系').type).toBe('comparison');
    expect(decomposeQuery('奖学金、助学金各自怎么申请？').type).toBe('enumeration');
  });
});
