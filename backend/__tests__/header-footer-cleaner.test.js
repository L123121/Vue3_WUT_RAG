import { describe, it, expect } from 'vitest';

const {
  cleanHeaderFooter,
  stripRuleLines,
  stripRepeatingZoneLines,
  matchRuleLine,
  normalizeForRepeat,
} = require('../src/services/knowledge/header-footer-cleaner.service');

// 5 页文档各自的章节标题（真实文档中每页章节不同，避免数字归一化误并）
const SECTION_TITLES = ['入学与注册', '学分与选课', '考核与成绩', '转专业与辅修', '毕业与学位'];

describe('header-footer-cleaner.service', () => {
  describe('规则法 matchRuleLine', () => {
    it('命中常见页码行格式', () => {
      expect(matchRuleLine('第 3 页')).toBe('page_zh');
      expect(matchRuleLine('第3页/共10页')).toBe('page_zh');
      expect(matchRuleLine('第 3 页（共 10 页）')).toBe('page_zh');
      expect(matchRuleLine('- 12 -')).toBe('page_dash');
      expect(matchRuleLine('— 3 —')).toBe('page_dash');
      expect(matchRuleLine('3/10')).toBe('page_fraction');
      expect(matchRuleLine('Page 3 of 10')).toBe('page_en');
      expect(matchRuleLine('  第 3 页 ')).toBe('page_zh');
    });

    it('命中版权行', () => {
      expect(matchRuleLine('Copyright © 2024 武汉理工大学教务处')).toBe('copyright');
      expect(matchRuleLine('© 2024 教务处 版权所有')).toBe('copyright');
      expect(matchRuleLine('copyright 2024')).toBe('copyright');
    });

    it('不误伤含正文的行', () => {
      expect(matchRuleLine('本文共 10 页内容')).toBeNull();
      expect(matchRuleLine('学校共有 30 个专业')).toBeNull();
      expect(matchRuleLine('详见第 3 页的说明')).toBeNull();
      expect(matchRuleLine('版权保护期届满后作品进入公有领域')).toBeNull();
      expect(matchRuleLine('2024-03-10 发布')).toBeNull();
      expect(matchRuleLine('重要通知')).toBeNull();
    });
  });

  describe('规则法 stripRuleLines', () => {
    it('删整行并保留其余内容', () => {
      const input = [
        '武汉理工大学本科教学管理办法',
        '第 1 页/共 5 页',
        '第一章 总则',
        '- 2 -',
        '为规范教学管理，特制定本办法。',
      ].join('\n');
      const { text, removed } = stripRuleLines(input);
      expect(removed).toHaveLength(2);
      expect(removed.map((r) => r.pattern).sort()).toEqual(['page_dash', 'page_zh']);
      expect(text).toContain('第一章 总则');
      expect(text).toContain('为规范教学管理');
      expect(text).not.toContain('第 1 页');
    });

    it('\\f 紧贴正文行时（页尾行\\f下页首页行）仍能逐片段匹配', () => {
      // pdf-parse 的页分隔符 \f 不保证独立成行
      const input = '重复页脚 第 1 页\fCopyright © 2024 武汉理工大学\n正文内容。';
      const { text, removed } = stripRuleLines(input);
      expect(removed).toHaveLength(1);
      expect(removed[0].pattern).toBe('copyright');
      expect(text).toBe('重复页脚 第 1 页\f\n正文内容。');
    });
  });

  describe('位置法 stripRepeatingZoneLines', () => {
    const buildDoc = (pageCount) => {
      const pages = [];
      for (let n = 1; n <= pageCount; n++) {
        pages.push([
          `武理教务 第 ${n} 页`,                                  // 页眉：含页码，规则法不命中（前有文字）
          `第 ${n} 节 ${SECTION_TITLES[n - 1]}`,                  // 顶部章节行，各页内容不同，必须保留
          `正文段落 ${n}，讲述保研政策的申请条件与考核流程。`,        // 正文句（句末标点），必须保留
          `补充说明 ${n}，涉及学分要求与时间节点。`,                  // 正文句，必须保留
          '内部资料 请勿外传',                                     // 页脚：跨页重复
        ].join('\n'));
      }
      return pages.join('\f');
    };

    it('删除跨页重复的页眉页脚行，保留正文', () => {
      const doc = buildDoc(5);
      const { text, pages, removed, headers, footers } = stripRepeatingZoneLines(doc);

      expect(pages).toBe(5);
      expect(headers).toContain('武理教务 第#页');
      expect(footers).toContain('内部资料 请勿外传');
      expect(removed).toBe(10); // 每页 2 行 × 5 页
      expect(text).not.toContain('武理教务');
      expect(text).not.toContain('内部资料');
      expect(text).toContain('正文段落 3');
      expect(text).toContain('第 3 节 考核与成绩');
      // 页与页之间的 \f 分页符保留，不影响下游按页处理
      expect(text.split('\f')).toHaveLength(5);
    });

    it('页数不足 minPages 时不处理', () => {
      const doc = buildDoc(2);
      const { text, removed, pages } = stripRepeatingZoneLines(doc);
      expect(pages).toBe(2);
      expect(removed).toBe(0);
      expect(text).toContain('武理教务');
    });

    it('仅差数字的正文行不会被数字归一化误删', () => {
      // "2024年…/2023年…"式仅差数字的正文行：句末标点守卫 + 非重复内容保护
      const pages = [];
      for (let n = 1; n <= 4; n++) {
        pages.push([
          `${2020 + n} 年级培养方案`,
          `第 ${n} 段正文内容，信息量充足，超出考察区判定范围。`,
          `本段说明 ${n} 年级的实践要求与学分安排。`,
          `更多说明 ${n}，涉及课程设置与考核方式。`,
          `${2020 + n} 级适用`,
        ].join('\n'));
      }
      const { text, removed } = stripRepeatingZoneLines(pages.join('\f'));
      expect(removed).toBe(0);
      expect(text).toContain('2021 年级培养方案');
      expect(text).toContain('2024 级适用');
    });

    it('短页不参与统计也不被删空', () => {
      // 3 页长页建立候选 + 1 个短页（页眉 + 1 行正文）
      const longPages = [];
      for (let n = 1; n <= 3; n++) {
        longPages.push([
          `通用页眉文字 第 ${n} 页`,
          `第 ${n} 节 ${SECTION_TITLES[n - 1]}`,
          `正文内容${n}，足够多的文字让这一页有四行以上。`,
          `更多正文${n}，补充说明相关安排。`,
          `结尾行${n}，收束本页内容。`,
        ].join('\n'));
      }
      const shortPage = '通用页眉文字 第 9 页\n短页仅有的正文';
      const doc = [...longPages, shortPage].join('\f');
      const { text, removed } = stripRepeatingZoneLines(doc);

      // 短页的页眉行保留（宁可不删，不删空）
      const shortCleaned = text.split('\f')[3];
      expect(removed).toBe(3); // 只删 3 个长页的页眉
      expect(shortCleaned).toContain('通用页眉文字');
      expect(shortCleaned).toContain('短页仅有的正文');
    });
  });

  describe('cleanHeaderFooter 主入口', () => {
    it('规则法 + 位置法串联，报告可度量', () => {
      const pages = [];
      for (let n = 1; n <= 4; n++) {
        pages.push([
          'Copyright © 2024 武汉理工大学',                          // 规则法命中
          `重复页眉 第 ${n} 页`,                                    // 位置法命中
          `正文${n}：实验教学的组织与管理按照学校有关规定执行。`,      // 正文句，保留
          `实践教学环节${n}另行通知。`,                              // 正文句，保留
          `重复页脚 第 ${n} 页`,                                    // 位置法命中
        ].join('\n'));
      }
      const { content, report } = cleanHeaderFooter(pages.join('\f'));

      expect(report.pages).toBe(4);
      expect(report.removedRuleLines).toBe(4);       // Copyright 行 × 4
      expect(report.removedPositionLines).toBe(8);   // 重复页眉/页脚 × 4 页
      expect(report.ruleSamples.length).toBeGreaterThan(0);
      expect(report.headerSamples).toContain('重复页眉 第#页');
      expect(content).not.toContain('Copyright');
      expect(content).toContain('正文1');
      expect(content).toContain('实践教学环节2另行通知。');
    });

    it('enabled=false 时原样返回', () => {
      const input = '第 1 页\n正文';
      const { content, report } = cleanHeaderFooter(input, { enabled: false });
      expect(content).toBe(input);
      expect(report.enabled).toBe(false);
      expect(report.removedRuleLines).toBe(0);
    });

    it('CRLF 输入下规则法同样生效', () => {
      const { content } = cleanHeaderFooter('第一章 总则\r\n- 3 -\r\n正文内容。');
      expect(content).toContain('第一章 总则');
      expect(content).not.toContain('- 3 -');
      expect(content).toContain('正文内容。');
    });
  });

  it('normalizeForRepeat：页码数字归一化', () => {
    expect(normalizeForRepeat('武理教务 第 3 页')).toBe(normalizeForRepeat('武理教务 第 12 页'));
    expect(normalizeForRepeat('  A  B  ')).toBe('a b');
  });
});
