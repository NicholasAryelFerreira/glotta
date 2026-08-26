import WebSocket from 'ws';
import {
  LIVE_EDGE_MAX_QUEUE_SECONDS,
  audioBufferLimitBytes,
  estimateQueuedAudioMs,
  logAudioMetric,
  pendingAudioChunkLimit,
} from './liveEdge.js';

const MODEL = 'gemini-3.5-live-translate-preview';

// The Gemini Live API endpoint. We talk to it over a raw WebSocket because the
// installed @google/genai SDK does not yet know about `translationConfig` and
// silently drops it from the setup message — which made every translation come
// back in the default language (English). Speaking the protocol directly lets
// us send the translation config exactly as documented.
const API_VERSION = process.env.GEMINI_API_VERSION || 'v1beta';
const WS_BASE = 'wss://generativelanguage.googleapis.com';
const GEMINI_AUDIO_BUFFER_LIMIT_BYTES = audioBufferLimitBytes(
  16_000,
  LIVE_EDGE_MAX_QUEUE_SECONDS,
  512_000,
);
const PENDING_AUDIO_CHUNK_LIMIT = pendingAudioChunkLimit(LIVE_EDGE_MAX_QUEUE_SECONDS);
const AUDIO_METRIC_LOG_INTERVAL_MS = 10_000;

