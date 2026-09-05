import 'dotenv/config';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';
import QRCode from 'qrcode';
import {
  isValidSessionId,
  normalizeApiTier,
  normalizeProvider,
  SessionManager,
} from './sessionManager.js';
import { isSupportedLanguage, languagesForProvider } from './languages.js';
import {
  LIVE_EDGE_LISTENER_MAX_BUFFER_SECONDS,
  LIVE_EDGE_MAX_QUEUE_SECONDS,
} from './liveEdge.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8080);
const API_KEYS = {
  gemini: {
    free: process.env.GEMINI_API_KEY_FREE,
    paid: process.env.GEMINI_API_KEY_PAID,
  },
  openai: process.env.OPENAI_API_KEY,
};
// Shared passcode required to *create* a session (i.e. to be the speaker), so
// strangers who find the public URL can't spin up sessions on our Gemini key.
// If unset, creation is open (e.g. for local development).
const CREATE_PASSWORD = process.env.PASSWORD;

if (!API_KEYS.gemini.paid) {
  console.error('Missing GEMINI_API_KEY_PAID. Copy .env.example to .env and set the paid Gemini key.');
  process.exit(1);
}
if (!API_KEYS.gemini.free) {
  console.warn('No GEMINI_API_KEY_FREE set — the free Gemini option will be unavailable.');
}
if (!API_KEYS.openai) {
  console.warn('No OPENAI_API_KEY set — the OpenAI GPT provider will be unavailable.');
}

if (!CREATE_PASSWORD) {
  console.warn('No PASSWORD set — anyone can create a session. Set PASSWORD to require a passcode.');
}

// Fixed code for the recurring weekly service. Because it never changes, the
// join link and QR code can be printed once and reused every Sunday; the
// speaker just picks "weekly session" on the home page to go live under it.
const WEEKLY_SESSION_ID = (process.env.WEEKLY_SESSION_ID || 'SERMON').toUpperCase();
if (!isValidSessionId(WEEKLY_SESSION_ID)) {
  console.error(`Invalid WEEKLY_SESSION_ID "${WEEKLY_SESSION_ID}": must be 6 letters or digits.`);
  process.exit(1);
}

// If the speaker drops (network blip, app backgrounded, page refresh), keep the
// session alive this long so they can reconnect without every listener losing
// it. The speaker page also re-establishes its connection automatically on
// load, so this is mainly a cushion for longer outages.
const SPEAKER_GRACE_MS = 5 * 60_000;

const manager = new SessionManager(API_KEYS);
const app = express();
// Render (and most cloud hosts) put us behind a TLS-terminating proxy, so trust
// X-Forwarded-Proto/Host to build correct https:// join links and QR codes.
app.set('trust proxy', true);
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

function baseUrl(req) {
  return process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
}

app.get('/api/languages', (req, res) => {
  const provider = normalizeProvider(req.query.provider);
  res.json({ provider, languages: languagesForProvider(provider) });
});

app.get('/api/config', (req, res) => {
  res.json({
    weeklySessionId: WEEKLY_SESSION_ID,
    weeklyJoinUrl: `${baseUrl(req)}/join/${WEEKLY_SESSION_ID}`,
    liveEdgeMaxQueueSeconds: LIVE_EDGE_MAX_QUEUE_SECONDS,
    listenerMaxBufferSeconds: LIVE_EDGE_MAX_QUEUE_SECONDS > 0
      ? LIVE_EDGE_LISTENER_MAX_BUFFER_SECONDS
      : 4,
    providers: {
      gemini: manager.hasProvider('gemini'),
      openai: manager.hasProvider('openai'),
    },
    apiTiers: {
      gemini: {
        paid: manager.hasApiTier('gemini', 'paid'),
        free: manager.hasApiTier('gemini', 'free'),
      },
      openai: {
        paid: manager.hasApiTier('openai', 'paid'),
        free: false,
      },
    },
  });
});

