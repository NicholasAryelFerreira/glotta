import crypto from 'node:crypto';
import { Translator } from './translator.js';
import {
  LIVE_EDGE_MAX_QUEUE_SECONDS,
  audioBufferLimitBytes,
  estimateQueuedAudioMs,
  logAudioMetric,
} from './liveEdge.js';
import { SPEAKER_AUDIO_CHUNK_MS, TranscriptWatchdog } from './transcriptWatchdog.js';

// Unambiguous characters only (no 0/O, 1/I/L) — codes get read aloud in church.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function makeSessionId(length = 6) {
  const bytes = crypto.randomBytes(length);
  let id = '';
  for (let i = 0; i < length; i++) id += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return id;
}

// Client-supplied codes (session revival, the configured weekly code) may be
// any 6 letters/digits — e.g. a chosen word like SERMON — even though codes we
// generate ourselves stick to the unambiguous alphabet above.
function sanitizeId(id) {
  if (typeof id !== 'string') return null;
  const up = id.toUpperCase();
  return /^[A-Z0-9]{6}$/.test(up) ? up : null;
}

export function isValidSessionId(id) {
  return sanitizeId(id) !== null;
}

function finiteNonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

// How long an empty language channel keeps its Gemini session alive, so a
// listener refreshing their page doesn't tear down and recreate the session.
const CHANNEL_LINGER_MS = 60_000;
const LISTENER_AUDIO_BUFFER_LIMIT_BYTES = audioBufferLimitBytes(
  24_000,
  LIVE_EDGE_MAX_QUEUE_SECONDS,
  512_000,
);
const AUDIO_METRIC_LOG_INTERVAL_MS = 10_000;
const SPEAKER_TRANSCRIPT_LANGUAGE = 'en';
const MIN_AUDIO_IDLE_MINUTES = 60;
const configuredAudioIdleMinutes = Number(process.env.SESSION_AUDIO_IDLE_MINUTES);
const SESSION_AUDIO_IDLE_MINUTES = Number.isFinite(configuredAudioIdleMinutes)
  ? Math.max(MIN_AUDIO_IDLE_MINUTES, configuredAudioIdleMinutes)
  : MIN_AUDIO_IDLE_MINUTES;
const SESSION_AUDIO_IDLE_MS = SESSION_AUDIO_IDLE_MINUTES * 60_000;
export const SESSION_MAX_DURATION_MINUTES = 120;
const SESSION_MAX_DURATION_MS = SESSION_MAX_DURATION_MINUTES * 60_000;

// The paid key is selected only for the one exact value sent by the UI. Older
// clients, omitted values, and unexpected values all stay on the free tier.
export function normalizeApiTier(apiTier) {
  return apiTier === 'paid' ? 'paid' : 'free';
}

/**
 * One language channel inside a session: a single Gemini translator shared by
 * every listener of that language.
 */
class LanguageChannel {
  constructor(session, lang) {
    this.session = session;
    this.lang = lang;
    this.listeners = new Set(); // WebSocket[]
    this.listenerAudioMetrics = new WeakMap();
    this.lingerTimer = null;
    this.outputWatchdog = new TranscriptWatchdog();
    this.translationRestarting = false;
    this.outputHealth = this.#newOutputHealth();
    this.translator = this.#createTranslator();
  }

