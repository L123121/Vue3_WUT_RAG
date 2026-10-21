"use strict";

const { TOOL_SOURCES } = require('./tool-registry.service');

// 接入前保持禁用。接入方须提供正式教务数据源和服务端授权校验，
// 再显式注册 enabled: true；仅有 Agent 登录态并不等于已授权教务数据。
function createAcademicTools({ dataSource = null, authorize = null } = {}) {
  function makeTool(name, description, method, label) {
    return {
      name,
      description,
      category: '个人教务数据',
      source: TOOL_SOURCES.BUILTIN,
      enabled: false,
      parallelSafe: true,
      sideEffect: false,
      timeoutMs: 15000,
      // 不接受模型传入的学号/userId；只能查询经服务器认证的当前用户。
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      handler: async (_args, context = {}) => {
        const userId = context.userId;
        if (typeof userId !== 'string' || !userId.trim()) {
          return { ok: false, errorCode: 'authentication_required', content: '查询个人教务数据需要先登录。' };
        }
        if (typeof authorize !== 'function') {
          return { ok: false, errorCode: 'authorization_unavailable', content: '个人教务数据授权机制尚未接入。' };
        }
        // authorize 必须在服务端确认：当前用户已授权、授权未过期，且已绑定其本人教务身份。
        // 不能把 LLM/客户端传来的身份或授权声明当成校验依据。
        let allowed = false;
        try {
          allowed = await authorize({ userId, scope: name, signal: context.signal }) === true;
        } catch {
          return { ok: false, errorCode: 'authorization_unavailable', content: '暂时无法核验个人教务数据授权。' };
        }
        if (!allowed) {
          return { ok: false, errorCode: 'permission_denied', content: '尚未获得查询该项个人教务数据的授权。' };
        }
        if (typeof dataSource?.[method] !== 'function') {
          return { ok: false, errorCode: 'data_source_unavailable', content: '正式教务数据接口尚未接入。' };
        }
        try {
          // 数据源必须按已授权 userId 解析其绑定的教务身份，不能开放任意身份查询。
          const items = await dataSource[method]({ userId, signal: context.signal });
          if (!Array.isArray(items)) throw new Error('invalid academic data');
          return {
            ok: true,
            content: `${label}：${JSON.stringify(items)}`,
            uiSummary: `已查询${label}`,
            data: { items },
          };
        } catch (error) {
          if (context.signal?.aborted) throw error;
          return { ok: false, errorCode: 'data_source_error', content: '个人教务数据查询失败，请稍后重试。' };
        }
      },
    };
  }

  return [
    makeTool('get_my_grades', '查询当前已登录且已授权用户本人的成绩。', 'listGrades', '我的成绩'),
    makeTool('get_my_timetable', '查询当前已登录且已授权用户本人的课表。', 'getTimetable', '我的课表'),
  ];
}

module.exports = { createAcademicTools };
