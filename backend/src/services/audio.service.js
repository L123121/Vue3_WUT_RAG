"use strict";

const config = require("../config");
const crypto = require("crypto");
const { logEvent } = require('./observability.service');

const SUPPORTED_MODELS = new Set(["step-tts-2", "step-tts-mini", "stepaudio-2.5-tts"]);
const SUPPORTED_FORMATS = new Set(["wav", "mp3", "flac", "opus", "pcm"]);

function normalizeSpeechText(value) {
  return String(value || "")
    .replace(/```[\s\S]*?```/g, " 代码内容已省略。 ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+[.)、]\s+/gm, "")
    .replace(/[>*_~|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function createHttpError(message, statusCode, code) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.expose = true;
  if (code) error.code = code;
  return error;
}

function getUpstreamSpeechError(detail, statusCode) {
  try {
    const payload = JSON.parse(detail);
    const code = payload?.error?.type || payload?.code;
    if (code === "quota_exceeded" || statusCode === 402) {
      return createHttpError("语音服务额度已耗尽，已切换为浏览器朗读", 402, "TTS_QUOTA_EXCEEDED");
    }
  } catch {
    // 上游未返回 JSON 时使用通用错误。
  }
  return createHttpError("语音生成失败，请稍后重试", 502, "TTS_UPSTREAM_ERROR");
}

function createAbortError(reason) {
  if (reason instanceof Error && reason.name === "AbortError") return reason;
  const error = reason instanceof Error ? reason : new Error("Aborted");
  error.name = "AbortError";
  return error;
}

function createAbortContext(externalSignal, timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromExternal = () => controller.abort(externalSignal?.reason);
  if (externalSignal?.aborted) abortFromExternal();
  else externalSignal?.addEventListener("abort", abortFromExternal, { once: true });
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  return {
    signal: controller.signal,
    didTimeOut: () => timedOut,
    cleanup: () => {
      clearTimeout(timeoutId);
      externalSignal?.removeEventListener("abort", abortFromExternal);
    },
  };
}

class AudioCache {
  constructor(options = {}) {
    this.ttlMs = options.ttlMs || 30 * 60 * 1000;
    this.maxEntries = options.maxEntries || 100;
    this.maxBytes = options.maxBytes || 64 * 1024 * 1024;
    this.entries = new Map();
    this.totalBytes = 0;
  }

  get(key) {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.delete(key);
      return null;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key, value) {
    const size = value.buffer.length;
    if (size > this.maxBytes) return;
    this.delete(key);
    this.entries.set(key, {
      value,
      size,
      expiresAt: Date.now() + this.ttlMs,
    });
    this.totalBytes += size;
    while (this.entries.size > this.maxEntries || this.totalBytes > this.maxBytes) {
      const oldestKey = this.entries.keys().next().value;
      this.delete(oldestKey);
    }
  }

  delete(key) {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.totalBytes -= entry.size;
  }
}

class AudioService {
  constructor(options = {}) {
    this.config = options.config || config.audio;
    this.fetch = options.fetch || globalThis.fetch;
    this.cache = options.cache || new AudioCache({
      ttlMs: this.config.cacheTtlMs,
      maxEntries: this.config.cacheMaxEntries,
      maxBytes: this.config.cacheMaxBytes,
    });
    this.inFlight = new Map();
  }

  async synthesize(text, options = {}) {
    if (options.signal?.aborted) {
      const error = new Error("Aborted");
      error.name = "AbortError";
      throw error;
    }
    if (!this.config.apiKey) {
      throw createHttpError("语音服务尚未配置 STEPFUN_API_KEY", 503);
    }
    if (typeof this.fetch !== "function") {
      throw createHttpError("当前运行环境不支持语音请求", 500);
    }

    const input = normalizeSpeechText(text);
    if (!input) throw createHttpError("没有可朗读的文本", 400);
    if (input.length > this.config.maxInputLength) {
      throw createHttpError(`单次朗读不能超过 ${this.config.maxInputLength} 个字符`, 400);
    }

    const model = SUPPORTED_MODELS.has(this.config.model)
      ? this.config.model
      : "stepaudio-2.5-tts";
    const responseFormat = SUPPORTED_FORMATS.has(this.config.responseFormat)
      ? this.config.responseFormat
      : "mp3";
    const payload = {
      model,
      input,
      voice: this.config.voice,
      response_format: responseFormat,
      speed: Number.isFinite(this.config.speed) ? this.config.speed : 1,
      text_normalization: "enhanced",
      markdown_filter: true,
    };
    if (model === "stepaudio-2.5-tts" && this.config.instruction) {
      payload.instruction = this.config.instruction.slice(0, 200);
    }

    const cacheKey = crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
    const cached = this.config.cacheEnabled === false ? null : this.cache.get(cacheKey);
    if (cached) return { ...cached, cacheHit: true };

    let entry = this.inFlight.get(cacheKey);
    if (!entry) {
      entry = this._createInFlightRequest(cacheKey, payload, responseFormat);
    }
    return this._waitForInFlight(entry, options.signal);
  }

  _createInFlightRequest(cacheKey, payload, responseFormat) {
    const controller = new AbortController();
    const entry = {
      controller,
      consumers: 0,
      settled: false,
      usageClaimed: false,
      promise: null,
    };
    entry.promise = this._requestSpeech(payload, responseFormat, controller.signal)
      .then((result) => {
        if (this.config.cacheEnabled !== false) this.cache.set(cacheKey, result);
        return result;
      })
      .finally(() => {
        entry.settled = true;
        if (this.inFlight.get(cacheKey) === entry) this.inFlight.delete(cacheKey);
      });
    this.inFlight.set(cacheKey, entry);
    return entry;
  }

  async _waitForInFlight(entry, signal) {
    if (signal?.aborted) throw createAbortError(signal.reason);
    entry.consumers += 1;
    let abortHandler;
    const abortPromise = signal ? new Promise((_resolve, reject) => {
      abortHandler = () => reject(createAbortError(signal.reason));
      signal.addEventListener("abort", abortHandler, { once: true });
    }) : null;

    try {
      const result = await (abortPromise ? Promise.race([entry.promise, abortPromise]) : entry.promise);
      const cacheHit = entry.usageClaimed;
      entry.usageClaimed = true;
      return { ...result, cacheHit };
    } finally {
      signal?.removeEventListener("abort", abortHandler);
      entry.consumers -= 1;
      if (entry.consumers === 0 && !entry.settled) {
        for (const [key, current] of this.inFlight.entries()) {
          if (current === entry) this.inFlight.delete(key);
        }
        entry.controller.abort(createAbortError());
      }
    }
  }

  async _requestSpeech(payload, responseFormat, signal) {
    const baseUrl = String(this.config.baseUrl || "https://api.stepfun.com/v1").replace(/\/$/, "");
    const abortContext = createAbortContext(signal, this.config.timeout || 60000);
    const maxAudioBytes = Number.isFinite(this.config.maxAudioBytes) && this.config.maxAudioBytes > 0
      ? this.config.maxAudioBytes
      : 16 * 1024 * 1024;

    try {
      const response = await this.fetch(`${baseUrl}/audio/speech`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: abortContext.signal,
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        logEvent('error', 'audio_upstream_request_failed', { status: response.status, detail: detail.slice(0, 500) });
        throw getUpstreamSpeechError(detail, response.status);
      }

      const contentLength = Number.parseInt(response.headers.get("content-length") || "", 10);
      if (Number.isFinite(contentLength) && contentLength > maxAudioBytes) {
        throw createHttpError("语音响应过大，请缩短朗读内容", 502);
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length > maxAudioBytes) {
        throw createHttpError("语音响应过大，请缩短朗读内容", 502);
      }

      return {
        buffer,
        contentType: response.headers.get("content-type") || `audio/${responseFormat}`,
        format: responseFormat,
        model: payload.model,
        characters: payload.input.length,
      };
    } catch (error) {
      if (error?.statusCode) throw error;
      if (abortContext.didTimeOut()) {
        throw createHttpError("语音生成超时，请稍后重试", 504);
      }
      if (signal?.aborted || error?.name === "AbortError") {
        throw createAbortError(signal?.reason || error);
      }
      throw createHttpError(`语音服务连接失败：${error.message}`, 502);
    } finally {
      abortContext.cleanup();
    }
  }
}

const audioService = new AudioService();

module.exports = { AudioService, audioService, normalizeSpeechText };