  #createTranslator() {
    return new Translator({
      apiKey: this.session.apiKey,
      targetLanguage: this.lang,
      echoTargetLanguage: this.session.echoTargetLanguage,
      onAudio: (data) => {
        this.outputWatchdog.recordOutput();
        this.outputHealth.audioChunks += 1;
        this.outputHealth.lastAudioAt = Date.now();
        this.broadcast({ type: 'audio', data });
      },
      onTranscript: (kind, text) => {
        if (kind === 'output') {
          this.outputHealth.transcriptEvents += 1;
          this.outputHealth.lastTranscriptAt = Date.now();
        }
        this.broadcast({ type: 'transcript', kind, text });
        // Input transcript is language-independent. Use one listener channel
        // as a fallback until the dedicated speaker transcript stream is ready.
        if (
          kind === 'input'
          && !this.session.speakerTranscriptTranslator?.ready
          && this.session.transcriptChannel === this
        ) {
          this.session.sendToSpeaker({ type: 'transcript', kind: 'input', text });
        }
      },
      onError: (err) => this.broadcast({ type: 'error', message: err.message }),
      onStatus: (state) => {
        if (state === 'translator-online') {
          this.outputWatchdog.reset();
          this.translationRestarting = false;
        }
        this.broadcast({ type: 'status', state });
      },
      sessionId: this.session.id,
      streamKind: 'listener',
      apiTier: this.session.apiTier,
      billingApiTier: this.session.billingApiTier,
    });
  }

  #newOutputHealth(now = Date.now(), previous = {}) {
    return {
      intervalStartedAt: now,
      voicedInputMs: 0,
      audioChunks: 0,
      transcriptEvents: 0,
      lastAudioAt: previous.lastAudioAt ?? null,
      lastTranscriptAt: previous.lastTranscriptAt ?? null,
    };
  }

  recordSpeakerAudio({ speechDetected } = {}) {
    if (this.listeners.size === 0) return;
    const now = Date.now();
    if (speechDetected === true) this.outputHealth.voicedInputMs += SPEAKER_AUDIO_CHUNK_MS;

    const stall = this.outputWatchdog.recordAudio({
      speechDetected: speechDetected === true,
      streamReady: this.translator.ready === true,
    });
    if (stall) this.#restartStalledTranslation(stall);

    if (now - this.outputHealth.intervalStartedAt < AUDIO_METRIC_LOG_INTERVAL_MS) return;
    logAudioMetric({
      event: 'listener-output-health',
      sessionId: this.session.id,
      stream: 'listener',
      apiTier: this.session.apiTier,
      language: this.lang,
      intervalMs: now - this.outputHealth.intervalStartedAt,
      listeners: this.listeners.size,
      voicedInputMs: this.outputHealth.voicedInputMs,
      outputAudioChunks: this.outputHealth.audioChunks,
      outputTranscriptEvents: this.outputHealth.transcriptEvents,
      lastAudioOutputAgeMs: this.outputHealth.lastAudioAt === null ? null : now - this.outputHealth.lastAudioAt,
      lastTranscriptOutputAgeMs: this.outputHealth.lastTranscriptAt === null
        ? null
        : now - this.outputHealth.lastTranscriptAt,
    });
    this.outputHealth = this.#newOutputHealth(now, this.outputHealth);
  }

  #restartStalledTranslation(stall) {
    if (this.translationRestarting || this.listeners.size === 0) return;
    this.translationRestarting = true;
    logAudioMetric({
      event: 'translation-stall',
      sessionId: this.session.id,
      stream: 'listener',
      apiTier: this.session.apiTier,
      language: this.lang,
      voicedAudioMs: stall.voicedAudioMs,
      elapsedSinceOutputMs: stall.elapsedSinceOutputMs,
      action: 'fresh-reconnect',
    });
    this.broadcast({ type: 'status', state: 'translation-stalled' });
    this.translator.close();
    this.translator = this.#createTranslator();
    this.translator.connect().catch((err) => {
      console.error(`[session:${this.session.id}] ${this.lang} translation recovery failed:`, err.message);
    });
  }

  broadcast(obj) {
    const payload = JSON.stringify(obj);
    for (const ws of this.listeners) {
      if (ws.readyState !== ws.OPEN) continue;
      if (obj.type === 'audio' && ws.bufferedAmount > LISTENER_AUDIO_BUFFER_LIMIT_BYTES) {
        this.#recordListenerDrop(ws);
        continue;
      }
      ws.send(payload);
    }
  }

  #recordListenerDrop(ws) {
    const now = Date.now();
    const metrics = this.listenerAudioMetrics.get(ws) || { droppedChunks: 0, lastLogAt: 0 };
    metrics.droppedChunks += 1;
    if (now - metrics.lastLogAt >= AUDIO_METRIC_LOG_INTERVAL_MS) {
      metrics.lastLogAt = now;
      logAudioMetric({
        event: 'audio-dropped',
        sessionId: this.session.id,
        stream: 'listener',
        apiTier: this.session.apiTier,
        language: this.lang,
        stage: 'listener-websocket',
        queuedMs: estimateQueuedAudioMs(ws.bufferedAmount, 24_000),
        bufferedBytes: ws.bufferedAmount,
        droppedChunks: metrics.droppedChunks,
        queueLimitSeconds: LIVE_EDGE_MAX_QUEUE_SECONDS,
      });
    }
    this.listenerAudioMetrics.set(ws, metrics);
  }

  addListener(ws) {
    if (this.listeners.size === 0) {
      this.outputWatchdog.reset();
      this.outputHealth = this.#newOutputHealth();
    }
    this.listeners.add(ws);
    this.listenerAudioMetrics.set(ws, { droppedChunks: 0, lastLogAt: 0 });
    if (this.lingerTimer) {
      clearTimeout(this.lingerTimer);
      this.lingerTimer = null;
    }
  }

  removeListener(ws) {
    this.listeners.delete(ws);
    this.listenerAudioMetrics.delete(ws);
    if (this.listeners.size === 0) {
      this.outputWatchdog.reset();
      this.outputHealth = this.#newOutputHealth();
    }
    if (this.listeners.size === 0 && !this.lingerTimer) {
      this.lingerTimer = setTimeout(() => this.session.closeChannel(this.lang), CHANNEL_LINGER_MS);
    }
  }

  close() {
    if (this.lingerTimer) clearTimeout(this.lingerTimer);
    this.translator.close();
    for (const ws of this.listeners) {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: 'status', state: 'ended' }));
        ws.close();
      }
    }
    this.listeners.clear();
  }
}

