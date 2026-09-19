/**
 * 知识库两级分类体系（前端唯一定义处）
 *
 * 后端对 category 无白名单校验（rag.controller 只兜底 'general'），
 * 且 agent-tools.js 的 enum 与本表、与 ragdata 实际入库值互不一致，
 * 因此分类展示一律以本表为准；本表之外的分类值按原样归入"未登记分类"。
 */

export const categoryGroups = [
  {
    label: '课程资料', value: '课程资料',
    children: [
      { value: '课程资料:C语言程序设计基础', label: 'C语言程序设计基础' },
      { value: '课程资料:Java语言程序设计', label: 'Java语言程序设计' },
      { value: '课程资料:Python程序设计', label: 'Python程序设计' },
      { value: '课程资料:中国近代史纲要', label: '中国近代史纲要' },
      { value: '课程资料:马克思主义理论', label: '马克思主义理论' },
      { value: '课程资料:大学物理', label: '大学物理' },
      { value: '课程资料:操作系统', label: '操作系统' },
      { value: '课程资料:数据结构', label: '数据结构' },
      { value: '课程资料:概率论', label: '概率论' },
      { value: '课程资料:离散数学', label: '离散数学' },
      { value: '课程资料:电路原理', label: '电路原理' },
      { value: '课程资料:软件工程', label: '软件工程' },
      { value: '课程资料:数据结构与算法', label: '数据结构与算法' },
      { value: '课程资料:人工智能', label: '人工智能' },
    ]
  },
  {
    label: '竞赛资料', value: '竞赛资料',
    children: [
      { value: '竞赛资料:大学生数学竞赛', label: '大学生数学竞赛' },
      { value: '竞赛资料:大学生英语竞赛', label: '大学生英语竞赛' },
      { value: '竞赛资料:大学生力学竞赛', label: '大学生力学竞赛' },
    ]
  },
  {
    label: '保研', value: '保研',
    children: [
      { value: '保研:保研准备材料', label: '保研准备材料' },
      { value: '保研:保研政策', label: '保研政策' },
      { value: '保研:往届推免名单', label: '往届推免名单' },
    ]
  },
  {
    label: '信息资源', value: '信息资源',
    children: [
      { value: '信息资源:本科培养方案', label: '本科培养方案' },
      { value: '信息资源:转专业资料', label: '转专业资料' },
      { value: '信息资源:免听免修文件', label: '免听免修文件' },
      { value: '信息资源:奖助学金相关', label: '奖助学金相关' },
      { value: '信息资源:体测相关', label: '体测相关' },
      { value: '信息资源:本科生选课', label: '本科生选课' },
      { value: '信息资源:校园指南', label: '校园指南' },
    ]
  }
];

export const allSubCategories = categoryGroups.flatMap(g => g.children);

export const UNGROUPED_LABEL = '未分类';

/**
 * 拆分复合分类值："课程资料:数据结构" → { group: '课程资料', sub: '数据结构' }
 * 无冒号（如 ragdata 入库的 '学校概况'）时整体视为一级
 */
export const splitCategory = (value) => {
  if (!value) return { group: UNGROUPED_LABEL, sub: '' };
  const colonIdx = value.indexOf(':');
  if (colonIdx > 0) {
    return { group: value.slice(0, colonIdx), sub: value.slice(colonIdx + 1) };
  }
  return { group: value, sub: '' };
};

// 获取分类标签
export const getCategoryLabel = (value) => {
  if (!value) return UNGROUPED_LABEL;
  // 先查二级分类（复合值如 "课程资料:数据结构"）
  const sub = allSubCategories.find(c => c.value === value);
  if (sub) return sub.label;
  // 再查一级分类
  const group = categoryGroups.find(g => g.value === value);
  if (group) return group.label;
  return value;
};

// 获取一级分类名（从复合值中提取，如 "课程资料:数据结构" → "课程资料"）
export const getGroupLabel = (value) => {
  if (!value) return '';
  const colonIdx = value.indexOf(':');
  if (colonIdx > 0) {
    const groupName = value.slice(0, colonIdx);
    const group = categoryGroups.find(g => g.value === groupName);
    return group ? group.label : groupName;
  }
  return getCategoryLabel(value);
};
