"use strict";

const { applicationContainer } = require("../bootstrap/container");
const { operationalMetrics } = require("../services/observability/operational-metrics.service");

const createSpeechHandler = (
  service = applicationContainer.audioService,
  metrics = operationalMetrics,
) => async (req, res, next) => {
  const controller = new AbortController();
  const abortRequest = () => controller.abort();
  req.once("aborted", abortRequest);
  res.once("close", abortRequest);
  const cleanup = () => {
    req.removeListener("aborted", abortRequest);
    res.removeListener("close", abortRequest);
  };

  try {
    const startedAt = Date.now();
    const result = await service.synthesize(req.body?.text, { signal: controller.signal });
    if (!result.cacheHit) {
      metrics.recordTtsUsage({
        model: result.model,
        characters: result.characters ?? String(req.body?.text || '').length,
        traceId: req.traceId,
        latencyMs: Date.now() - startedAt,
      });
    }
    cleanup();
    if (controller.signal.aborted || res.destroyed) return;
    res.setHeader("Content-Type", result.contentType);
    res.setHeader("Content-Disposition", `inline; filename="assistant.${result.format}"`);
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("X-Audio-Cache", result.cacheHit ? "HIT" : "MISS");
    res.setHeader("Content-Length", result.buffer.length);
    res.send(result.buffer);
  } catch (error) {
    cleanup();
    if (controller.signal.aborted || res.destroyed) return;
    next(error);
  }
};

const speechHandler = createSpeechHandler();

module.exports = { createSpeechHandler, speechHandler };