class Session {
  constructor(manager, { title, echoTargetLanguage = true, id, apiTier }) {
    this.manager = manager;
    this.id = id || makeSessionId();
    this.title = title || 'Live translation';
    this.echoTargetLanguage = Boolean(echoTargetLanguage);
    this.apiTier = normalizeApiTier(apiTier);
    this.billingApiTier = manager.billingApiTierForTier(this.apiTier);
    this.apiKey = manager.apiKeyForTier(this.apiTier);
    this.createdAt = Date.now();
    this.speakerSockets = new Set();
    this.speakerWs = null;
    this.speakerGraceTimer = null;
    this.channels = new Map(); // lang -> LanguageChannel
    this.transcriptChannel = null; // listener channel that mirrors input transcripts to the speaker as a fallback
    this.speakerTranscriptTranslator = null; // hidden Gemini stream for speaker transcript even with no listeners
    this.speakerTranscriptWatchdog = new TranscriptWatchdog();
    this.speakerTranscriptRestarting = false;
    this.ended = false;
    this.lastAudioAt = Date.now();
    this.speakerIngressMetrics = {
      intervalStartedAt: Date.now(),
      receivedChunks: 0,
      sequenceGaps: 0,
      lastSequence: null,
      maxReportedCaptureAgeMs: 0,
    };
    this.listenerPlayerMetrics = new Map();
    this.audioIdleTimer = null;
    this.maxDurationTimer = setTimeout(() => {
      this.end(
        `maximum duration of ${SESSION_MAX_DURATION_MINUTES} minutes reached`,
        'maximum duration reached',
      );
    }, SESSION_MAX_DURATION_MS);
    this.scheduleAudioIdleCheck();
  }

  scheduleAudioIdleCheck(delay = SESSION_AUDIO_IDLE_MS) {
    if (this.audioIdleTimer) clearTimeout(this.audioIdleTimer);
    this.audioIdleTimer = setTimeout(() => {
      if (this.ended) return;
      const idleFor = Date.now() - this.lastAudioAt;
      if (idleFor >= SESSION_AUDIO_IDLE_MS) {
        this.end(`no speaker audio for ${SESSION_AUDIO_IDLE_MINUTES} minutes`);
      } else {
        this.scheduleAudioIdleCheck(SESSION_AUDIO_IDLE_MS - idleFor);
      }
    }, delay);
  }

