import WebSocket from 'ws';
import {
  ANOMALY_METRIC_LOG_INTERVAL_MS,
  HEALTH_METRIC_LOG_INTERVAL_MS,
  LIVE_EDGE_MAX_QUEUE_SECONDS,
  audioBufferLimitBytes,
  estimateQueuedAudioMs,
  logAudioMetric,
  pendingAudioChunkLimit,
  pcm16Base64DurationMs,
} from './liveEdge.js';
import {
  FAST_RECONNECT_ATTEMPTS,
  isFirstSlowReconnect,
  reconnectDelayMs,
} from './reconnectPolicy.js';

const MODEL = 'gpt-realtime-translate';
const WS_URL = `wss://api.openai.com/v1/realtime/translations?model=${MODEL}`;
const OPENAI_AUDIO_BUFFER_LIMIT_BYTES = audioBufferLimitBytes(
  24_000,
  LIVE_EDGE_MAX_QUEUE_SECONDS,
  512_000,
);
const PENDING_AUDIO_CHUNK_LIMIT = pendingAudioChunkLimit(LIVE_EDGE_MAX_QUEUE_SECONDS);
export const OPENAI_GRACEFUL_CLOSE_TIMEOUT_MS = 2_000;

/** Convert one little-endian PCM16 chunk from Glotta's 16 kHz input to 24 kHz. */
export function resamplePcm16Base64(base64Chunk, inputRate = 16_000, outputRate = 24_000) {
  const input = Buffer.from(base64Chunk, 'base64');
  const inputSamples = Math.floor(input.length / 2);
  if (inputSamples === 0) return '';

  const outputSamples = Math.round(inputSamples * outputRate / inputRate);
  const output = Buffer.allocUnsafe(outputSamples * 2);
  for (let index = 0; index < outputSamples; index += 1) {
    const sourcePosition = index * inputRate / outputRate;
    const leftIndex = Math.min(Math.floor(sourcePosition), inputSamples - 1);
    const rightIndex = Math.min(leftIndex + 1, inputSamples - 1);
    const fraction = sourcePosition - leftIndex;
    const left = input.readInt16LE(leftIndex * 2);
    const right = input.readInt16LE(rightIndex * 2);
    const sample = Math.max(
      -32_768,
      Math.min(32_767, Math.round(left + ((right - left) * fraction))),
    );
    output.writeInt16LE(sample, index * 2);
  }
  return output.toString('base64');
}

export function openAISessionUpdate(targetLanguage) {
  // Translation sessions emit source transcript deltas themselves, so do not
  // attach a separate transcription model to the session.
  return {
    type: 'session.update',
    session: {
      audio: {
        output: { language: targetLanguage },
      },
    },
  };
}

/**
 * One server-side OpenAI Realtime Translation session for one target language.
 * Glotta supplies 16 kHz PCM16; OpenAI receives and returns 24 kHz PCM16.
 */
export class OpenAITranslator {
  constructor({
    apiKey,
    targetLanguage,
    onAudio,
    onTranscript,
    onError,
    onStatus,
    sessionId = 'unknown',
    streamKind = 'listener',
  }) {
    this.apiKey = apiKey;
    this.targetLanguage = targetLanguage;
    this.onAudio = onAudio;
    this.onTranscript = onTranscript;
    this.onError = onError;
    this.onStatus = onStatus;
    this.sessionId = sessionId;
    this.streamKind = streamKind;
    this.ws = null;
    this.ready = false;
    this.closedByUs = false;
    this.connecting = null;
    this.reconnectAttempts = 0;
    this.pendingAudio = [];
    this.connectionNumber = 0;
    this.reconnectStartedAt = null;
    this.firstInputAt = null;
    this.firstOutputObserved = false;
    this.firstSourceTranscriptObserved = false;
    this.droppedBufferedChunks = 0;
    this.droppedPendingChunks = 0;
    this.lastDropMetricAt = 0;
    this.audioUsageIntervalStartedAt = Date.now();
    this.inputAudioMs = 0;
    this.totalInputAudioMs = 0;
    this.closingPromise = null;
    this.closeResolve = null;
    this.closeTimer = null;
  }

