import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * history 管理单元测试 — 覆盖 B 方案（滚动摘要压缩）和 C 方案（token 预算分配）
 * 1. _compactHistory：短 history 原样返回 / 长 history 压缩+保留最近 / 无 key 降级截断
 * 2. _buildMessages：短 history 全保留 / 总预算封顶 / 最近优先 / 单条截断
 */
function getAiService() {
  delete require.cache[require.resolve('../src/config')];
  delete require.cache[require.resolve('../src/services/ai.service')];
  return require('../src/services/ai.service').AiService;
}

const mkHistory = (count, perLen = 80) =>
  Array.from({ length: count }, (_, i) => ({
    role: i % 2 ? 'assistant' : 'user',
    content: `消息${i}${'x'.repeat(perLen)}`,
  }));

describe('AiService._compactHistory（B 方案滚动摘要）', () => {
  let AiService;
  let ai;

  beforeEach(() => {
    vi.clearAllMocks();
    AiService = getAiService();
    ai = new AiService();
  });

  it('短 history（≤12 条）原样返回，不调用 summarize', async () => {
    const short = mkHistory(5);
    ai.judgeService.summarize = vi.fn().mockResolvedValue('摘要');
    const result = await ai._compactHistory(short);
    expect(result).toHaveLength(5);
    expect(ai.judgeService.summarize).not.toHaveBeenCalled();
  });

  it('长 history 超出窗口时调用 summarize，摘要置于对话前', async () => {
    const long = mkHistory(20);
    ai.judgeService.summarize = vi.fn().mockResolvedValue('用户是软件工程专业，已办理补考');
    const result = await ai._compactHistory(long);
    expect(ai.judgeService.summarize).toHaveBeenCalled();
    // 摘要作为 system 消息 + 最近 12 条
    expect(result[0].role).toBe('system');
    expect(result[0].content).toContain('软件工程专业');
    expect(result).toHaveLength(13);
    // 最近的历史消息保留在倒数第 1 位（result 结构：system + 12 条 recent）
    expect(result[result.length - 1].content).toContain('消息19');
  });

  it('summarize 失败时降级为直接截断最近 12 条，不抛错', async () => {
    const long = mkHistory(20);
    ai.judgeService.summarize = vi.fn().mockResolvedValue(null);
    const result = await ai._compactHistory(long);
    expect(result).toHaveLength(12);
    expect(result[0].role).not.toBe('system');
  });

  it('summarize 抛异常时降级为直接截断，不阻塞主流程', async () => {
    const long = mkHistory(20);
    ai.judgeService.summarize = vi.fn().mockRejectedValue(new Error('API down'));
    const result = await ai._compactHistory(long);
    expect(result).toHaveLength(12);
  });

  it('空 history 返回空数组', async () => {
    expect(await ai._compactHistory([])).toEqual([]);
    expect(await ai._compactHistory(null)).toEqual([]);
  });
});

describe('AiService._buildMessages（C 方案 token 预算）', () => {
  let AiService;
  let ai;

  beforeEach(() => {
    vi.clearAllMocks();
    AiService = getAiService();
    ai = new AiService();
  });

  it('短 history 全部保留，当前问题在末尾', () => {
    const short = mkHistory(3, 10);
    const result = ai._buildMessages('当前问题', short);
    expect(result).toHaveLength(4); // 3 历史 + 1 当前
    expect(result[result.length - 1]).toEqual({ role: 'user', content: '当前问题' });
  });

  it('长 history 总字符被 6000 预算封顶，最近的对话优先', () => {
    // 每条 ~603 字符 × 12 条 = 7200 > 6000 预算，应触发字符截断（保留 ~9 条）
    const long = mkHistory(20, 600);
    const result = ai._buildMessages('q', long);
    const totalChars = result.slice(0, -1).reduce((s, m) => s + m.content.length, 0);
    expect(totalChars).toBeLessThanOrEqual(6000);
    expect(result.length - 1).toBeLessThan(12);
    // 最近的（19 号）保留，最早的（0 号）被裁掉
    expect(result[result.length - 2].content).toContain('消息19');
    expect(result[0].content).not.toContain('消息0');
  });

  it('单条消息截断到 2000 字符', () => {
    const huge = [{ role: 'user', content: 'x'.repeat(5000) }];
    const result = ai._buildMessages('q', huge);
    expect(result[0].content.length).toBe(2000);
  });

  it('空 history 只返回当前问题', () => {
    expect(ai._buildMessages('q', [])).toEqual([{ role: 'user', content: 'q' }]);
    expect(ai._buildMessages('q', null)).toEqual([{ role: 'user', content: 'q' }]);
  });

  it('显式 opts.messages 也会限制上下文并保留工具调用组', () => {
    const messages = [
      { role: 'system', content: 'system'.repeat(1000) },
      { role: 'user', content: '问题'.repeat(1000) },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', function: { name: 'search', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call-1', content: '工具结果'.repeat(3000) },
      { role: 'user', content: '当前问题'.repeat(1000) },
    ];
    const bounded = ai._boundMessages(messages);
    const chars = bounded.reduce((sum, item) => sum + String(item.content || '').length, 0);
    expect(chars).toBeLessThanOrEqual(12000);
    expect(bounded.some((item) => item.role === 'assistant' && item.tool_calls)).toBe(true);
    expect(bounded.some((item) => item.role === 'tool' && item.tool_call_id === 'call-1')).toBe(true);
  });
});