  addSpeakerSocket(ws) {
    this.speakerSockets.add(ws);
  }

  removeSpeakerSocket(ws) {
    this.speakerSockets.delete(ws);
  }

  claimSpeaker(ws) {
    if (this.speakerWs === ws) return true;
    if (this.speakerWs && this.speakerWs.readyState === this.speakerWs.OPEN) return false;
    this.speakerSockets.add(ws);
    this.speakerWs = ws;
    return true;
  }

  releaseSpeaker(ws) {
    if (this.speakerWs !== ws) return false;
    this.speakerWs = null;
    this.speakerTranscriptWatchdog.reset();
    return true;
  }

  sendToSpeakers(obj) {
    const payload = JSON.stringify(obj);
    for (const ws of this.speakerSockets) {
      if (ws.readyState === ws.OPEN) ws.send(payload);
    }
  }

  sendToSpeaker(obj) {
    if (this.speakerWs && this.speakerWs.readyState === this.speakerWs.OPEN) {
      this.speakerWs.send(JSON.stringify(obj));
    }
  }

  ensureSpeakerTranscript() {
    if (this.speakerTranscriptTranslator) return;
    const translator = new Translator({
      apiKey: this.apiKey,
      targetLanguage: SPEAKER_TRANSCRIPT_LANGUAGE,
      echoTargetLanguage: false,
      onAudio: () => {},
      onTranscript: (kind, text) => {
        if (kind === 'input') {
          this.speakerTranscriptWatchdog.recordTranscript();
          this.sendToSpeaker({ type: 'transcript', kind: 'input', text });
        }
      },
      onError: (err) => this.sendToSpeaker({ type: 'error', message: err.message }),
      onStatus: (state) => {
        if (state === 'translator-reconnecting') {
          this.sendToSpeaker({ type: 'status', state: 'transcript-reconnecting' });
          return;
        }
        this.speakerTranscriptWatchdog.reset();
        this.speakerTranscriptRestarting = false;
        this.sendToSpeaker({ type: 'status', state: 'transcript-online' });
      },
      sessionId: this.id,
      streamKind: 'speaker-transcript',
      apiTier: this.apiTier,
      billingApiTier: this.billingApiTier,
      // This stream only powers "What the model hears". Its translated output
      // transcript was ignored, so disabling it cannot change the speaker UI.
      outputAudioTranscription: false,
    });
    this.speakerTranscriptTranslator = translator;
    translator.connect().catch((err) => {
      console.error(`[session:${this.id}] speaker transcript failed:`, err.message);
    });
  }

  /** Fan one base64 PCM chunk out to Gemini and every active language translator. */
  pushAudio(base64Chunk, metadata = {}) {
    if (this.ended) return;
    this.lastAudioAt = Date.now();
    this.#recordSpeakerIngress(metadata);
    this.ensureSpeakerTranscript();
    this.speakerTranscriptTranslator?.sendAudio(base64Chunk);
    const stall = this.speakerTranscriptWatchdog.recordAudio({
      speechDetected: metadata.speechDetected === true,
      streamReady: this.speakerTranscriptTranslator?.ready === true,
    });
    if (stall) this.#restartStalledSpeakerTranscript(stall);
    for (const channel of this.channels.values()) {
      channel.translator.sendAudio(base64Chunk);
      channel.recordSpeakerAudio(metadata);
    }
  }