  connect() {
    if (this.connecting) return this.connecting;
    this.connecting = new Promise((resolve, reject) => {
      const ws = new WebSocket(WS_URL, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });
      this.ws = ws;
      let settled = false;

      ws.on('open', () => {
        ws.send(JSON.stringify(openAISessionUpdate(this.targetLanguage)));
      });

      ws.on('message', (raw) => {
        const event = this.#parse(raw);
        if (!event) return;

        if (event.type === 'session.updated') {
          const reconnectAttempts = this.reconnectAttempts;
          const reconnectMs = this.reconnectStartedAt === null
            ? 0
            : Date.now() - this.reconnectStartedAt;
          this.ready = true;
          this.reconnectAttempts = 0;
          this.connectionNumber += 1;
          logAudioMetric({
            event: 'openai-setup',
            sessionId: this.sessionId,
            stream: this.streamKind,
            provider: 'openai',
            language: this.targetLanguage,
            connection: this.connectionNumber,
            reconnectMs,
            pendingChunks: this.pendingAudio.length,
            queueLimitSeconds: LIVE_EDGE_MAX_QUEUE_SECONDS,
          });
          if (reconnectAttempts > FAST_RECONNECT_ATTEMPTS) {
            logAudioMetric({
              event: 'provider-stream-recovered',
              sessionId: this.sessionId,
              stream: this.streamKind,
              provider: 'openai',
              language: this.targetLanguage,
              reconnectAttempts,
              recoveryMs: reconnectMs,
            });
          }
          this.reconnectStartedAt = null;
          this.firstInputAt = null;
          this.firstOutputObserved = false;
          this.firstSourceTranscriptObserved = false;
          this.onStatus?.('translator-online');
          this.#flushPendingAudio();
          if (!settled) {
            settled = true;
            resolve();
          }
          return;
        }

        if (event.type === 'session.output_audio.delta' && typeof event.delta === 'string') {
          if (!this.firstOutputObserved && this.firstInputAt !== null) {
            this.firstOutputObserved = true;
            logAudioMetric({
              event: 'openai-first-output',
              sessionId: this.sessionId,
              stream: this.streamKind,
              provider: 'openai',
              language: this.targetLanguage,
              connection: this.connectionNumber,
              firstOutputMs: Date.now() - this.firstInputAt,
            });
          }
          this.onAudio?.(event.delta);
          return;
        }

        if (event.type === 'session.output_transcript.delta' && typeof event.delta === 'string') {
          this.onTranscript?.('output', event.delta);
          return;
        }

        if (event.type === 'session.input_transcript.delta' && typeof event.delta === 'string') {
          this.#recordFirstSourceTranscript();
          this.onTranscript?.('input', event.delta);
          return;
        }

        if (event.type === 'session.closed') {
          try { ws.close(); } catch { /* already closing */ }
          this.#completeClose();
          return;
        }

        if (event.type === 'error') {
          const err = new Error(event.error?.message || 'OpenAI translation session error');
          console.error(`[openai:${this.targetLanguage}] session error:`, err.message);
          this.onError?.(err);
          if (!settled) {
            settled = true;
            reject(err);
          }
          try { ws.close(); } catch { /* already closing */ }
        }
      });

      ws.on('error', (error) => {
        const err = error instanceof Error ? error : new Error(String(error?.message ?? error));
        console.error(`[openai:${this.targetLanguage}] ws error:`, err.message);
        this.onError?.(err);
        if (!settled) {
          settled = true;
          reject(err);
        }
      });

      ws.on('close', (code, reasonBuffer) => {
        const reason = reasonBuffer?.toString?.() || '';
        if (!this.closedByUs) {
          logAudioMetric({
            event: 'openai-unexpected-close',
            sessionId: this.sessionId,
            stream: this.streamKind,
            provider: 'openai',
            language: this.targetLanguage,
            connection: this.connectionNumber,
            code,
            reason,
          });
        }
        this.ready = false;
        this.ws = null;
        if (!settled) {
          settled = true;
          reject(new Error(`closed before setup (${code} ${reason})`));
        }
        if (!this.closedByUs) {
          if (this.reconnectStartedAt === null) this.reconnectStartedAt = Date.now();
          this.onStatus?.('translator-reconnecting');
          this.#scheduleReconnect();
        }
        if (this.closeResolve) this.#completeClose();
      });
    });