app.post('/api/sessions', (req, res) => {
  const { title, echoTargetLanguage, password, sessionId, provider, apiTier } = req.body || {};
  if (CREATE_PASSWORD && password !== CREATE_PASSWORD) {
    return res.status(401).json({ error: 'Incorrect password' });
  }
  if (sessionId && !isValidSessionId(sessionId)) {
    return res.status(400).json({ error: 'Invalid session code' });
  }
  const requestedProvider = normalizeProvider(provider);
  if (requestedProvider === 'openai' && apiTier === 'free') {
    return res.status(400).json({ error: 'Free sessions are available only with Google Gemini.' });
  }
  const requestedApiTier = normalizeApiTier(apiTier, requestedProvider);
  const existingSession = sessionId ? manager.get(sessionId) : null;
  if (existingSession && (
    existingSession.provider !== requestedProvider || existingSession.apiTier !== requestedApiTier
  )) {
    return res.status(409).json({
      error: 'This session is already using ' + existingSession.provider + ' with the ' + existingSession.apiTier + ' option. Select the same provider and option to reconnect.',
    });
  }
  if (!manager.hasApiTier(requestedProvider, requestedApiTier)) {
    return res.status(503).json({ error: 'The selected translation provider and session type are not configured.' });
  }
  // sessionId is optional: the home page omits it (new code), while the speaker
  // page passes it to revive its session under the same code after a restart.
  const session = manager.create({
    title,
    echoTargetLanguage,
    id: sessionId,
    provider: requestedProvider,
    apiTier: requestedApiTier,
  });
  res.json({
    sessionId: session.id,
    title: session.title,
    provider: session.provider,
    apiTier: session.apiTier,
    joinUrl: `${baseUrl(req)}/join/${session.id}`,
  });
});

app.get('/api/sessions/:id', (req, res) => {
  const session = manager.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  res.json({
    sessionId: session.id,
    title: session.title,
    provider: session.provider,
    apiTier: session.apiTier,
    speakerOnline: Boolean(session.speakerWs && session.speakerWs.readyState === session.speakerWs.OPEN),
    activeLanguages: [...session.channels.keys()],
  });
});

app.get('/api/sessions/:id/qr.png', async (req, res) => {
  const session = manager.get(req.params.id);
  if (!session) return res.status(404).send('Session not found');
  const url = `${baseUrl(req)}/join/${session.id}`;
  res.type('png');
  res.send(await QRCode.toBuffer(url, { width: 480, margin: 1 }));
});

app.get('/join/:id', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'join.html'));
});

app.get('/speak/:id', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'speak.html'));
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Heartbeat: ping every connected browser periodically so idle connections
// aren't closed by Render's proxy (which was ending sessions when the speaker
// page sat idle and made the QR vanish on refresh), keep the service warm, and
// clean up dead sockets. Browsers reply to ping frames automatically, even in a
// backgrounded tab, so a genuinely-open page stays alive.
const HEARTBEAT_MS = 30_000;
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch { /* socket already closing */ }
  }
}, HEARTBEAT_MS);
wss.on('close', () => clearInterval(heartbeat));

wss.on('connection', async (ws, req) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  const url = new URL(req.url, 'http://localhost');
  const parts = url.pathname.split('/').filter(Boolean); // e.g. ["ws", "speaker", "ABC123"]

  if (parts[0] !== 'ws' || parts.length < 3) {
    ws.close(4404, 'unknown endpoint');
    return;
  }
  const role = parts[1];
  const session = manager.get(parts[2]);
  if (!session) {
    ws.send(JSON.stringify({ type: 'error', message: 'Session not found' }));
    ws.close(4404, 'session not found');
    return;
  }

  if (role === 'speaker') {
    handleSpeaker(ws, session);
  } else if (role === 'listener') {
    await handleListener(ws, session, url.searchParams.get('lang'));
  } else {
    ws.close(4404, 'unknown role');
  }
});

const SPEAKER_BUSY_MESSAGE = 'Another device is capturing audio for this session.';

function claimSpeakerInput(ws, session) {
  const wasAlreadyClaimed = session.speakerWs === ws;
  if (!session.claimSpeaker(ws)) {
    if (!ws.speakerBusyNotified) {
      ws.send(JSON.stringify({ type: 'error', code: 'speaker-busy', message: SPEAKER_BUSY_MESSAGE }));
      ws.speakerBusyNotified = true;
    }
    return false;
  }
  if (session.speakerGraceTimer) {
    clearTimeout(session.speakerGraceTimer);
    session.speakerGraceTimer = null;
  }
  ws.speakerBusyNotified = false;
  ws.send(JSON.stringify({ type: 'speaker-claim', state: 'granted' }));
  if (!wasAlreadyClaimed) {
    console.log(`[session:${session.id}] speaker audio claimed`);
    broadcastToAll(session, { type: 'status', state: 'speaker-online' });
  }
  return true;
}

