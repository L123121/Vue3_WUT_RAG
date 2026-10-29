'use strict';

const { runtimeError, shortText, identifier, safeJson, references, LIMITS, digest, copy } = require('./runtime-values');

const DEFINITIONS = Object.freeze([
  { name: 'search_published_sources', label: '检索已发布校园资料', description: '按查询检索审核上架的百科来源，返回有界原文片段。', execution: 'worker', parallelSafe: true, sideEffect: false, replaySafe: true, requiresApproval: false, timeoutMs: 15000, version: 1 },
  { name: 'read_published_source', label: '读取已发布原文', description: '读取指定来源，可固定版本；未上架、漂移或版本不符时拒绝。', execution: 'worker', parallelSafe: true, sideEffect: false, replaySafe: true, requiresApproval: false, timeoutMs: 10000, version: 1 },
  { name: 'compile_research_brief', label: '汇编来源摘录', description: '归并依赖步骤的真实资料为带引用的摘录，不生成未经来源支持的结论。', execution: 'worker', parallelSafe: true, sideEffect: false, replaySafe: true, requiresApproval: false, timeoutMs: 5000, version: 1 },
  { name: 'save_research_brief', label: '保存个人研究摘录', description: '把已汇编摘录保存为当前运行的私有产物，需用户一次性批准。', execution: 'worker', parallelSafe: false, sideEffect: true, replaySafe: true, requiresApproval: true, timeoutMs: 5000, version: 1 },
  ...[
    ['python_execute', 'Python 执行'], ['shell_execute', 'Shell 执行'], ['browser_visit', '浏览器访问'],
    ['convert_file', '文件转换'], ['web_search', '网络搜索'], ['database_query', '数据库查询'],
  ].map(([name, label]) => ({ name, label, description: '尚未接入隔离执行器，默认拒绝；普通 worker 不是沙箱。', execution: 'sandbox_required', parallelSafe: false, sideEffect: true, replaySafe: false, requiresApproval: true, timeoutMs: 0, version: 1 })),
]);
const BY_NAME = new Map(DEFINITIONS.map(tool => [tool.name, Object.freeze(tool)]));
const getTool = name => BY_NAME.get(name) || null;
const getCatalog = () => DEFINITIONS.map(tool => ({ ...tool }));

function exactKeys(input, keys) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !keys.includes(key))) throw runtimeError('工具输入包含未知字段', 'INVALID_TOOL_INPUT');
}
function validateInput(name, input) {
  safeJson(input);
  if (Buffer.byteLength(JSON.stringify(input)) > 196608) throw runtimeError('工具输入过大', 'INVALID_TOOL_INPUT');
  if (name === 'search_published_sources') {
    exactKeys(input, ['query', 'limit']);
    shortText(input.query, 500, '检索问题');
    if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 3)) throw runtimeError('每步最多检索3个来源');
  } else if (name === 'read_published_source') {
    exactKeys(input, ['docId', 'revision']);
    identifier(input.docId, '来源');
    if (input.revision !== undefined) shortText(input.revision, 128, '来源版本');
  } else if (name === 'compile_research_brief') {
    exactKeys(input, ['goal', 'results']);
    shortText(input.goal, 1000, '研究目标');
    if (!Array.isArray(input.results) || !input.results.length || input.results.length > 8 || input.results.some(result => !Array.isArray(result?.sources))) throw runtimeError('汇编必须使用已完成的来源检索结果');
  } else if (name === 'save_research_brief') {
    exactKeys(input, ['brief']);
    if (!input.brief || typeof input.brief !== 'object') throw runtimeError('没有可保存的摘录');
    shortText(input.brief.content, 12000, '摘录');
    shortText(input.brief.title, 1000, '摘录标题');
  } else throw runtimeError('未接入隔离执行器的工具不可执行', 'SANDBOX_REQUIRED', 403);
}

