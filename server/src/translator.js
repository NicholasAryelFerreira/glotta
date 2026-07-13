import WebSocket from 'ws';

const MODEL = 'gemini-3.5-live-translate-preview';

// The Gemini Live API endpoint. We talk to it over a raw WebSocket because the
// installed @google/genai SDK does not yet know about `translationConfig` and
// silently drops it from the setup message — which made every translation come
// back in the default language (English). Speaking the protocol directly lets
// us send the translation config exactly as documented.
const API_VERSION = process.env.GEMINI_API_VERSION || 'v1beta';
const WS_BASE = 'wss://generativelanguage.googleapis.com';
const GEMINI_AUDIO_BUFFER_LIMIT_BYTES = 512_000;
const PENDING_AUDIO_CHUNK_LIMIT = 15; // about 1.5 seconds of 100 ms speaker chunks

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
   */
  constructor({ apiKey, targetLanguage, echoTargetLanguage = false, onAudio, onTranscript, onError, onStatus }) {
    this.apiKey = apiKey;
    this.targetLanguage = targetLanguage;
    this.echoTargetLanguage = echoTargetLanguage;
    this.onAudio = onAudio;
    this.onTranscript = onTranscript;
    this.onError = onError;
    this.onStatus = onStatus;
    this.ws = null;
    this.ready = false; // true once the server acknowledges setup
    this.closedByUs = false;
    this.connecting = null;
    this.reconnectAttempts = 0;
    this.pendingAudio = [];
    this.resumptionHandle = null;
    this.connectionNumber = 0;
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
          this.onStatus?.('translator-online');
          this.#flushPendingAudio();
          if (!settled) {
            settled = true;
            resolve();
          }
          return;
        }
        this.#handleSessionManagement(msg);
        this.#handleServerContent(msg);
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
        inputAudioTranscription: {},
        outputAudioTranscription: {},
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

  #handleServerContent(msg) {
    const content = msg.serverContent || msg.server_content;
    if (!content) return;

    const inputT = content.inputTranscription || content.input_transcription;
    if (inputT?.text) this.onTranscript?.('input', inputT.text);

    const outputT = content.outputTranscription || content.output_transcription;
    if (outputT?.text) this.onTranscript?.('output', outputT.text);

    const turn = content.modelTurn || content.model_turn;
    const parts = turn?.parts ?? [];
    for (const part of parts) {
      const inline = part.inlineData || part.inline_data;
      if (inline?.data) this.onAudio?.(inline.data);
    }
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
    if (this.pendingAudio.length > PENDING_AUDIO_CHUNK_LIMIT) this.pendingAudio.shift();
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
    if (this.ws.bufferedAmount > GEMINI_AUDIO_BUFFER_LIMIT_BYTES) return; // keep live audio live, not stale
    try {
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