function handleSpeaker(ws, session) {
  const connectedAt = Date.now();
  session.addSpeakerSocket(ws);
  console.log(`[session:${session.id}] speaker page connected`);
  ws.send(JSON.stringify({ type: 'status', state: 'connected', sessionId: session.id }));
  session.notifySpeakerStats();

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.type === 'start-speaking') {
      ws.speakerBusyNotified = false;
      claimSpeakerInput(ws, session);
    } else if (msg.type === 'stop-speaking') {
      if (session.releaseSpeaker(ws)) {
        console.log(`[session:${session.id}] speaker audio released`);
        broadcastToAll(session, { type: 'status', state: 'speaker-paused' });
      }
    } else if (msg.type === 'audio' && typeof msg.data === 'string') {
      if (session.speakerWs !== ws && !claimSpeakerInput(ws, session)) return;
      session.pushAudio(msg.data, {
        capturedAt: msg.capturedAt,
        sequence: msg.sequence,
        speechDetected: msg.speechDetected,
      });
    } else if (msg.type === 'audio-stats' && session.speakerWs === ws) {
      session.recordSpeakerClientMetrics(msg);
    } else if (msg.type === 'end') {
      session.end();
    }
  });

  ws.on('close', (code) => {
    session.removeSpeakerSocket(ws);
    if (!session.releaseSpeaker(ws)) return;
    if (session.ended) return;
    console.log(
      `[session:${session.id}] active speaker disconnected ` +
      `(code: ${code}, connectedMs: ${Date.now() - connectedAt}, graceSeconds: ${SPEAKER_GRACE_MS / 1000})`,
    );
    broadcastToAll(session, { type: 'status', state: 'speaker-offline' });
    session.speakerGraceTimer = setTimeout(() => session.end(), SPEAKER_GRACE_MS);
  });
}

async function handleListener(ws, session, lang) {
  if (!lang || !isSupportedLanguage(lang, session.provider)) {
    ws.send(JSON.stringify({ type: 'error', message: `Unsupported language: ${lang}` }));
    ws.close(4400, 'unsupported language');
    return;
  }
  let channel;
  try {
    channel = await session.addListener(ws, lang);
  } catch (err) {
    console.error(`[session:${session.id}] failed to open ${lang} channel:`, err.message);
    ws.send(JSON.stringify({ type: 'error', message: 'Could not start translation for this language. Try again.' }));
    ws.close(4500, 'translator connect failed');
    return;
  }
  const connectedAt = Date.now();
  console.log(`[session:${session.id}] listener joined (${lang}, active: ${channel.listeners.size})`);
  ws.send(JSON.stringify({ type: 'status', state: 'connected', lang, title: session.title }));
  if (!session.speakerWs) {
    ws.send(JSON.stringify({
      type: 'status',
      state: session.speakerGraceTimer ? 'speaker-offline' : 'speaker-paused',
    }));
  }

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.type === 'listener-audio-stats') {
      session.recordListenerPlayerMetrics(lang, msg);
    }
  });

  ws.on('close', (code) => {
    session.removeListener(ws, lang);
    console.log(
      `[session:${session.id}] listener left ` +
      `(${lang}, code: ${code}, connectedMs: ${Date.now() - connectedAt}, active: ${channel.listeners.size})`,
    );
  });
}

function broadcastToAll(session, obj) {
  for (const channel of session.channels.values()) channel.broadcast(obj);
}

server.listen(PORT, () => {
  console.log(
    LIVE_EDGE_MAX_QUEUE_SECONDS > 0
      ? `Glotta server listening on port ${PORT} ` +
        `(live-edge: ${LIVE_EDGE_MAX_QUEUE_SECONDS}s network queues, ${LIVE_EDGE_LISTENER_MAX_BUFFER_SECONDS}s listener buffer)`
      : `Glotta server listening on port ${PORT} (live-edge disabled)`,
  );
  // Render only needs the bound port. Keep LAN addresses available for local
  // phone testing without adding deployment-only startup noise.
  if (!process.env.RENDER) {
    const lanIps = Object.values(os.networkInterfaces())
      .flat()
      .filter((network) => network && network.family === 'IPv4' && !network.internal)
      .map((network) => network.address);
    console.log(`  Local:   http://localhost:${PORT}`);
    for (const ip of lanIps) console.log(`  Network: http://${ip}:${PORT}`);
  }
});
