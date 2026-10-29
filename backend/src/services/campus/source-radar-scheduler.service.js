'use strict';

const { logEvent } = require('../observability/observability.service');

let timer = null;

function startSourceRadarScheduler() {
  if (timer || process.env.CAMPUS_RADAR_ENABLED === 'false') return;
  const parsed = Number(process.env.CAMPUS_RADAR_INTERVAL_MS);
  const interval = Number.isFinite(parsed) && parsed >= 60000 ? Math.min(parsed, 86400000) : 300000;
  const enqueue = () => {
    Promise.resolve().then(() => require('../jobs/job.service').enqueueJob('campus.sources.check', {}, {
      idempotencyKey: `campus-radar:${Math.floor(Date.now() / interval)}`,
    })).catch(error => logEvent('warn', 'campus_radar_schedule_failed', { error: error.message }));
  };
  timer = setInterval(enqueue, interval);
  timer.unref?.();
  enqueue();
}

function stopSourceRadarScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { startSourceRadarScheduler, stopSourceRadarScheduler };
