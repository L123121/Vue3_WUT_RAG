import { describe, it, expect, afterEach } from 'vitest';

const {
  normalizeCharacters,
  mergeHardLineBreaks,
  endsWithTerminator,
} = require('../src/services/knowledge/text-normalizer.service');
const config = require('../src/config');

describe('text-normalizer.service — normalizeCharacters', () => {
  afterEach(() => {
    config.docNormalize.enabled = true;
  });

  it('全角字母/数字转半角，中文标点保留全角', () => {
    const { content, report } = normalizeCharacters('第３页 ＡＢＣ ｘｙｚ ９０１２，。！？；：');
    expect(content).toBe('第3页 ABC xyz 9012，。！？；：');
    expect(report.fullwidth).toBe(7 + 4);
  });

  it('空白统一：NBSP/全角空格/制表符/零宽 → 普通空格；CRLF → LF；BOM 移除', () => {
    const { content, report } = normalizeCharacters('a\u00A0b\u3000c\td\u200be\r\nf\uFEFF');
    expect(content).toBe('a b c d e\nf');
    expect(report.whitespace).toBeGreaterThanOrEqual(3);
    expect(report.bom).toBe(1);
  });

  it('控制字符剔除，\\n 与 \\f 保留（页分隔符是位置法分页依据）', () => {
    const { content, report } = normalizeCharacters('a\x00b\x07c\x1fd\x7fe\nf\fg');
    expect(content).toBe('abcde\nf\fg');
    expect(report.control).toBe(4);
  });

  it('乱码占位替换：方块/替换符连串、连续问号、锟斤拷 → [UNK] 并计数', () => {
    const { content, report } = normalizeCharacters('温度■■□ 值\ufffd\ufffd 错误????? 乱码锟斤拷锟斤拷');
    expect(content).toContain('温度[UNK]');
    expect(content).toContain('值[UNK]');
    expect(content).toContain('错误[UNK]');
    expect(content).toContain('乱码[UNK]');
    expect(report.garbageReplaced).toBe(3);
    expect(report.mojibakeReplaced).toBe(1);
    expect(report.totalReplaced).toBe(4);
  });

  it('全角问号串（中文语气"？？？？"）不是乱码，原样保留', () => {
    const { content, report } = normalizeCharacters('这是认真的？？？？后半句正常。');
    expect(content).toBe('这是认真的？？？？后半句正常。');
    expect(report.garbageReplaced).toBe(0);
  });

  it('enabled=false 原样返回', () => {
    const input = '第３页\u3000■';
    const { content, report } = normalizeCharacters(input, { enabled: false });
    expect(content).toBe(input);
    expect(report.enabled).toBe(false);
    expect(report.totalReplaced).toBe(0);
  });
});

