"use strict";

const { applicationContainer } = require("../bootstrap/container");
const jobService = require('../services/jobs/job.service');
const {
  createStreamContext,
  writeRunCompleted,
  writeRunFailed,
  writeRunStarted,
  writeSse,
  writeStreamEvent,
} = require("../utils/sse-events");
const { logEvent } = require("../services/observability/observability.service");
const { emptyDraft, applyEvent, finalize } = require("../utils/decision-draft");

function createChatHandlers(conversationOrchestrator, dependencies = {}) {
  const enqueueJob = dependencies.enqueueJob || jobService.enqueueJob;
  const streamHandler = async (req, res, next) => {
    let abortController = null;
    let onClientClose = null;
    let streamContext = null;
    const cleanupClientClose = () => {
      if (onClientClose) res.removeListener("close", onClientClose);
    };

    try {
      const body = req.body || {};
      const { message, history } = body;
      if (!message) return res.status(400).json({ error: "消息内容不能为空" });

      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders();

      streamContext = createStreamContext({
        streamVersion: body.streamVersion,
        runId: body.runId,
        attempt: body.attempt,
        traceId: req.traceId,
      });
      abortController = new AbortController();
      onClientClose = () => abortController.abort();
      res.on("close", onClientClose);

      const context = {
        traceId: req.traceId,
        runId: streamContext.runId,
        attempt: streamContext.attempt,
        userId: req.userId,
        conversationId: body.conversationId || null,
        signal: abortController.signal,
      };
      writeRunStarted(res, streamContext, { conversationId: context.conversationId });

      const audit = { answer: "", sources: [], traceId: req.traceId };
      // agent 决策草稿：tool_call 出现即被废弃，不计入审计答案。
      // 状态机复用 utils/decision-draft，与 agent/编排层同源（此前三处各写一份）
      let draft = emptyDraft();
      for await (const event of conversationOrchestrator.chatStream(message, history || [], context)) {
        draft = applyEvent(draft, event);
        if (event.type === "sources") audit.sources = event.sources || [];
        if (event.type === "trace" && event.trace?.traceId) audit.traceId = event.trace.traceId;
        writeStreamEvent(res, event, streamContext);
      }
      const { reply: finalAnswer } = finalize(draft);
      audit.answer = finalAnswer;

      writeRunCompleted(res, streamContext);
      try {
        Promise.resolve(enqueueJob('quality.audit', {
          question: message,
          answer: audit.answer,
          sources: audit.sources,
          traceId: audit.traceId,
          userId: req.userId,
          route: audit.sources.length ? "rag-stream" : "chat-stream",
        }, { idempotencyKey: `audit:${audit.traceId}:${streamContext.runId}` })).catch((error) => {
          logEvent("warn", "quality_audit_job_enqueue_failed", { scope: "chat_stream", error: error.message });
        });
      } catch (error) {
        logEvent("warn", "quality_audit_job_enqueue_failed", { scope: "chat_stream", error: error.message });
      }
      cleanupClientClose();
      res.end();
    } catch (error) {
      cleanupClientClose();
      if (abortController?.signal.aborted) return;
      logEvent("error", "chat_stream_error", { error: error.message, stack: error.stack });
      if (!res.headersSent) return next(error);
      try {
        if (streamContext?.streamVersion === 1) writeRunFailed(res, streamContext, error);
        else writeSse(res, { error: error.message });
        res.end();
      } catch {
        // 连接已关闭，忽略
      }
    }
  };

  return { streamHandler };
}

const { streamHandler } = createChatHandlers(applicationContainer.conversationOrchestrator);

module.exports = { createChatHandlers, streamHandler, writeStreamEvent };
