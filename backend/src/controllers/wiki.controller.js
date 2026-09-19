"use strict";

const { WikiService } = require('../services/wiki.service');
const { successResponse, errorResponse } = require('../utils/response');
const { logEvent } = require('../services/observability.service');

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

module.exports = { listEntries, getEntry, setEntryVisibility };
