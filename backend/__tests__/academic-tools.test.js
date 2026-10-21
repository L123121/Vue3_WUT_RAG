import { describe, expect, it, vi } from 'vitest';

const { createAcademicTools } = require('../src/services/agent/academic-tools.service');
const { ToolRegistry } = require('../src/services/agent/tool-registry.service');
const agentTools = require('../src/services/agent/agent-tools.service');

function registryWith(tool, enabled = true) {
  const registry = new ToolRegistry();
  registry.register({ ...tool, enabled });
  return registry;
}

describe('个人教务数据工具预留', () => {
  it('默认禁用，不进入 Agent schema，也无法调用', async () => {
    const tools = createAcademicTools();
    expect(tools.map(tool => tool.name)).toEqual(['get_my_grades', 'get_my_timetable']);
    const registry = new ToolRegistry();
    for (const tool of tools) registry.register(tool);
    expect(registry.getToolSchemas()).toEqual([]);
    expect((await registry.executeToolDetailed('get_my_grades', {}, { userId: 'user-a' })).ok).toBe(false);
    expect(agentTools.getToolNames()).not.toContain('get_my_grades');
    expect(agentTools.getToolNames()).not.toContain('get_my_timetable');
    expect(agentTools.toolRegistry.getTool('get_my_grades')?.enabled).toBe(false);
  });

  it.each(['get_my_grades', 'get_my_timetable'])('%s 无身份时不调用授权和数据源', async (name) => {
    const authorize = vi.fn(async () => true);
    const dataSource = { listGrades: vi.fn(), getTimetable: vi.fn() };
    const tool = createAcademicTools({ authorize, dataSource }).find(t => t.name === name);
    const result = await registryWith(tool).executeToolDetailed(name, {});
    expect(result.errorCode).toBe('authentication_required');
    expect(authorize).not.toHaveBeenCalled();
    expect(dataSource.listGrades).not.toHaveBeenCalled();
    expect(dataSource.getTimetable).not.toHaveBeenCalled();
  });

  it('没有授权机制或没有用户授权时拒绝，不能查询数据', async () => {
    const dataSource = { listGrades: vi.fn(async () => []) };
    const tool = createAcademicTools({ dataSource })[0];
    expect((await registryWith(tool).executeToolDetailed(tool.name, {}, { userId: 'user-a' })).errorCode)
      .toBe('authorization_unavailable');
    const denied = createAcademicTools({ dataSource, authorize: async () => false })[0];
    expect((await registryWith(denied).executeToolDetailed(denied.name, {}, { userId: 'user-a' })).errorCode)
      .toBe('permission_denied');
    expect(dataSource.listGrades).not.toHaveBeenCalled();
  });

  it('授权成功但未接教务接口时明确返回不可用，不编造个人数据', async () => {
    const authorize = vi.fn(async () => true);
    const tool = createAcademicTools({ authorize })[0];
    const result = await registryWith(tool).executeToolDetailed(tool.name, {}, { userId: 'user-a' });
    expect(result).toMatchObject({ ok: false, errorCode: 'data_source_unavailable', data: null });
    expect(authorize).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-a', scope: tool.name }));
  });

  it.each([
    ['get_my_grades', 'listGrades'],
    ['get_my_timetable', 'getTimetable'],
  ])('%s 只向正式接口透传服务端身份，拒绝模型指定其他人', async (name, method) => {
    const authorize = vi.fn(async () => true);
    const dataSource = { [method]: vi.fn(async () => [{ course: '高等数学' }]) };
    const tool = createAcademicTools({ dataSource, authorize }).find(t => t.name === name);
    const registry = registryWith(tool);
    const invalid = await registry.executeToolDetailed(name, { userId: 'user-b' }, { userId: 'user-a' });
    expect(invalid.errorCode).toBe('invalid_arguments');
    expect(authorize).not.toHaveBeenCalled();
    const result = await registry.executeToolDetailed(name, {}, { userId: 'user-a' });
    expect(result.ok).toBe(true);
    expect(result.data.items).toEqual([{ course: '高等数学' }]);
    expect(dataSource[method]).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-a' }));
  });
});