    this.connecting.then(
      () => { this.connecting = null; },
      () => { this.connecting = null; },
    );
    return this.connecting;
  }

  #parse(raw) {
    try {
      const text = typeof raw === 'string'
        ? raw
        : Buffer.isBuffer(raw)
          ? raw.toString('utf8')
          : raw.toString();
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  #scheduleReconnect() {
    if (this.closedByUs) return;
    this.reconnectAttempts += 1;
    if (isFirstSlowReconnect(this.reconnectAttempts)) {
      logAudioMetric({
        event: 'provider-stream-unavailable',
        sessionId: this.sessionId,
        stream: this.streamKind,
        provider: 'openai',
        language: this.targetLanguage,
        reconnectAttempts: this.reconnectAttempts,
        retryEveryMs: reconnectDelayMs(this.reconnectAttempts),
      });
    }
    const delay = reconnectDelayMs(this.reconnectAttempts);
    setTimeout(() => {
      if (this.closedByUs) return;
      this.connect().catch((err) => {
        console.error(`[openai:${this.targetLanguage}] reconnect failed:`, err.message);
      });
    }, delay);
  }

  #queueAudio(base64Chunk) {
    if (this.closedByUs) return;
    this.pendingAudio.push(base64Chunk);
    if (this.pendingAudio.length > PENDING_AUDIO_CHUNK_LIMIT) {
      this.pendingAudio.shift();
      this.droppedPendingChunks += 1;
      this.#logDropMetric('openai-pending', this.pendingAudio.length * 100);
    }
  }

  #flushPendingAudio() {
    const chunks = this.pendingAudio.splice(0);
    for (const chunk of chunks) this.sendAudio(chunk);
  }

  /** @param {string} base64Chunk raw PCM 16-bit / 16 kHz / mono, base64-encoded */
  sendAudio(base64Chunk) {
    if (!this.ready || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.#queueAudio(base64Chunk);
      return;
    }
    if (this.ws.bufferedAmount > OPENAI_AUDIO_BUFFER_LIMIT_BYTES) {
      this.droppedBufferedChunks += 1;
      this.#logDropMetric(
        'openai-websocket',
        estimateQueuedAudioMs(this.ws.bufferedAmount, 24_000),
        this.ws.bufferedAmount,
      );
      return;
    }
    try {
      const audio = resamplePcm16Base64(base64Chunk);
      if (!audio) return;
      if (this.firstInputAt === null) this.firstInputAt = Date.now();
      this.ws.send(JSON.stringify({
        type: 'session.input_audio_buffer.append',
        audio,
      }));
      this.#recordInputAudioUsage(base64Chunk, 16_000);
    } catch (err) {
      console.error(`[openai:${this.targetLanguage}] send failed:`, err.message);
      this.#queueAudio(base64Chunk);
    }
  }

  #logDropMetric(stage, queuedMs, bufferedBytes = 0) {
    const now = Date.now();
    if (now - this.lastDropMetricAt < ANOMALY_METRIC_LOG_INTERVAL_MS) return;
    this.lastDropMetricAt = now;
    logAudioMetric({
      event: 'audio-dropped',
      sessionId: this.sessionId,
      stream: this.streamKind,
      provider: 'openai',
      language: this.targetLanguage,
      stage,
      queuedMs,
      bufferedBytes,
      droppedBufferedChunks: this.droppedBufferedChunks,
      droppedPendingChunks: this.droppedPendingChunks,
      queueLimitSeconds: LIVE_EDGE_MAX_QUEUE_SECONDS,
    });
  }

  #recordFirstSourceTranscript() {
    if (
      this.firstSourceTranscriptObserved
      || this.firstInputAt === null
    ) return;
    this.firstSourceTranscriptObserved = true;
    logAudioMetric({
      event: 'first-source-transcript',
      sessionId: this.sessionId,
      stream: this.streamKind,
      provider: 'openai',
      language: this.targetLanguage,
      connection: this.connectionNumber,
      firstSourceTranscriptMs: Date.now() - this.firstInputAt,
    });
  }

  #recordInputAudioUsage(base64Chunk, sampleRate) {
    const durationMs = pcm16Base64DurationMs(base64Chunk, sampleRate);
    this.inputAudioMs += durationMs;
    this.totalInputAudioMs += durationMs;
    if (Date.now() - this.audioUsageIntervalStartedAt >= HEALTH_METRIC_LOG_INTERVAL_MS) {
      this.#logInputAudioUsage('interval');
    }
  }

  #logInputAudioUsage(reason) {
    if (this.inputAudioMs <= 0) return;
    const now = Date.now();
    logAudioMetric({
      event: 'provider-audio-usage',
      sessionId: this.sessionId,
      stream: this.streamKind,
      provider: 'openai',
      language: this.targetLanguage,
      intervalMs: now - this.audioUsageIntervalStartedAt,
      inputAudioMs: this.inputAudioMs,
      totalInputAudioMs: this.totalInputAudioMs,
      reason,
    });
    this.audioUsageIntervalStartedAt = now;
    this.inputAudioMs = 0;
  }

  #completeClose() {
    if (this.closeTimer) clearTimeout(this.closeTimer);
    this.closeTimer = null;
    const resolve = this.closeResolve;
    this.closeResolve = null;
    this.pendingAudio = [];
    resolve?.();
  }

  close({ graceful = false, timeoutMs = OPENAI_GRACEFUL_CLOSE_TIMEOUT_MS } = {}) {
    if (this.closingPromise) return this.closingPromise;
    this.closedByUs = true;
    this.ready = false;
    this.#logInputAudioUsage('close');
    const ws = this.ws;
    if (graceful && ws?.readyState === WebSocket.OPEN) {
      this.closingPromise = new Promise((resolve) => {
        this.closeResolve = resolve;
        this.closeTimer = setTimeout(() => {
          try { ws.close(); } catch { /* already closed */ }
          if (this.ws === ws) this.ws = null;
          this.#completeClose();
        }, timeoutMs);
        try {
          ws.send(JSON.stringify({ type: 'session.close' }));
        } catch {
          try { ws.close(); } catch { /* already closed */ }
          if (this.ws === ws) this.ws = null;
          this.#completeClose();
        }
      });
      return this.closingPromise;
    }
    try {
      ws?.close();
    } catch {
      // already closed
    }
    this.ws = null;
    this.pendingAudio = [];
    return Promise.resolve();
  }
}
