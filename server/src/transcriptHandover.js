import { logAudioMetric, pcm16Base64DurationMs } from './liveEdge.js';
import { pcm16Base64Rms } from './handoverTranslator.js';
import { Translator } from './translator.js';

// Gemini replaces each Live connection after about ten minutes and announces
// it with GoAway about 50 seconds ahead. The speaker transcript used to wait
// for that close and reconnect, losing the phrase still being transcribed and
// the speech during the reconnect. This wrapper opens a fresh standby instead
// and splits the speaker audio between the two connections at a pause: the old
// connection hears everything up to the pause, the new one everything after
// it, so no words are lost or transcribed twice.
export const TRANSCRIPT_HANDOVER_DEFAULT_TIME_LEFT_MS = 30_000;
// Cut no later than this long before Gemini's announced close.
export const TRANSCRIPT_HANDOVER_DEADLINE_MARGIN_MS = 5_000;
// Consecutive quiet speaker audio needed to cut between phrases.
export const TRANSCRIPT_HANDOVER_PAUSE_MS = 400;
// Speaker input is quiet when it is this far below recent speech, or below the
// absolute floor. A relative level copes with rooms of different loudness.
export const TRANSCRIPT_HANDOVER_RELATIVE_QUIET_DB = 15;
export const TRANSCRIPT_HANDOVER_QUIET_FLOOR_DBFS = -50;
// After the cut the old connection hears silence so it finalizes the phrase
// before the pause. Finished early once nothing is left unfinalized.
export const TRANSCRIPT_HANDOVER_DRAIN_MIN_MS = 1_000;
export const TRANSCRIPT_HANDOVER_DRAIN_MAX_MS = 3_000;
const INPUT_SAMPLE_RATE = 16_000;
// Five seconds of 100 ms speaker chunks form the speech-level reference.
const LEVEL_WINDOW_CHUNKS = 50;
const MIN_REFERENCE_CHUNKS = 10;
const FINAL_KINDS = new Set(['input', 'input-final']);

function rmsToDbfs(rms) {
  if (!(rms > 0)) return -120;
  return Math.max(-120, Math.round(20 * Math.log10(rms / 32_768) * 10) / 10);
}

function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

/** Silent PCM16 of the same length, base64-encoded. */
function silenceLike(base64Chunk) {
  const padding = base64Chunk.endsWith('==') ? 2 : base64Chunk.endsWith('=') ? 1 : 0;
  const bytes = Math.max(0, Math.floor(base64Chunk.length * 3 / 4) - padding);
  return Buffer.alloc(bytes).toString('base64');
}

/**
 * Gemini speaker-transcript stream that hands over to a fresh connection
 * before Gemini closes the current one.
 *
 * Exposes the Translator interface Session uses. Only the active connection's
 * transcript reaches the session, except that the old connection's final text
 * is still delivered while it drains after the cut, and the new connection's
 * final text is held until then so the order stays correct. Any handover
 * failure falls back to Translator's own reconnect.
 */
export class TranscriptHandoverTranslator {
  constructor(options, { createStream = (streamOptions) => new Translator(streamOptions) } = {}) {
    this.options = options;
    this.createStream = createStream;
    this.closed = false;
    this.handover = null;
    this.draining = null;
    this.pendingInterim = new Map();
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
    const handover = this.handover;
    if (handover) {
      // Until the cut, the old connection hears everything, including the
      // pause itself. The standby hears only audio after the cut.
      this.active.sendAudio(base64Chunk);
      if (this.#pauseReached(handover, base64Chunk)) this.#cut(handover, 'pause');
      return;
    }
    this.active.sendAudio(base64Chunk);
    this.draining?.stream.sendAudio(silenceLike(base64Chunk));
  }

  close(options) {
    this.closed = true;
    this.#abandonHandover('closed');
    this.#finishDrain('closed');
    return this.active.close(options);
  }

  #createStream() {
    const stream = this.createStream({
      ...this.options,
      onAudio: (data) => {
        if (stream === this.active) this.options.onAudio?.(data);
      },
      onTranscript: (kind, text) => this.#handleTranscript(stream, kind, text),
      onError: (err) => {
        if (stream === this.active) this.options.onError?.(err);
      },
      onStatus: (state) => this.#handleStatus(stream, state),
      onGoAway: ({ timeLeftMs }) => this.#startHandover(stream, timeLeftMs),
    });
    return stream;
  }

