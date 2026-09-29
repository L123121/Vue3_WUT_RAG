'use strict';

const { registerJobHandler } = require('./job.service');
const { logEvent } = require('../observability/observability.service');

function registerDefaultJobHandlers() {
  registerJobHandler('quality.audit', async (payload) => {
    const { recordAudit } = require('../agent/quality-governance.service');
    await recordAudit(payload);
  });

  registerJobHandler('wiki.relations.compile', async (payload) => {
    const { WikiService } = require('../wiki/wiki.service');
    const wikiService = new WikiService();
    await wikiService.compileRelatedPages(String(payload.docId));
  });

  registerJobHandler('uploads.cleanup', async () => {
    const { cleanOldUploads } = require('../knowledge/file-upload.service');
    await cleanOldUploads();
  });

  registerJobHandler('privacy.retention.sweep', async () => {
    const { sweepOnce } = require('../privacy/retention.service');
    await sweepOnce();
  });

  logEvent('info', 'background_job_handlers_registered', {
    types: ['quality.audit', 'wiki.relations.compile', 'uploads.cleanup', 'privacy.retention.sweep'],
  });
}

module.exports = { registerDefaultJobHandlers };
