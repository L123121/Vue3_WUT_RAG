"use strict";

const { WikiService } = require('../services/wiki/wiki.service');
const { successResponse, errorResponse } = require('../utils/response');
const { logEvent } = require('../services/observability/observability.service');

const wikiService = new WikiService();

// 未上架词条只对管理员可见（阅读面与治理面共用同一接口，靠角色区分）
const isPrivileged = (req) => req.role === 'admin';

const listEntries = async (req, res, next) => {
  try {
    const { q, includeHidden } = req.query;
    const result = await wikiService.listEntries({
      query: q,
      includeHidden: includeHidden === 'true' && isPrivileged(req),
    });
    successResponse(res, result, '获取成功');
  } catch (error) {
    logEvent('error', 'wiki_list_failed', { error: error.message, stack: error.stack });
    next(error);
  }
};

const getEntry = async (req, res, next) => {
  try {
    const entry = await wikiService.getEntry(req.params.idOrSlug, { privileged: isPrivileged(req) });
    if (!entry) return errorResponse(res, '词条不存在或尚未上架', 404);
    successResponse(res, entry, '获取成功');
  } catch (error) {
    logEvent('error', 'wiki_detail_failed', { error: error.message, id: req.params.idOrSlug, stack: error.stack });
    next(error);
  }
};

const getEntryRevisions = async (req, res, next) => {
  try {
    const docId = req.params.docId;
    const entry = await wikiService.getEntry(docId, { privileged: isPrivileged(req) });
    if (!entry) return errorResponse(res, '词条不存在或尚未上架', 404);
    successResponse(res, { docId, stale: entry.stale, revisions: await wikiService.getRevisionHistory(docId) }, '获取成功');
  } catch (error) {
    logEvent('error', 'wiki_revisions_failed', { error: error.message, id: req.params.docId, stack: error.stack });
    next(error);
  }
};

const setEntryVisibility = async (req, res, _next) => {
  try {
    const { docId } = req.params;
    const { visible, allowSimulated } = req.body || {};
    const result = await wikiService.setVisibility({
      docId,
      visible: visible === true,
      allowSimulated: allowSimulated === true,
      userId: req.userId,
    });
    successResponse(res, result, visible === true ? '词条已上架' : '词条已下架');
  } catch (error) {
    const status = Number.isInteger(error.status) ? error.status : 500;
    if (status >= 500) logEvent('error', 'wiki_visibility_failed', { error: error.message, stack: error.stack });
    errorResponse(res, error.message, status);
  }
};

// 手动重算互链：编译期产物默认只在上架时异步触发，LLM 失败或候选池变化后
// 管理员可用这个接口显式重算，不必靠反复切换上下架来间接触发
const recompileEntryRelations = async (req, res, next) => {
  try {
    const { docId } = req.params;
    const meta = await wikiService.getMeta(docId);
    if (!meta?.visible) return errorResponse(res, '词条未上架，无法重算互链', 409);
    await wikiService.compileRelatedPages(docId);
    const entry = await wikiService.getEntry(docId, { privileged: true });
    successResponse(res, { docId, relatedPages: entry?.relatedPages || [] }, '互链已重新梳理');
  } catch (error) {
    logEvent('error', 'wiki_relation_recompile_failed', { error: error.message, id: req.params.docId, stack: error.stack });
    next(error);
  }
};

module.exports = { listEntries, getEntry, getEntryRevisions, setEntryVisibility, recompileEntryRelations };