  #handleTranscript(stream, kind, text) {
    if (kind === 'input-interim') this.pendingInterim.set(stream, text);
    else if (FINAL_KINDS.has(kind)) this.pendingInterim.delete(stream);

    const draining = this.draining;
    if (draining && stream === draining.stream) {
      // Interim hypotheses from the old connection would flicker against the
      // new connection's; its finalized text is still the speaker's words.
      if (kind !== 'input-interim') this.options.onTranscript?.(kind, text);
      this.#maybeFinishDrain(draining);
      return;
    }
    if (stream !== this.active) return;
    if (draining && FINAL_KINDS.has(kind)) {
      draining.heldFinals.push({ kind, text });
      return;
    }
    this.options.onTranscript?.(kind, text);
  }

  #handleStatus(stream, state) {
    const handover = this.handover;
    if (handover && stream === handover.stream) {
      if (state === 'translator-online') {
        if (handover.readyAt === null) handover.readyAt = Date.now();
      } else {
        // A standby is never resumed; the old connection is still working.
        this.#abandonHandover('standby-closed');
      }
      return;
    }
    if (this.draining && stream === this.draining.stream) {
      // Gemini closed the old connection; stop it from reconnecting.
      if (state !== 'translator-online') this.#finishDrain('provider-closed');
      return;
    }
    if (stream !== this.active) return;
    if (handover && state === 'translator-reconnecting') {
      // Gemini closed the old connection before a pause arrived.
      if (handover.readyAt !== null) {
        this.#cut(handover, 'provider-closed');
        return;
      }
      this.#abandonHandover('provider-closed');
    }
    this.options.onStatus?.(state);
  }

  #startHandover(stream, timeLeftMs) {
    if (this.closed || stream !== this.active || this.handover) return;
    // A drain lasts seconds and GoAway comes every ten minutes; finish it first.
    this.#finishDrain('next-handover');
    const leftMs = timeLeftMs ?? TRANSCRIPT_HANDOVER_DEFAULT_TIME_LEFT_MS;
    const deadlineMs = Math.max(0, leftMs - TRANSCRIPT_HANDOVER_DEADLINE_MARGIN_MS);
    const handover = {
      stream: this.#createStream(),
      startedAt: Date.now(),
      readyAt: null,
      levels: [],
      quietMs: 0,
      lastLevelDbfs: null,
      referenceDbfs: null,
      deadlineTimer: null,
    };
    this.handover = handover;
    handover.deadlineTimer = setTimeout(() => this.#handleDeadline(handover), deadlineMs);
    logAudioMetric({
      event: 'transcript-handover-start',
      sessionId: this.options.sessionId,
      stream: this.options.streamKind,
      provider: this.options.provider,
      timeLeftMs: leftMs,
      deadlineMs,
    });
    handover.stream.connect().catch((err) => {
      console.error('[gemini:speaker-transcript] standby connect failed:', err.message);
    });
  }

  #pauseReached(handover, base64Chunk) {
    const dbfs = rmsToDbfs(pcm16Base64Rms(base64Chunk));
    handover.levels.push(dbfs);
    if (handover.levels.length > LEVEL_WINDOW_CHUNKS) handover.levels.shift();
    const reference = handover.levels.length >= MIN_REFERENCE_CHUNKS
      ? percentile(handover.levels, 0.9)
      : null;
    const quiet = dbfs <= TRANSCRIPT_HANDOVER_QUIET_FLOOR_DBFS
      || (reference !== null && dbfs <= reference - TRANSCRIPT_HANDOVER_RELATIVE_QUIET_DB);
    handover.quietMs = quiet
      ? handover.quietMs + pcm16Base64DurationMs(base64Chunk, INPUT_SAMPLE_RATE)
      : 0;
    handover.lastLevelDbfs = dbfs;
    handover.referenceDbfs = reference;
    return handover.readyAt !== null && handover.quietMs >= TRANSCRIPT_HANDOVER_PAUSE_MS;
  }

  #handleDeadline(handover) {
    if (this.handover !== handover) return;
    handover.deadlineTimer = null;
    if (handover.readyAt !== null) this.#cut(handover, 'deadline');
    else this.#abandonHandover('standby-not-ready');
  }

  #cut(handover, reason) {
    this.#endHandover(handover);
    const previous = this.active;
    this.active = handover.stream;
    const cutAt = Date.now();
    const draining = {
      stream: previous,
      reason,
      handover,
      cutAt,
      heldFinals: [],
      minTimer: null,
      maxTimer: null,
    };
    this.draining = draining;
    if (!previous.ready) {
      // Gemini already closed it, so nothing more can arrive.
      this.#finishDrain('provider-closed');
      return;
    }
    draining.minTimer = setTimeout(() => {
      draining.minTimer = null;
      this.#maybeFinishDrain(draining);
    }, TRANSCRIPT_HANDOVER_DRAIN_MIN_MS);
    draining.maxTimer = setTimeout(() => {
      draining.maxTimer = null;
      if (this.draining === draining) this.#finishDrain('drain-timeout');
    }, TRANSCRIPT_HANDOVER_DRAIN_MAX_MS);
  }

  // Live Transcribe marks unfinished speech with interim hypotheses. Once the
  // old connection has none left, everything it heard has been finalized.
  #maybeFinishDrain(draining) {
    if (this.draining !== draining || draining.minTimer) return;
    if (draining.stream.streamMode !== 'transcription') return;
    if (this.pendingInterim.has(draining.stream)) return;
    this.#finishDrain('finalized');
  }

  #finishDrain(drainReason) {
    const draining = this.draining;
    if (!draining) return;
    this.draining = null;
    if (draining.minTimer) clearTimeout(draining.minTimer);
    if (draining.maxTimer) clearTimeout(draining.maxTimer);
    // Keep words Gemini heard but never finalized rather than dropping them.
    const unfinalized = this.pendingInterim.get(draining.stream);
    this.pendingInterim.delete(draining.stream);
    if (unfinalized) this.options.onTranscript?.('input-final', unfinalized);
    draining.stream.close();
    for (const { kind, text } of draining.heldFinals) this.options.onTranscript?.(kind, text);
    this.#logResult('transcript-handover-complete', draining.handover, draining.reason, {
      drainReason,
      drainMs: Date.now() - draining.cutAt,
      unfinalizedKept: Boolean(unfinalized),
      heldFinals: draining.heldFinals.length,
    });
  }

  #abandonHandover(reason) {
    const handover = this.handover;
    if (!handover) return;
    this.#endHandover(handover);
    this.#logResult('transcript-handover-abandoned', handover, reason);
    this.pendingInterim.delete(handover.stream);
    handover.stream.close();
  }

  #endHandover(handover) {
    if (handover.deadlineTimer) clearTimeout(handover.deadlineTimer);
    handover.deadlineTimer = null;
    if (this.handover === handover) this.handover = null;
  }

  #logResult(event, handover, reason, extra = {}) {
    logAudioMetric({
      event,
      sessionId: this.options.sessionId,
      stream: this.options.streamKind,
      provider: this.options.provider,
      reason,
      elapsedMs: Date.now() - handover.startedAt,
      standbySetupMs: handover.readyAt === null ? null : handover.readyAt - handover.startedAt,
      quietMs: handover.quietMs,
      lastLevelDbfs: handover.lastLevelDbfs,
      referenceDbfs: handover.referenceDbfs,
      ...extra,
    });
  }
}
