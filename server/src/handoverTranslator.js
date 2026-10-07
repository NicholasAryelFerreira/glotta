import { logAudioMetric, pcm16Base64DurationMs } from './liveEdge.js';
import { Translator } from './translator.js';

// Gemini replaces each Live connection after about ten minutes and announces
// it with GoAway about 50 seconds ahead. Reconnecting only after that close
// left sermon listeners without translated audio for 12-15 seconds, mostly
// while the replacement produced its first output. Listener streams therefore
// warm a fresh standby connection on the same speaker audio while the old one
// keeps playing, then move listeners to it at a pause.
export const HANDOVER_DEFAULT_TIME_LEFT_MS = 30_000;
// Switch no later than this long before Gemini's announced close.
export const HANDOVER_DEADLINE_MARGIN_MS = 5_000;
// Fresh connections take about 3-4 seconds to produce their first output.
export const HANDOVER_MIN_WARMUP_MS = 8_000;
// Both connections must be quiet so no word is cut off and the new stream
// starts between phrases.
export const HANDOVER_ACTIVE_PAUSE_MS = 500;
export const HANDOVER_STANDBY_PAUSE_MS = 250;
// About -40 dBFS for 16-bit PCM, far below speech level.
export const HANDOVER_SILENCE_RMS = 328;
const OUTPUT_SAMPLE_RATE = 24_000;

/** True when a base64 PCM16 chunk is quiet enough to switch streams during it. */
export function pcm16Base64IsSilent(base64Chunk, threshold = HANDOVER_SILENCE_RMS) {
  if (typeof base64Chunk !== 'string' || !base64Chunk) return true;
  const pcm = Buffer.from(base64Chunk, 'base64');
  const samples = Math.floor(pcm.length / 2);
  if (samples === 0) return true;
  let sumOfSquares = 0;
  for (let offset = 0; offset < samples * 2; offset += 2) {
    const sample = pcm.readInt16LE(offset);
    sumOfSquares += sample * sample;
  }
  return Math.sqrt(sumOfSquares / samples) < threshold;
}

function trailingSilenceMs(previousMs, base64Chunk) {
  if (!pcm16Base64IsSilent(base64Chunk)) return 0;
  return previousMs + pcm16Base64DurationMs(base64Chunk, OUTPUT_SAMPLE_RATE);
}

/**
 * Gemini listener translation stream that hands listeners over to a warmed
 * replacement connection before Gemini closes the current one.
 *
 * Exposes the Translator interface LanguageChannel uses. Only the active
 * connection reaches listeners; the standby's audio, captions, errors, and
 * status stay internal until it takes over. Any handover failure falls back to
 * Translator's own reconnect after Gemini closes the old connection.
 */
export class HandoverTranslator {
  constructor(options, { createStream = (streamOptions) => new Translator(streamOptions) } = {}) {
    this.options = options;
    this.createStream = createStream;
    this.closed = false;
    this.handover = null;
    this.active = this.#createStream();
  }

  get ready() {
    return this.active.ready;
  }

  get streamMode() {
    return this.active.streamMode;
  }

  get model() {
    return this.active.model;
  }

  connect() {
    return this.active.connect();
  }

  sendAudio(base64Chunk) {
    this.active.sendAudio(base64Chunk);
    // The active connection still covers audio sent before the standby's setup
    // completes, so the standby joins at its first ready chunk.
    const standby = this.handover?.stream;
    if (standby?.ready) standby.sendAudio(base64Chunk);
  }

  close(options) {
    this.closed = true;
    this.#abandonHandover('closed');
    return this.active.close(options);
  }

