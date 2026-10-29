import { apiGet, apiPost, apiPut, apiDelete } from './client.js';

async function data(request) {
  const response = await request;
  const result = await response.json();
  if (!result.success) throw new Error(result.message || 'Agent任务请求失败');
  return result.data;
}
const runPath = id => `/agent-runs/${encodeURIComponent(id)}`;
export const listAgentRuns = () => data(apiGet('/agent-runs'));
export const getAgentRun = id => data(apiGet(runPath(id)));
export const createAgentRun = input => data(apiPost('/agent-runs', input));
export const editAgentPlan = (id, input) => data(apiPut(`${runPath(id)}/plan`, input));
export const startAgentRun = (id, version) => data(apiPost(`${runPath(id)}/start`, { version }));
export const pauseAgentRun = (id, version) => data(apiPost(`${runPath(id)}/pause`, { version }));
export const cancelAgentRun = (id, version) => data(apiPost(`${runPath(id)}/cancel`, { version }));
export const resumeAgentRun = (id, version) => data(apiPost(`${runPath(id)}/resume`, { version }));
export const approveAgentStep = (id, stepId, input) => data(apiPost(`${runPath(id)}/steps/${encodeURIComponent(stepId)}/approval`, input));
export const getAgentEvents = (id, after = 0) => data(apiGet(`${runPath(id)}/events?after=${after}`));
export const replayAgentRun = (id, through) => data(apiGet(`${runPath(id)}/replay?through=${through}`));
export const removeAgentRun = (id, version) => data(apiDelete(`${runPath(id)}?version=${version}`));
export const getAgentToolPolicies = () => data(apiGet('/agent-runs/tools'));
export const updateAgentToolPolicy = input => data(apiPut('/agent-runs/tools/policy', input));