describe('text-normalizer.service — mergeHardLineBreaks', () => {
  it('中文硬断行合并（\\n 换空格）', () => {
    const text = '保研政策涉及资格审核与名额\n分配等多个环节。';
    const { content, report } = mergeHardLineBreaks(text);
    expect(content).toBe('保研政策涉及资格审核与名额 分配等多个环节。');
    expect(report.merged).toBe(1);
  });

  it('句末标点结尾不合并（全角 + 半角）', () => {
    const text = '第一句已经结束。\n第二句独立成行.';
    const { content, report } = mergeHardLineBreaks(text);
    expect(content).toBe(text);
    expect(report.merged).toBe(0);
  });

  it('行尾收尾引号/括号后按其前的句末标点判定', () => {
    const text = '详见学校通知（附件三）。\n下一行独立';
    expect(mergeHardLineBreaks(text).report.merged).toBe(0);
  });

  it('下一行为列表序号/标题/表格/引用/分隔线时不合并', () => {
    const cases = [
      ['流程如下：', '1. 登录系统'],
      ['章节内容', '## 二、报名条件'],
      ['表格说明', '| 学院 | 复试线 |'],
      ['引用前文', '> 学校官网公告'],
      ['标题在上', '---'],
      ['步骤一结束', '第二步 提交材料'],
    ];
    for (const [a, b] of cases) {
      const { report } = mergeHardLineBreaks(`${a}\n${b}`);
      expect(report.merged, `"${a}" + "${b}" 不应合并`).toBe(0);
    }
  });

  it('当前行为标题/表格/引用行时不作为合并起点', () => {
    const text = '## 申请条件\n需要满足基本要求';
    expect(mergeHardLineBreaks(text).report.merged).toBe(0);
  });

  it('空行（段落边界）不合并', () => {
    const text = '第一段没有句号\n\n第二段开头';
    const { content, report } = mergeHardLineBreaks(text);
    expect(content).toBe(text);
    expect(report.merged).toBe(0);
  });

  it('代码围栏内部不合并；围栏行是结构行不与前言合并；围栏外恢复合并', () => {
    const text = [
      '安装命令如下',
      '```bash',
      'npm install',
      'npm run build',
      '```',
      '安装完成后即可',
      '直接启动服务',
    ].join('\n');
    const { content, report } = mergeHardLineBreaks(text);
    expect(report.merged).toBe(1); // 仅围栏后两行合并；围栏内保持，围栏行不并入前言
    expect(content).toContain('安装命令如下\n```bash');
    expect(content).toContain('```bash\nnpm install\nnpm run build\n```');
    expect(content).toContain('安装完成后即可 直接启动服务');
  });

  it('frontmatter 块内部不合并（保持 --- 边界识别）', () => {
    const text = ['---', 'created: 2026-08-31', 'category: 指南', '---', '正文没有句号', '接着的内容'].join('\n');
    const { content, report } = mergeHardLineBreaks(text);
    expect(content.split('\n').slice(0, 4)).toEqual(['---', 'created: 2026-08-31', 'category: 指南', '---']);
    expect(report.merged).toBe(1); // 只有正文部分合并
    expect(content).toContain('正文没有句号 接着的内容');
  });

  it('\\f 前后（跨页）不合并', () => {
    const text = '上一页结尾没有句号\f\n下一页开头内容';
    const { report } = mergeHardLineBreaks(text);
    expect(report.merged).toBe(0);
    const text2 = '上一页结尾没有句号\n\f下一页开头内容';
    expect(mergeHardLineBreaks(text2).report.merged).toBe(0);
    // \f 后带尾随空白也属于跨页（trimEnd 会把 \f 一并去掉，不能用 trim 后的行判）
    const text3 = '上一页结尾没有句号\f \n下一页开头内容';
    expect(mergeHardLineBreaks(text3).report.merged).toBe(0);
  });

  it('enabled=false 原样返回', () => {
    const text = '硬断行\n内容';
    const { content, report } = mergeHardLineBreaks(text, { enabled: false });
    expect(content).toBe(text);
    expect(report.merged).toBe(0);
  });

  it('endsWithTerminator：句内标点（、，）不算结束', () => {
    expect(endsWithTerminator('成绩单、')).toBe(false);
    expect(endsWithTerminator('包括成绩单，')).toBe(false);
    expect(endsWithTerminator('申请结束。')).toBe(true);
  });
});

describe('text-normalizer — 与清洗管线协同', () => {
  it('归一化前置让页眉页脚规则法吃到全角数字（"第３页"→"第3页"）', () => {
    const { cleanHeaderFooter } = require('../src/services/knowledge/header-footer-cleaner.service');
    const norm = normalizeCharacters('正文内容。\n第３页');
    const { report } = cleanHeaderFooter(norm.content);
    expect(report.removedRuleLines).toBe(1);
  });
});

describe('text-normalizer — 链式合并与注入占位行保护', () => {
  it('连续硬断行一次拼回整段（链式吸收）', () => {
    const text = '保研申请需要准备成绩单等材\n料，全部材料需加盖\n学院公章。流程结束。';
    const { content, report } = mergeHardLineBreaks(text);
    expect(report.merged).toBe(2);
    expect(content).toBe('保研申请需要准备成绩单等材 料，全部材料需加盖 学院公章。流程结束。');
  });

  it('注入占位行不吸收后续正文（注入过滤先于断行合并的配套保护）', () => {
    const text = '温度显示[UNK]为传感器故障\n[已过滤：疑似提示词注入]\n下一行正文没有句号';
    const { content } = mergeHardLineBreaks(text);
    expect(content.split('\n')[1]).toBe('[已过滤：疑似提示词注入]');
    expect(content).not.toContain('[已过滤：疑似提示词注入] 下一行正文');
  });

  it('分隔线（---）不与相邻行合并', () => {
    const text = '前言没有句号\n---\ncreated: 2026-08-31';
    const { content } = mergeHardLineBreaks(text);
    expect(content.split('\n')).toEqual(['前言没有句号', '---', 'created: 2026-08-31']);
  });
});