function tokenCount(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function modalityDetails(details) {
  if (!Array.isArray(details)) return [];
  return details
    .map((detail) => ({
      modality: detail?.modality ?? null,
      tokenCount: tokenCount(detail?.tokenCount ?? detail?.token_count),
    }))
    .filter((detail) => detail.modality !== null || detail.tokenCount !== null);
}

/** Normalize both raw-WebSocket and SDK naming without logging content. */
export function normalizeUsageMetadata(usage = {}) {
  return {
    promptTokenCount: tokenCount(usage.promptTokenCount ?? usage.prompt_token_count),
    responseTokenCount: tokenCount(
      usage.responseTokenCount
      ?? usage.response_token_count
      ?? usage.candidatesTokenCount
      ?? usage.candidates_token_count,
    ),
    thoughtsTokenCount: tokenCount(usage.thoughtsTokenCount ?? usage.thoughts_token_count),
    cachedContentTokenCount: tokenCount(
      usage.cachedContentTokenCount ?? usage.cached_content_token_count,
    ),
    toolUsePromptTokenCount: tokenCount(
      usage.toolUsePromptTokenCount ?? usage.tool_use_prompt_token_count,
    ),
    totalTokenCount: tokenCount(usage.totalTokenCount ?? usage.total_token_count),
    promptTokensDetails: modalityDetails(
      usage.promptTokensDetails ?? usage.prompt_tokens_details,
    ),
    responseTokensDetails: modalityDetails(
      usage.responseTokensDetails
      ?? usage.response_tokens_details
      ?? usage.candidatesTokensDetails
      ?? usage.candidates_tokens_details,
    ),
    serviceTier: usage.serviceTier ?? usage.service_tier ?? null,
  };
}

export function transcriptionSetupFields({
  inputAudioTranscription = true,
  outputAudioTranscription = true,
} = {}) {
  return {
    ...(inputAudioTranscription ? { inputAudioTranscription: {} } : {}),
    ...(outputAudioTranscription ? { outputAudioTranscription: {} } : {}),
  };
}

/**
 * Wraps one Gemini Live translation session for a single target language.
 * Audio in: base64 raw PCM 16-bit / 16 kHz / mono.
 * Audio out (via onAudio): base64 raw PCM 16-bit / 24 kHz / mono.
 *
 * Reconnects automatically if Gemini closes the session while we still have
 * listeners (live sessions have server-side duration limits, and a sermon can
 * easily outlast them).
 */
export class Translator {
  /**
   * @param {object} opts
   * @param {string} opts.apiKey
   * @param {string} opts.targetLanguage BCP-47 code, e.g. "es"
   * @param {boolean} opts.echoTargetLanguage
   * @param {(base64Audio: string) => void} opts.onAudio
   * @param {(kind: 'input'|'output', text: string) => void} opts.onTranscript
   * @param {(err: Error) => void} opts.onError
   * @param {(state: 'translator-online'|'translator-reconnecting') => void} [opts.onStatus]
   * @param {string} [opts.sessionId]
   * @param {string} [opts.streamKind]
   * @param {'free'|'paid'} [opts.apiTier]
   * @param {'free'|'paid'} [opts.billingApiTier]
   * @param {boolean} [opts.inputAudioTranscription]
   * @param {boolean} [opts.outputAudioTranscription]
   */
  constructor({
    apiKey,
    targetLanguage,
    echoTargetLanguage = false,
    onAudio,
    onTranscript,
    onError,
    onStatus,
    sessionId = 'unknown',
    streamKind = 'listener',
    apiTier = 'free',
    billingApiTier = apiTier,
    inputAudioTranscription = true,
    outputAudioTranscription = true,
  }) {
    this.apiKey = apiKey;
    this.targetLanguage = targetLanguage;
    this.echoTargetLanguage = echoTargetLanguage;
    this.onAudio = onAudio;
    this.onTranscript = onTranscript;
    this.onError = onError;
    this.onStatus = onStatus;
    this.sessionId = sessionId;
    this.streamKind = streamKind;
    this.apiTier = apiTier;
    this.billingApiTier = billingApiTier;
    this.inputAudioTranscription = inputAudioTranscription;
    this.outputAudioTranscription = outputAudioTranscription;
    this.ws = null;
    this.ready = false; // true once the server acknowledges setup
    this.closedByUs = false;
    this.connecting = null;
    this.reconnectAttempts = 0;
    this.pendingAudio = [];
    this.resumptionHandle = null;
    this.connectionNumber = 0;
    this.reconnectStartedAt = null;
    this.firstInputAt = null;
    this.firstOutputObserved = false;
    this.droppedBufferedChunks = 0;
    this.droppedPendingChunks = 0;
    this.lastDropMetricAt = 0;
    this.turnNumber = 1;
    this.usageReportNumber = 0;
  }

  connect() {
    if (this.connecting) return this.connecting;
    this.connecting = new Promise((resolve, reject) => {
      const url = `${WS_BASE}/ws/google.ai.generativelanguage.${API_VERSION}.GenerativeService.BidiGenerateContent?key=${this.apiKey}`;
      const ws = new WebSocket(url);
      this.ws = ws;
      let settled = false;

      ws.on('open', () => {
        ws.send(JSON.stringify(this.#setupMessage()));
      });

      ws.on('message', (raw) => {
        const msg = this.#parse(raw);
        if (!msg) return;
        if (msg.setupComplete || msg.setup_complete) {
          this.ready = true;
          this.reconnectAttempts = 0;
          this.connectionNumber += 1;
          console.log(
            `[gemini:${this.targetLanguage}] setup complete ` +
            `(connection ${this.connectionNumber}${this.resumptionHandle ? ', resumed' : ''})`,
          );
          logAudioMetric({
            event: 'gemini-setup',
            sessionId: this.sessionId,
            stream: this.streamKind,
            apiTier: this.apiTier,
            language: this.targetLanguage,
            connection: this.connectionNumber,
            resumed: Boolean(this.resumptionHandle),
            reconnectMs: this.reconnectStartedAt === null ? 0 : Date.now() - this.reconnectStartedAt,
            pendingChunks: this.pendingAudio.length,
            queueLimitSeconds: LIVE_EDGE_MAX_QUEUE_SECONDS,
          });
          this.reconnectStartedAt = null;
          this.firstInputAt = null;
          this.firstOutputObserved = false;
          this.onStatus?.('translator-online');
          this.#flushPendingAudio();
          if (!settled) {
            settled = true;
            resolve();
          }
          return;
        }
        this.#handleUsageMetadata(msg);
        this.#handleSessionManagement(msg);
        if (this.#handleServerContent(msg)) this.turnNumber += 1;
      });

      ws.on('error', (e) => {
        const err = e instanceof Error ? e : new Error(String(e?.message ?? e));
        console.error(`[gemini:${this.targetLanguage}] ws error:`, err.message);
        this.onError?.(err);
        if (!settled) {
          settled = true;
          reject(err);
        }
      });

      ws.on('close', (code, reasonBuf) => {
        const reason = reasonBuf?.toString?.() || '';
        console.log(`[gemini:${this.targetLanguage}] closed (${code}${reason ? ' ' + reason : ''})`);
        this.ready = false;
        this.ws = null;
        if (!settled) {
          settled = true;
          reject(new Error(`closed before setup (${code} ${reason})`));
        }
        if (!this.closedByUs) {
          this.reconnectStartedAt = Date.now();
          this.onStatus?.('translator-reconnecting');
          this.#scheduleReconnect();
        }
      });
    });

    this.connecting.then(
      () => { this.connecting = null; },
      () => { this.connecting = null; },
    );
    return this.connecting;
  }

  #setupMessage() {
    return {
      setup: {
        model: `models/${MODEL}`,
        generationConfig: {
          responseModalities: ['AUDIO'],
          translationConfig: {
            targetLanguageCode: this.targetLanguage,
            echoTargetLanguage: this.echoTargetLanguage,
          },
        },
        ...transcriptionSetupFields({
          inputAudioTranscription: this.inputAudioTranscription,
          outputAudioTranscription: this.outputAudioTranscription,
        }),
        // Gemini periodically replaces Live API WebSocket connections. Keep
        // the same logical session across those replacements so context and
        // voice continuity have the best chance of surviving the handoff.
        sessionResumption: this.resumptionHandle ? { handle: this.resumptionHandle } : {},
        // A sermon can exceed the default audio-only context lifetime.
        contextWindowCompression: { slidingWindow: {} },
      },
    };
  }

  #handleSessionManagement(msg) {
    const update = msg.sessionResumptionUpdate || msg.session_resumption_update;
    const handle = update?.newHandle || update?.new_handle || update?.token;
    if (update?.resumable && handle) this.resumptionHandle = handle;

    const goAway = msg.goAway || msg.go_away;
    if (goAway) {
      const timeLeft = goAway.timeLeft || goAway.time_left || 'unknown';
      console.log(`[gemini:${this.targetLanguage}] server GoAway (time left: ${JSON.stringify(timeLeft)})`);
    }
  }

  #parse(raw) {
    try {
      const text = typeof raw === 'string' ? raw : Buffer.isBuffer(raw) ? raw.toString('utf8') : raw.toString();
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  #handleUsageMetadata(msg) {
    const usage = msg.usageMetadata || msg.usage_metadata;
    if (!usage) return;
    const content = msg.serverContent || msg.server_content;
    this.usageReportNumber += 1;
    console.log(`[gemini-usage] ${JSON.stringify({
      ts: new Date().toISOString(),
      sessionId: this.sessionId,
      stream: this.streamKind,
      selectedApiTier: this.apiTier,
      billingApiTier: this.billingApiTier,
      language: this.targetLanguage,
      connection: this.connectionNumber,
      turn: this.turnNumber,
      report: this.usageReportNumber,
      turnComplete: Boolean(content?.turnComplete ?? content?.turn_complete),
      ...normalizeUsageMetadata(usage),
    })}`);
  }

  #handleServerContent(msg) {
    const content = msg.serverContent || msg.server_content;
    if (!content) return false;

    const inputT = content.inputTranscription || content.input_transcription;
    if (inputT?.text) this.onTranscript?.('input', inputT.text);

    const outputT = content.outputTranscription || content.output_transcription;
    if (outputT?.text) this.onTranscript?.('output', outputT.text);

    const turn = content.modelTurn || content.model_turn;
    const parts = turn?.parts ?? [];
    for (const part of parts) {
      const inline = part.inlineData || part.inline_data;
      if (inline?.data) {
        if (!this.firstOutputObserved && this.firstInputAt !== null) {
          this.firstOutputObserved = true;
          logAudioMetric({
            event: 'gemini-first-output',
            sessionId: this.sessionId,
            stream: this.streamKind,
            apiTier: this.apiTier,
            language: this.targetLanguage,
            connection: this.connectionNumber,
            firstOutputMs: Date.now() - this.firstInputAt,
          });
        }
        this.onAudio?.(inline.data);
      }
    }
    return Boolean(content.turnComplete ?? content.turn_complete);
  }

  #scheduleReconnect() {
    if (this.closedByUs) return;
    this.reconnectAttempts += 1;
    if (this.reconnectAttempts > 5) {
      this.onError?.(new Error(`Translation for ${this.targetLanguage} could not be re-established`));
      return;
    }
    const delay = Math.min(1000 * 2 ** (this.reconnectAttempts - 1), 10000);
    console.log(`[gemini:${this.targetLanguage}] reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
    setTimeout(() => {
      if (this.closedByUs) return;
      this.connect().catch((err) => {
        console.error(`[gemini:${this.targetLanguage}] reconnect failed:`, err.message);
      });
    }, delay);
  }

  #queueAudio(base64Chunk) {
    if (this.closedByUs) return;
    this.pendingAudio.push(base64Chunk);
    if (this.pendingAudio.length > PENDING_AUDIO_CHUNK_LIMIT) {
      this.pendingAudio.shift();
      this.droppedPendingChunks += 1;
      this.#logDropMetric('gemini-pending', this.pendingAudio.length * 100);
    }
  }

  #flushPendingAudio() {
    const chunks = this.pendingAudio.splice(0);
    for (const chunk of chunks) this.sendAudio(chunk);
  }

  /** @param {string} base64Chunk raw PCM 16-bit / 16 kHz / mono, base64-encoded */
  sendAudio(base64Chunk) {
    // Keep a tiny catch-up buffer across Gemini reconnect/setup gaps. Listener
    // playback remains a single scheduled lane, so catch-up should not overlap.
    if (!this.ready || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.#queueAudio(base64Chunk);
      return;
    }
    if (this.ws.bufferedAmount > GEMINI_AUDIO_BUFFER_LIMIT_BYTES) {
      this.droppedBufferedChunks += 1;
      this.#logDropMetric(
        'gemini-websocket',
        estimateQueuedAudioMs(this.ws.bufferedAmount, 16_000),
        this.ws.bufferedAmount,
      );
      return;
    }
    try {
      if (this.firstInputAt === null) this.firstInputAt = Date.now();
      this.ws.send(
        JSON.stringify({
          realtimeInput: { audio: { data: base64Chunk, mimeType: 'audio/pcm;rate=16000' } },
        }),
      );
    } catch (err) {
      console.error(`[gemini:${this.targetLanguage}] send failed:`, err.message);
      this.#queueAudio(base64Chunk);
    }
  }

  #logDropMetric(stage, queuedMs, bufferedBytes = 0) {
    const now = Date.now();
    if (now - this.lastDropMetricAt < AUDIO_METRIC_LOG_INTERVAL_MS) return;
    this.lastDropMetricAt = now;
    logAudioMetric({
      event: 'audio-dropped',
      sessionId: this.sessionId,
      stream: this.streamKind,
      apiTier: this.apiTier,
      language: this.targetLanguage,
      stage,
      queuedMs,
      bufferedBytes,
      droppedBufferedChunks: this.droppedBufferedChunks,
      droppedPendingChunks: this.droppedPendingChunks,
      queueLimitSeconds: LIVE_EDGE_MAX_QUEUE_SECONDS,
    });
  }

  close() {
    this.closedByUs = true;
    this.ready = false;
    try {
      this.ws?.close();
    } catch {
      // already closed
    }
    this.ws = null;
    this.pendingAudio = [];
    this.resumptionHandle = null;
  }
}
