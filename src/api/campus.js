import { apiGet, apiPost, apiPut, apiDelete } from './client.js';

async function data(request) {
  const response = await request;
  const body = await response.json();
  if (!body.success) throw new Error(body.message || '校园工作台请求失败');
  return body.data;
}

export const getWorkbench = () => data(apiGet('/campus'));
export const getCampusTask = id => data(apiGet(`/campus/tasks/${encodeURIComponent(id)}`));
export const createCampusTask = input => data(apiPost('/campus/tasks', input));
export const updateCampusTask = (id, input) => data(apiPut(`/campus/tasks/${encodeURIComponent(id)}`, input));
export const deleteCampusTask = (id, version) => data(apiDelete(`/campus/tasks/${encodeURIComponent(id)}?version=${version}`));
export const subscribeSource = docId => data(apiPost('/campus/subscriptions', { docId }));
export const updateSourceSubscription = (docId, input) => data(apiPut(`/campus/subscriptions/${encodeURIComponent(docId)}`, input));
export const refreshWorkbench = () => data(apiPost('/campus/refresh', {}));
export const reviewAnswerEvidence = input => data(apiPost('/campus/evidence', input));