  #restartStalledSpeakerTranscript(stall) {
    if (this.ended || this.speakerTranscriptRestarting) return;
    this.speakerTranscriptRestarting = true;
    logAudioMetric({
      event: 'transcript-stall',
      sessionId: this.id,
      stream: 'speaker-transcript',
      apiTier: this.apiTier,
      voicedAudioMs: stall.voicedAudioMs,
      elapsedSinceTranscriptMs: stall.elapsedSinceOutputMs,
      action: 'fresh-reconnect',
    });
    this.sendToSpeaker({ type: 'status', state: 'transcript-stalled' });
    this.speakerTranscriptTranslator?.close();
    this.speakerTranscriptTranslator = null;
    // A fresh logical Gemini session avoids resuming a connection that is open
    // but no longer emitting input transcription. Pending audio stays capped at
    // the live edge by Translator while the replacement completes setup.
    this.ensureSpeakerTranscript();
  }

  #recordSpeakerIngress({ capturedAt, sequence } = {}) {
    const now = Date.now();
    const metrics = this.speakerIngressMetrics;
    metrics.receivedChunks += 1;

    if (Number.isSafeInteger(sequence)) {
      if (metrics.lastSequence !== null && sequence > metrics.lastSequence + 1) {
        metrics.sequenceGaps += sequence - metrics.lastSequence - 1;
      }
      metrics.lastSequence = sequence;
    }

    if (Number.isFinite(capturedAt)) {
      const reportedAge = now - capturedAt;
      // Ignore obviously skewed client clocks; this is diagnostic only.
      if (reportedAge >= 0 && reportedAge <= 60_000) {
        metrics.maxReportedCaptureAgeMs = Math.max(metrics.maxReportedCaptureAgeMs, reportedAge);
      }
    }

    if (now - metrics.intervalStartedAt < AUDIO_METRIC_LOG_INTERVAL_MS) return;
    logAudioMetric({
      event: 'speaker-ingress',
      sessionId: this.id,
      apiTier: this.apiTier,
      intervalMs: now - metrics.intervalStartedAt,
      receivedChunks: metrics.receivedChunks,
      sequenceGaps: metrics.sequenceGaps,
      maxReportedCaptureAgeMs: metrics.maxReportedCaptureAgeMs,
      queueLimitSeconds: LIVE_EDGE_MAX_QUEUE_SECONDS,
    });
    this.speakerIngressMetrics = {
      intervalStartedAt: now,
      receivedChunks: 0,
      sequenceGaps: 0,
      lastSequence: metrics.lastSequence,
      maxReportedCaptureAgeMs: 0,
    };
  }

  recordSpeakerClientMetrics(metrics = {}) {
    logAudioMetric({
      event: 'speaker-client',
      sessionId: this.id,
      apiTier: this.apiTier,
      intervalMs: finiteNonNegative(metrics.intervalMs),
      capturedChunks: finiteNonNegative(metrics.capturedChunks),
      sentChunks: finiteNonNegative(metrics.sentChunks),
      droppedChunks: finiteNonNegative(metrics.droppedChunks),
      peakBufferedBytes: finiteNonNegative(metrics.peakBufferedBytes),
      currentBufferedBytes: finiteNonNegative(metrics.currentBufferedBytes),
      queueLimitSeconds: LIVE_EDGE_MAX_QUEUE_SECONDS,
    });
  }

  recordListenerPlayerMetrics(lang, metrics = {}) {
    const now = Date.now();
    const aggregate = this.listenerPlayerMetrics.get(lang) || {
      intervalStartedAt: 0,
      queuedMs: 0,
      droppedMs: 0,
      maxBufferSeconds: 0,
    };
    aggregate.queuedMs = Math.max(aggregate.queuedMs, finiteNonNegative(metrics.queuedMs));
    aggregate.droppedMs += finiteNonNegative(metrics.droppedMs);
    aggregate.maxBufferSeconds = Math.max(
      aggregate.maxBufferSeconds,
      finiteNonNegative(metrics.maxBufferSeconds),
    );
    if (aggregate.intervalStartedAt !== 0 && now - aggregate.intervalStartedAt < AUDIO_METRIC_LOG_INTERVAL_MS) {
      this.listenerPlayerMetrics.set(lang, aggregate);
      return;
    }
    logAudioMetric({
      event: 'listener-player',
      sessionId: this.id,
      apiTier: this.apiTier,
      language: lang,
      queuedMs: aggregate.queuedMs,
      droppedMs: aggregate.droppedMs,
      maxBufferSeconds: aggregate.maxBufferSeconds,
      queueLimitSeconds: LIVE_EDGE_MAX_QUEUE_SECONDS,
    });
    this.listenerPlayerMetrics.set(lang, {
      intervalStartedAt: now,
      queuedMs: 0,
      droppedMs: 0,
      maxBufferSeconds: aggregate.maxBufferSeconds,
    });
  }

  async addListener(ws, lang) {
    let channel = this.channels.get(lang);
    if (!channel) {
      channel = new LanguageChannel(this, lang);
      this.channels.set(lang, channel);
      if (!this.transcriptChannel) this.transcriptChannel = channel;
      try {
        await channel.translator.connect();
      } catch (err) {
        this.channels.delete(lang);
        if (this.transcriptChannel === channel) this.transcriptChannel = null;
        throw err;
      }
    }
    channel.addListener(ws);
    this.notifySpeakerStats();
    return channel;
  }

  removeListener(ws, lang) {
    const channel = this.channels.get(lang);
    if (channel) {
      channel.removeListener(ws);
      this.notifySpeakerStats();
    }
  }

  closeChannel(lang) {
    const channel = this.channels.get(lang);
    if (!channel) return;
    channel.close();
    this.channels.delete(lang);
    if (this.transcriptChannel === channel) {
      this.transcriptChannel = this.channels.values().next().value ?? null;
    }
    this.notifySpeakerStats();
  }

  notifySpeakerStats() {
    const listeners = {};
    let total = 0;
    for (const [lang, channel] of this.channels) {
      listeners[lang] = channel.listeners.size;
      total += channel.listeners.size;
    }
    this.sendToSpeakers({ type: 'stats', total, listeners });
  }

  end(reason = 'ended by speaker', speakerCloseReason = 'session ended') {
    if (this.ended) return;
    this.ended = true;
    if (this.audioIdleTimer) clearTimeout(this.audioIdleTimer);
    this.audioIdleTimer = null;
    if (this.maxDurationTimer) clearTimeout(this.maxDurationTimer);
    this.maxDurationTimer = null;
    if (this.speakerGraceTimer) clearTimeout(this.speakerGraceTimer);
    this.speakerGraceTimer = null;
    this.speakerTranscriptTranslator?.close();
    this.speakerTranscriptTranslator = null;
    for (const lang of [...this.channels.keys()]) this.closeChannel(lang);
    for (const ws of this.speakerSockets) {
      if (ws.readyState === ws.OPEN) ws.close(1000, speakerCloseReason);
    }
    this.speakerSockets.clear();
    this.speakerWs = null;
    this.manager.sessions.delete(this.id);
    console.log(`[session:${this.id}] ended (${reason})`);
  }
}

