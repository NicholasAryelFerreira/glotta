import WebSocket from 'ws';

const MODEL = 'gemini-3.5-live-translate-preview';

// The Gemini Live API endpoint. We talk to it over a raw WebSocket because the
// installed @google/genai SDK does not yet know about `translationConfig` and
// silently drops it from the setup message — which made every translation come
// back in the default language (English). Speaking the protocol directly lets
// us send the translation config exactly as documented.
const API_VERSION = process.env.GEMINI_API_VERSION || 'v1beta';
const WS_BASE = 'wss://generativelanguage.googleapis.com';

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
   */
  constructor({ apiKey, targetLanguage, echoTargetLanguage = false, onAudio, onTranscript, onError }) {
    this.apiKey = apiKey;
    this.targetLanguage = targetLanguage;
    this.echoTargetLanguage = echoTargetLanguage;
    this.onAudio = onAudio;
    this.onTranscript = onTranscript;
    this.onError = onError;
    this.ws = null;
    this.ready = false; // true once the server acknowledges setup
    this.closedByUs = false;
    this.connecting = null;
    this.reconnectAttempts = 0;
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
          console.log(`[gemini:${this.targetLanguage}] setup complete`);
          if (!settled) {
            settled = true;
            resolve();
          }
          return;
        }
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
        if (!this.closedByUs) this.#scheduleReconnect();
      });
    });

    this.connecting.finally(() => {
      this.connecting = null;
    });
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
      },
    };
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

  /** @param {string} base64Chunk raw PCM 16-bit / 16 kHz / mono, base64-encoded */
  sendAudio(base64Chunk) {
    if (!this.ready || !this.ws || this.ws.readyState !== WebSocket.OPEN) return; // drop while (re)connecting
    try {
      this.ws.send(
        JSON.stringify({
          realtimeInput: { audio: { data: base64Chunk, mimeType: 'audio/pcm;rate=16000' } },
        }),
      );
    } catch (err) {
      console.error(`[gemini:${this.targetLanguage}] send failed:`, err.message);
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
  }
}
