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
      apiKey: session.manager.apiKey,
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
  constructor(manager, { title, echoTargetLanguage, id }) {
    this.manager = manager;
    this.id = id || makeSessionId();
    this.title = title || 'Live translation';
    this.echoTargetLanguage = Boolean(echoTargetLanguage);
    this.createdAt = Date.now();
    this.speakerWs = null;
    this.channels = new Map(); // lang -> LanguageChannel
    this.transcriptChannel = null; // listener channel that mirrors input transcripts to the speaker as a fallback
    this.speakerTranscriptTranslator = null; // hidden Gemini stream for speaker transcript even with no listeners
  }

  attachSpeaker(ws) {
    if (this.speakerWs && this.speakerWs.readyState === this.speakerWs.OPEN) {
      this.speakerWs.close(4000, 'replaced by a new speaker connection');
    }
    this.speakerWs = ws;
  }

  sendToSpeaker(obj) {
    if (this.speakerWs && this.speakerWs.readyState === this.speakerWs.OPEN) {
      this.speakerWs.send(JSON.stringify(obj));
    }
  }

  ensureSpeakerTranscript() {
    if (this.speakerTranscriptTranslator) return;
    const translator = new Translator({
      apiKey: this.manager.apiKey,
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
    this.sendToSpeaker({ type: 'stats', total, listeners });
  }

  end() {
    this.speakerTranscriptTranslator?.close();
    this.speakerTranscriptTranslator = null;
    for (const lang of [...this.channels.keys()]) this.closeChannel(lang);
    if (this.speakerWs && this.speakerWs.readyState === this.speakerWs.OPEN) {
      this.speakerWs.close(1000, 'session ended');
    }
    this.manager.sessions.delete(this.id);
    console.log(`[session:${this.id}] ended`);
  }
}

export class SessionManager {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.sessions = new Map(); // id -> Session
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