function validatePlan(nodes, { now = Date.now(), getDefinition = getTool } = {}) {
  if (!Array.isArray(nodes) || !nodes.length || nodes.length > LIMITS.steps) throw runtimeError(`计划必须包含 1–${LIMITS.steps} 个步骤`);
  safeJson(nodes);
  if (Buffer.byteLength(JSON.stringify(nodes)) > 32000) throw runtimeError('计划输入过大');
  const ids = new Set();
  const steps = nodes.map(node => {
    exactKeys(node, ['id', 'label', 'tool', 'input', 'dependsOn', 'notBefore']);
    const id = identifier(node.id, '步骤标识');
    if (ids.has(id)) throw runtimeError('步骤标识不能重复');
    ids.add(id);
    const tool = getDefinition(node.tool);
    if (!tool || tool.execution !== 'worker') throw runtimeError('未知工具或尚未接入沙箱的工具不可加入执行计划', 'TOOL_UNAVAILABLE', 403);
    if (!Array.isArray(node.dependsOn) || node.dependsOn.length > LIMITS.steps || new Set(node.dependsOn).size !== node.dependsOn.length) throw runtimeError('依赖列表无效');
    node.dependsOn.forEach(value => identifier(value, '依赖步骤'));
    if (node.dependsOn.includes(id)) throw runtimeError('步骤不能依赖自身');
    if (!node.input || Array.isArray(node.input) || typeof node.input !== 'object') throw runtimeError('工具参数必须为对象');
    const refs = references(node.input);
    if (refs.some(ref => !node.dependsOn.includes(ref))) throw runtimeError('结果引用必须声明为直接依赖');
    if (node.notBefore !== undefined && node.notBefore !== null && (!Number.isSafeInteger(node.notBefore) || node.notBefore < 0 || node.notBefore > now + LIMITS.lifetimeMs)) throw runtimeError('计划时间最多延后7天');
    return {
      id, label: shortText(node.label || tool.label, 160, '步骤名称'), tool: tool.name, toolVersion: tool.version,
      input: copy(node.input), dependsOn: [...node.dependsOn], notBefore: node.notBefore || 0,
      status: 'pending', attempts: 0, result: null, resultHash: null, approval: null, error: null, retryAt: 0,
    };
  });
  const visited = new Set();
  const path = new Set();
  function visit(id) {
    if (path.has(id)) throw runtimeError('计划依赖包含环');
    if (visited.has(id)) return;
    const step = steps.find(item => item.id === id);
    if (!step) throw runtimeError('引用了不存在的依赖步骤');
    path.add(id);
    step.dependsOn.forEach(visit);
    path.delete(id);
    visited.add(id);
  }
  steps.forEach(step => visit(step.id));
  for (const step of steps) {
    if (step.tool === 'compile_research_brief') {
      exactKeys(step.input, ['goal', 'results']);
      shortText(step.input.goal, 1000, '研究目标');
      if (!Array.isArray(step.input.results) || !step.input.results.length || step.input.results.length > 8 || step.input.results.some(ref => !ref?.$from || ref.path?.length !== 0 || !['search_published_sources', 'read_published_source'].includes(steps.find(item => item.id === ref.$from)?.tool))) throw runtimeError('汇编只能引用检索或读取步骤的完整结果');
    } else if (step.tool === 'save_research_brief') {
      exactKeys(step.input, ['brief']);
      const ref = step.input.brief;
      if (!ref?.$from || ref.path?.length !== 0 || steps.find(item => item.id === ref.$from)?.tool !== 'compile_research_brief') throw runtimeError('保存只能引用汇编步骤的完整结果');
    } else if (!references(step.input).length) validateInput(step.tool, step.input);
  }
  return steps;
}

function researchPlan(goal, queries, persist = true, startAt = 0) {
  shortText(goal, 1000, '目标');
  if (!Array.isArray(queries) || !queries.length || queries.length > 6) throw runtimeError('请提供1–6个检索问题');
  const steps = queries.map((query, index) => ({
    id: `search_${index + 1}`, label: `检索：${shortText(query, 500, '检索问题').slice(0, 100)}`,
    tool: 'search_published_sources', input: { query: query.trim(), limit: 3 }, dependsOn: [], notBefore: startAt,
  }));
  steps.push({ id: 'compile', label: '归并资料并形成来源摘录', tool: 'compile_research_brief', input: { goal, results: steps.map(step => ({ $from: step.id, path: [] })) }, dependsOn: steps.map(step => step.id) });
  if (persist) steps.push({ id: 'save', label: '确认后保存个人摘录', tool: 'save_research_brief', input: { brief: { $from: 'compile', path: [] } }, dependsOn: ['compile'] });
  return steps;
}

const planDigest = steps => digest(steps.map(({ id, label, tool, toolVersion, input, dependsOn, notBefore }) => ({ id, label, tool, toolVersion, input, dependsOn, notBefore })));

module.exports = { getTool, getCatalog, validateInput, validatePlan, researchPlan, planDigest };