export class SessionManager {
  constructor(apiKeys) {
    // Accepting the former string shape keeps SessionManager convenient for
    // isolated tests and older internal callers; production passes both keys.
    this.apiKeys = typeof apiKeys === 'string'
      ? { free: apiKeys, paid: apiKeys }
      : apiKeys;
    this.sessions = new Map(); // id -> Session
  }

  apiKeyForTier(apiTier) {
    // Temporary reliability override: preserve the speaker's Free/Paid UI
    // selection on the session, but route both selections through the paid
    // Gemini project while the Free-tier Live Translate stall is investigated.
    const apiKey = this.apiKeys?.paid;
    if (!apiKey) throw new Error('Missing Gemini API key for paid tier');
    return apiKey;
  }

  billingApiTierForTier(_apiTier) {
    return 'paid';
  }

  create(opts = {}) {
    const id = sanitizeId(opts.id);
    if (opts.id && !id) throw new Error('Invalid session code');
    // Reviving a code that still exists (e.g. two speaker tabs) is a no-op.
    if (id && this.sessions.has(id)) return this.sessions.get(id);
    const session = new Session(this, { ...opts, id });
    this.sessions.set(session.id, session);
    console.log(
      `[session:${session.id}] ${id ? 'revived' : 'created'} ` +
      `("${session.title}", tier: ${session.apiTier})`,
    );
    return session;
  }

  get(id) {
    return this.sessions.get((id || '').toUpperCase());
  }
}
