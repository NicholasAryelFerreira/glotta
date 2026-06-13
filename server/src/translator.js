import { GoogleGenAI, Modality } from '@google/genai';

const MODEL = 'gemini-3.5-live-translate-preview';

/**
 * Wraps one Gemini Live translation session for a single target language.
 * Audio in: base64 raw PCM 16-bit / 16 kHz / mono.
 * Audio out (via onAudio): base64 raw PCM 16-bit / 24 kHz / mono.
 *
 * Reconnects automatically if Gemini closes the session while we still
 * have listeners (live sessions have server-side duration limits, and a
 * sermon can easily outlast them).
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
    this.ai = new GoogleGenAI({ apiKey });
    this.targetLanguage = targetLanguage;
    this.echoTargetLanguage = echoTargetLanguage;
    this.onAudio = onAudio;
    this.onTranscript = onTranscript;
    this.onError = onError;
    this.session = null;
    this.closedByUs = false;
    this.connecting = null;
    this.reconnectAttempts = 0;
  }

  async connect() {
    if (this.connecting) return this.connecting;
    this.connecting = this.#doConnect();
    try {
      await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  async #doConnect() {
    this.session = await this.ai.live.connect({
      model: MODEL,
      config: {
        responseModalities: [Modality.AUDIO],
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        translationConfig: {
          targetLanguageCode: this.targetLanguage,
          echoTargetLanguage: this.echoTargetLanguage,
        },
      },
      callbacks: {
        onopen: () => {
          this.reconnectAttempts = 0;
          console.log(`[gemini:${this.targetLanguage}] session open`);
        },
        onmessage: (message) => this.#handleMessage(message),
        onerror: (e) => {
          console.error(`[gemini:${this.targetLanguage}] error:`, e?.message ?? e);
          this.onError?.(e instanceof Error ? e : new Error(String(e?.message ?? e)));
        },
        onclose: (e) => {
          console.log(`[gemini:${this.targetLanguage}] session closed (${e?.reason || 'no reason'})`);
          this.session = null;
          if (!this.closedByUs) this.#scheduleReconnect();
        },
      },
    });
  }

  #handleMessage(message) {
    const content = message?.serverContent;
    if (!content) return;
    if (content.inputTranscription?.text) {
      this.onTranscript?.('input', content.inputTranscription.text);
    }
    if (content.outputTranscription?.text) {
      this.onTranscript?.('output', content.outputTranscription.text);
    }
    const parts = content.modelTurn?.parts ?? [];
    for (const part of parts) {
      if (part.inlineData?.data) {
        this.onAudio?.(part.inlineData.data);
      }
    }
  }

  #scheduleReconnect() {
    if (this.closedByUs) return;
    this.reconnectAttempts += 1;
    if (this.reconnectAttempts > 5) {
      this.onError?.(new Error(`Gemini session for ${this.targetLanguage} could not be re-established`));
      return;
    }
    const delay = Math.min(1000 * 2 ** (this.reconnectAttempts - 1), 10000);
    console.log(`[gemini:${this.targetLanguage}] reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
    setTimeout(() => {
      if (this.closedByUs) return;
      this.connect().catch((err) => {
        console.error(`[gemini:${this.targetLanguage}] reconnect failed:`, err.message);
        this.#scheduleReconnect();
      });
    }, delay);
  }

  /** @param {string} base64Chunk raw PCM 16-bit / 16 kHz / mono, base64-encoded */
  sendAudio(base64Chunk) {
    if (!this.session) return; // drop audio while (re)connecting
    try {
      this.session.sendRealtimeInput({
        audio: { data: base64Chunk, mimeType: 'audio/pcm;rate=16000' },
      });
    } catch (err) {
      console.error(`[gemini:${this.targetLanguage}] send failed:`, err.message);
    }
  }

  close() {
    this.closedByUs = true;
    try {
      this.session?.close();
    } catch {
      // already closed
    }
    this.session = null;
  }
}
