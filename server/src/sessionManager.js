import crypto from 'node:crypto';
import { Translator } from './translator.js';

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

// How long an empty language channel keeps its Gemini session alive, so a
// listener refreshing their page doesn't tear down and recreate the session.
const CHANNEL_LINGER_MS = 60_000;
const LISTENER_AUDIO_BUFFER_LIMIT_BYTES = 512_000;
const SPEAKER_TRANSCRIPT_LANGUAGE = 'en';
const MIN_AUDIO_IDLE_MINUTES = 60;
const configuredAudioIdleMinutes = Number(process.env.SESSION_AUDIO_IDLE_MINUTES);
const SESSION_AUDIO_IDLE_MINUTES = Number.isFinite(configuredAudioIdleMinutes)
  ? Math.max(MIN_AUDIO_IDLE_MINUTES, configuredAudioIdleMinutes)
  : MIN_AUDIO_IDLE_MINUTES;
const SESSION_AUDIO_IDLE_MS = SESSION_AUDIO_IDLE_MINUTES * 60_000;

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
    this.lingerTimer = null;
    this.translator = new Translator({
      apiKey: session.apiKey,
      targetLanguage: lang,
      echoTargetLanguage: session.echoTargetLanguage,
      onAudio: (data) => this.broadcast({ type: 'audio', data }),
      onTranscript: (kind, text) => {
        this.broadcast({ type: 'transcript', kind, text });
        // Input transcript is language-independent. Use one listener channel
        // as a fallback until the dedicated speaker transcript stream is ready.
        if (kind === 'input' && !session.speakerTranscriptTranslator?.ready && session.transcriptChannel === this) {
          session.sendToSpeaker({ type: 'transcript', kind: 'input', text });
        }
      },
      onError: (err) => this.broadcast({ type: 'error', message: err.message }),
      onStatus: (state) => this.broadcast({ type: 'status', state }),
    });
  }

  broadcast(obj) {
    const payload = JSON.stringify(obj);
    for (const ws of this.listeners) {
      if (ws.readyState !== ws.OPEN) continue;
      if (obj.type === 'audio' && ws.bufferedAmount > LISTENER_AUDIO_BUFFER_LIMIT_BYTES) continue;
      ws.send(payload);
    }
  }

  addListener(ws) {
    this.listeners.add(ws);
    if (this.lingerTimer) {
      clearTimeout(this.lingerTimer);
      this.lingerTimer = null;
    }
  }

  removeListener(ws) {
    this.listeners.delete(ws);
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
  constructor(manager, { title, echoTargetLanguage, id, apiTier }) {
    this.manager = manager;
    this.id = id || makeSessionId();
    this.title = title || 'Live translation';
    this.echoTargetLanguage = Boolean(echoTargetLanguage);
    this.apiTier = normalizeApiTier(apiTier);
    this.apiKey = manager.apiKeyForTier(this.apiTier);
    this.createdAt = Date.now();
    this.speakerSockets = new Set();
    this.speakerWs = null;
    this.speakerGraceTimer = null;
    this.channels = new Map(); // lang -> LanguageChannel
    this.transcriptChannel = null; // listener channel that mirrors input transcripts to the speaker as a fallback
    this.speakerTranscriptTranslator = null; // hidden Gemini stream for speaker transcript even with no listeners
    this.ended = false;
    this.lastAudioAt = Date.now();
    this.audioIdleTimer = null;
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
        if (kind === 'input') this.sendToSpeaker({ type: 'transcript', kind: 'input', text });
      },
      onError: (err) => this.sendToSpeaker({ type: 'error', message: err.message }),
    });
    this.speakerTranscriptTranslator = translator;
    translator.connect().catch((err) => {
      console.error(`[session:${this.id}] speaker transcript failed:`, err.message);
    });
  }

  /** Fan one base64 PCM chunk out to Gemini and every active language translator. */
  pushAudio(base64Chunk) {
    if (this.ended) return;
    this.lastAudioAt = Date.now();
    this.ensureSpeakerTranscript();
    this.speakerTranscriptTranslator?.sendAudio(base64Chunk);
    for (const channel of this.channels.values()) {
      channel.translator.sendAudio(base64Chunk);
    }
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

  end(reason = 'ended by speaker') {
    if (this.ended) return;
    this.ended = true;
    if (this.audioIdleTimer) clearTimeout(this.audioIdleTimer);
    this.audioIdleTimer = null;
    if (this.speakerGraceTimer) clearTimeout(this.speakerGraceTimer);
    this.speakerGraceTimer = null;
    this.speakerTranscriptTranslator?.close();
    this.speakerTranscriptTranslator = null;
    for (const lang of [...this.channels.keys()]) this.closeChannel(lang);
    for (const ws of this.speakerSockets) {
      if (ws.readyState === ws.OPEN) ws.close(1000, 'session ended');
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
    const normalizedTier = normalizeApiTier(apiTier);
    const apiKey = this.apiKeys?.[normalizedTier];
    if (!apiKey) throw new Error('Missing Gemini API key for ' + normalizedTier + ' tier');
    return apiKey;
  }

  create(opts = {}) {
    const id = sanitizeId(opts.id);
    if (opts.id && !id) throw new Error('Invalid session code');
    // Reviving a code that still exists (e.g. two speaker tabs) is a no-op.
    if (id && this.sessions.has(id)) return this.sessions.get(id);
    const session = new Session(this, { ...opts, id });
    this.sessions.set(session.id, session);
    console.log(`[session:${session.id}] ${id ? 'revived' : 'created'} ("${session.title}")`);
    return session;
  }

  get(id) {
    return this.sessions.get((id || '').toUpperCase());
  }
}