  #createStream() {
    const stream = this.createStream({
      ...this.options,
      onAudio: (data) => this.#handleAudio(stream, data),
      onTranscript: (kind, text) => this.#handleTranscript(stream, kind, text),
      onError: (err) => {
        if (stream === this.active) this.options.onError?.(err);
      },
      onStatus: (state) => this.#handleStatus(stream, state),
      onGoAway: ({ timeLeftMs }) => this.#startHandover(stream, timeLeftMs),
    });
    return stream;
  }

  #handleAudio(stream, data) {
    const handover = this.handover;
    if (stream === this.active) {
      this.options.onAudio?.(data);
      if (!handover) return;
      handover.activeSilenceMs = trailingSilenceMs(handover.activeSilenceMs, data);
      this.#switchAtPause(handover);
      return;
    }
    if (stream !== handover?.stream) return;
    if (handover.firstAudioAt === null) handover.firstAudioAt = Date.now();
    handover.standbySilenceMs = trailingSilenceMs(handover.standbySilenceMs, data);
    this.#switchAtPause(handover);
    // Forward the quiet chunk that completed the switch so listener playback
    // keeps an even timeline.
    if (stream === this.active) this.options.onAudio?.(data);
  }

  #handleTranscript(stream, kind, text) {
    const handover = this.handover;
    if (stream === this.active) {
      if (kind === 'output' && handover && handover.readyAt !== null) handover.activeOutputs += 1;
      this.options.onTranscript?.(kind, text);
      return;
    }
    if (stream === handover?.stream && kind === 'output') handover.standbyOutputs += 1;
  }

  #handleStatus(stream, state) {
    const handover = this.handover;
    if (stream === handover?.stream) {
      if (state === 'translator-online') {
        if (handover.readyAt === null) handover.readyAt = Date.now();
      } else {
        // A standby is never resumed; the old connection is still playing.
        this.#abandonHandover('standby-closed');
      }
      return;
    }
    if (stream !== this.active) return;
    if (handover && state === 'translator-reconnecting') {
      // Gemini closed the old connection before a pause arrived.
      if (this.#standbyCanTakeOver(handover)) {
        this.#completeHandover(handover, 'provider-closed');
        return;
      }
      this.#abandonHandover('provider-closed');
    }
    this.options.onStatus?.(state);
  }

  #startHandover(stream, timeLeftMs) {
    if (this.closed || stream !== this.active || this.handover) return;
    const leftMs = timeLeftMs ?? HANDOVER_DEFAULT_TIME_LEFT_MS;
    const deadlineMs = Math.max(0, leftMs - HANDOVER_DEADLINE_MARGIN_MS);
    const handover = {
      stream: this.#createStream(),
      startedAt: Date.now(),
      readyAt: null,
      firstAudioAt: null,
      activeOutputs: 0,
      standbyOutputs: 0,
      activeSilenceMs: 0,
      standbySilenceMs: 0,
      deadlineTimer: null,
    };
    this.handover = handover;
    handover.deadlineTimer = setTimeout(() => this.#handleDeadline(handover), deadlineMs);
    logAudioMetric({
      event: 'gemini-handover-start',
      sessionId: this.options.sessionId,
      stream: this.options.streamKind,
      provider: this.options.provider,
      language: this.options.targetLanguage,
      timeLeftMs: leftMs,
      deadlineMs,
    });
    // A fresh session, not a resumed one: resumed sessions were the slow
    // first outputs measured in production.
    handover.stream.connect().catch((err) => {
      console.error(`[gemini:${this.options.targetLanguage}] standby connect failed:`, err.message);
    });
  }

  #handleDeadline(handover) {
    if (this.handover !== handover) return;
    handover.deadlineTimer = null;
    if (this.#standbyCanTakeOver(handover)) {
      this.#completeHandover(handover, 'deadline');
    } else {
      this.#abandonHandover(handover.readyAt === null ? 'standby-not-ready' : 'standby-not-translating');
    }
  }

  // A standby that has produced no captions while the old connection kept
  // translating may be stuck; Translator's own reconnect is the safer fallback.
  #standbyCanTakeOver(handover) {
    return handover.readyAt !== null
      && (handover.standbyOutputs > 0 || handover.activeOutputs === 0);
  }

  #switchAtPause(handover) {
    if (this.handover !== handover || handover.readyAt === null) return;
    if (Date.now() - handover.readyAt < HANDOVER_MIN_WARMUP_MS) return;
    if (!this.#standbyCanTakeOver(handover)) return;
    if (handover.activeSilenceMs < HANDOVER_ACTIVE_PAUSE_MS) return;
    if (handover.standbySilenceMs < HANDOVER_STANDBY_PAUSE_MS) return;
    this.#completeHandover(handover, 'pause');
  }

  #completeHandover(handover, reason) {
    this.#finishHandover(handover);
    const previous = this.active;
    this.active = handover.stream;
    this.#logHandoverResult('gemini-handover-complete', handover, reason);
    previous.close();
  }

  #abandonHandover(reason) {
    const handover = this.handover;
    if (!handover) return;
    this.#finishHandover(handover);
    this.#logHandoverResult('gemini-handover-abandoned', handover, reason);
    handover.stream.close();
  }

  #finishHandover(handover) {
    if (handover.deadlineTimer) clearTimeout(handover.deadlineTimer);
    handover.deadlineTimer = null;
    if (this.handover === handover) this.handover = null;
  }

  #logHandoverResult(event, handover, reason) {
    const now = Date.now();
    logAudioMetric({
      event,
      sessionId: this.options.sessionId,
      stream: this.options.streamKind,
      provider: this.options.provider,
      language: this.options.targetLanguage,
      reason,
      elapsedMs: now - handover.startedAt,
      standbySetupMs: handover.readyAt === null ? null : handover.readyAt - handover.startedAt,
      standbyFirstOutputMs: handover.readyAt === null || handover.firstAudioAt === null
        ? null
        : handover.firstAudioAt - handover.readyAt,
      warmupMs: handover.readyAt === null ? null : now - handover.readyAt,
      activeOutputTranscripts: handover.activeOutputs,
      standbyOutputTranscripts: handover.standbyOutputs,
    });
  }
}
