import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

function getIndexingService() {
  delete require.cache[require.resolve('../src/services/knowledge/indexing.service')];
  return require('../src/services/knowledge/indexing.service').IndexingService;
}

function getRerankerService() {
  delete require.cache[require.resolve('../src/services/knowledge/reranker.service')];
  return require('../src/services/knowledge/reranker.service').RerankerService;
}

/**
 * 切片结构测试：frontmatter 剥离 + Markdown 标题章节合并
 * 背景：md 指南文件此前退化成逐行父段落，纯标题行单独成段后凭字面重叠
 * 抢占检索上下文，模型只能拿到"标题 + 元数据"作答。
 */
describe('IndexingService 切片结构', () => {
  let svc;

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const IndexingService = getIndexingService();
    svc = new IndexingService({ addChunks: vi.fn() }, { embedBatch: vi.fn() });
  });

  it('剥离 YAML frontmatter，元数据不进入父段落', () => {
    const text = [
      '---',
      'created: 2026-08-17',
      'category: 专业课程',
      'tags: [推免, 保研]',
      '---',
      '',
      '# 推免保研准备与材料清单',
      '',
      '正文内容从这里开始，包含具体的材料说明。',
    ].join('\n');

    const paras = svc._splitParagraphs(text);
    const joined = paras.join('\n');

    expect(joined).not.toContain('created: 2026-08-17');
    expect(joined).not.toContain('tags: [推免, 保研]');
    expect(joined).toContain('正文内容从这里开始');
  });

  it('无 frontmatter 的文本原样保留', () => {
    const text = '第一段内容。\n\n第二段内容。';
    expect(svc._splitParagraphs(text).join('\n')).toContain('第一段内容');
  });

  it('Markdown 标题作为章节边界，标题与正文合并为同一父段落', () => {
    const text = [
      '# 推免保研准备与材料清单',
      '',
      '> 本文只提供准备方法，不替代学院当年实施细则。',
      '',
      '## 三、材料清单',
      '',
      '- 成绩单、成绩排名或绩点证明。',
      '- 在读证明、身份证明和学生证材料。',
      '- 中英文简历。',
      '',
      '## 四、面试准备框架',
      '',
      '每个项目至少准备项目背景、个人工作与技术选择。',
    ].join('\n\n');

    const paras = svc._splitParagraphs(text);

    // 不存在"纯标题"父段落：每个标题都和它的正文在同一父段落里
    for (const p of paras) {
      const isBareHeading = /^#{1,6}\s+\S/.test(p.trim()) && !p.split('\n').some(line => !/^#{1,6}\s/.test(line.trim()) && line.trim());
      expect(isBareHeading).toBe(false);
    }
    // 材料清单标题与它的列表内容在同一父段落
    const materialPara = paras.find(p => p.includes('## 三、材料清单'));
    expect(materialPara).toContain('成绩单、成绩排名或绩点证明');
    expect(materialPara).toContain('中英文简历');
  });

  it('中文序号标题（DOCX 转文本）合并行为保持不变', () => {
    const text = [
      '一、学校概况',
      '武汉理工大学由三校合并而成。',
      '二、校区分布',
      '学校现有多个校区。',
    ].join('\n\n');

    const paras = svc._splitParagraphs(text);
    expect(paras).toHaveLength(2);
    expect(paras[0]).toContain('一、学校概况');
    expect(paras[0]).toContain('三校合并');
    expect(paras[1]).toContain('二、校区分布');
  });
});

/**
 * fallback 排序降权：纯标题/超短候选不再压过含内容的段落
 */
describe('RerankerService._fallbackRank', () => {
  let svc;

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const RerankerService = getRerankerService();
    svc = new RerankerService();
  });

  it('纯标题行降权后不再排第一', () => {
    const candidates = [
      { id: 'heading', text: '# 推免保研准备与材料清单', score: 0.9 },
      { id: 'content', text: '成绩单、在读证明、中英文简历、个人陈述、获奖证明与推荐信', score: 0.5 },
    ];

    const result = svc._fallbackRank(candidates, 2);
    expect(result[0].id).toBe('content');
    expect(result[0]._rerankScore).toBeCloseTo(0.5);
    // 标题候选被降权 0.3 倍但仍在列表内
    expect(result[1].id).toBe('heading');
    expect(result[1]._rerankScore).toBeCloseTo(0.27);
  });

  it('超短候选（<12 字）同样降权', () => {
    const candidates = [
      { id: 'tiny', text: '联系方式见官网', score: 0.9 },
      { id: 'content', text: '图书馆开放时间为工作日早上八点，周末上午九点，考试周顺延。', score: 0.6 },
    ];

    const result = svc._fallbackRank(candidates, 2);
    expect(result[0].id).toBe('content');
  });
});

/**
 * 场景化子块切割：FAQ 整条 / 表格整表或按行 / 列表按条目
 * 背景：默认 25 字符句子包对结构化文本会把语义单元切碎（FAQ 串台、
 * 表格行无语义、列表步骤失归属），检索命中的粒度按块型自适应。
 */
describe('IndexingService 场景化子块切割', () => {
  let svc;
  let config;

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    config = require('../src/config');
    const IndexingService = getIndexingService();
    svc = new IndexingService({ addChunks: vi.fn() }, { embedBatch: vi.fn() });
  });

  afterEach(() => {
    config.document.adaptiveChunking = true;
  });

  const FAQ_TEXT = [
    '### Q1: 保研需要哪些材料？',
    '- A. 成绩单',
    '- B. 个人陈述',
    '**答案：AB**',
    '### Q2: 什么时候提交申请？',
    '大四上学期九月初。',
  ].join('\n');

  it('FAQ：问答条目整条一个子块，不跨条目合并', () => {
    const { type, chunks } = svc._splitChildChunks(FAQ_TEXT);
    expect(type).toBe('faq');
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toContain('保研需要哪些材料');
    expect(chunks[0]).toContain('答案：AB');
    expect(chunks[0]).not.toContain('什么时候提交申请');
    expect(chunks[1]).toContain('什么时候提交申请');
    expect(chunks[1]).toContain('九月初');
  });

  it('FAQ：超长条目退回句子合并', () => {
    const sentenceA = '保研政策涉及推荐资格审核、名额分配、综合成绩计算与复试安排等多个环节，各学院实施细则存在明显差异，申请前务必逐条核对当年发布的官方通知原文。';
    const sentenceB = '同时应以教务处与学院官网的最新版本为准，避免沿用往年经验导致材料缺失或错过关键时间节点，必要时直接咨询学院教务办确认口径。';
    const sentenceC = '此外各学院复试差额比例与加分政策每年动态调整，最终名单以公示为准，建议同时准备调剂备选方案。';
    const text = [
      '### Q: 政策细节',
      sentenceA + sentenceB + sentenceC,
      '### Q: 申请时间',
      '九月上旬提交材料。',
    ].join('\n');
    const { type, chunks } = svc._splitChildChunks(text);
    expect(type).toBe('faq');
    expect(chunks.length).toBeGreaterThanOrEqual(3);
  });

  it('表格：小表（≤5 数据行）整表一个子块', () => {
    const text = [
      '| 学院 | 复试线 |',
      '| --- | --- |',
      '| 计算机学院 | 320 |',
      '| 材料学院 | 310 |',
    ].join('\n');
    const { type, chunks } = svc._splitChildChunks(text);
    expect(type).toBe('table');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain('计算机学院');
    expect(chunks[0]).toContain('材料学院');
  });

  it('表格：大表（>5 数据行）按行切且每行带表头', () => {
    const rows = Array.from({ length: 7 }, (_, i) => `| 学院${i + 1} | ${300 + i} |`);
    const text = ['| 学院 | 复试线 |', '| --- | --- |', ...rows].join('\n');
    const { type, chunks } = svc._splitChildChunks(text);
    expect(type).toBe('table');
    expect(chunks).toHaveLength(7);
    for (const chunk of chunks) {
      expect(chunk).toContain('复试线');      // 每行子块带表头前缀
      expect(chunk).not.toContain('---');     // 分隔行不进入子块
    }
  });

  it('列表：按条目边界切，条目带引导句前缀', () => {
    const text = [
      '成绩查询流程',
      '1. 登录教务系统',
      '2. 点击成绩查询菜单',
      '3. 选择学期后查看成绩单',
    ].join('\n');
    const { type, chunks } = svc._splitChildChunks(text);
    expect(type).toBe('list');
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toBe('成绩查询流程：1. 登录教务系统');
    expect(chunks[1]).toBe('成绩查询流程：2. 点击成绩查询菜单');
    expect(chunks[2]).toBe('成绩查询流程：3. 选择学期后查看成绩单');
  });

  it('散文：默认 25 字符合并行为不变（回归保护）', () => {
    const text = '学校现有三个校区。校区分布如下。\n马房山校区位于洪山区。余家头校区位于武昌区。';
    const { type, chunks } = svc._splitChildChunks(text);
    expect(type).toBe('prose');
    expect(chunks.length).toBeLessThan(4);      // 短句被合并
    expect(chunks[0].length).toBeGreaterThanOrEqual(25);
  });

  it('开关关闭：adaptiveChunking=false 回退 25 字符合并，问答条目被串切', () => {
    config.document.adaptiveChunking = false;
    const { type, chunks } = svc._splitChildChunks(FAQ_TEXT);
    expect(type).toBe('prose');
    // 回退后按 25 字符累积合并：Q1 的答案与 Q2 的题目被并进同一条子块（召回串台）
    expect(chunks.some((c) => c.includes('答案：AB') && c.includes('什么时候提交申请'))).toBe(true);
  });
});
