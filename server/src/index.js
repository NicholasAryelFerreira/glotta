import 'dotenv/config';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';
import QRCode from 'qrcode';
import { SessionManager } from './sessionManager.js';
import { LANGUAGES, isSupportedLanguage } from './languages.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8080);
const API_KEY = process.env.GEMINI_API_KEY;

if (!API_KEY) {
  console.error('Missing GEMINI_API_KEY. Copy .env.example to .env and set your key.');
  process.exit(1);
}

// If the speaker drops (network blip, app backgrounded, page refresh), keep the
// session alive this long so they can reconnect without every listener losing
// it. The speaker page also re-establishes its connection automatically on
// load, so this is mainly a cushion for longer outages.
const SPEAKER_GRACE_MS = 5 * 60_000;

const manager = new SessionManager(API_KEY);
const app = express();
// Render (and most cloud hosts) put us behind a TLS-terminating proxy, so trust
// X-Forwarded-Proto/Host to build correct https:// join links and QR codes.
app.set('trust proxy', true);
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

function baseUrl(req) {
  return process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
}

app.get('/api/languages', (_req, res) => {
  res.json({ languages: LANGUAGES });
});

app.post('/api/sessions', (req, res) => {
  const { title, echoTargetLanguage } = req.body || {};
  const session = manager.create({ title, echoTargetLanguage });
  res.json({
    sessionId: session.id,
    title: session.title,
    joinUrl: `${baseUrl(req)}/join/${session.id}`,
  });
});

app.get('/api/sessions/:id', (req, res) => {
  const session = manager.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  res.json({
    sessionId: session.id,
    title: session.title,
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

wss.on('connection', async (ws, req) => {
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

function handleSpeaker(ws, session) {
  session.attachSpeaker(ws);
  if (session.speakerGraceTimer) {
    clearTimeout(session.speakerGraceTimer);
    session.speakerGraceTimer = null;
  }
  console.log(`[session:${session.id}] speaker connected`);
  ws.send(JSON.stringify({ type: 'status', state: 'connected', sessionId: session.id }));
  session.notifySpeakerStats();
  broadcastToAll(session, { type: 'status', state: 'speaker-online' });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.type === 'audio' && typeof msg.data === 'string') {
      session.pushAudio(msg.data);
    } else if (msg.type === 'end') {
      session.end();
    }
  });

  ws.on('close', () => {
    if (session.speakerWs !== ws) return; // replaced by a newer connection
    console.log(`[session:${session.id}] speaker disconnected, grace ${SPEAKER_GRACE_MS / 1000}s`);
    broadcastToAll(session, { type: 'status', state: 'speaker-offline' });
    session.speakerGraceTimer = setTimeout(() => session.end(), SPEAKER_GRACE_MS);
  });
}

async function handleListener(ws, session, lang) {
  if (!lang || !isSupportedLanguage(lang)) {
    ws.send(JSON.stringify({ type: 'error', message: `Unsupported language: ${lang}` }));
    ws.close(4400, 'unsupported language');
    return;
  }
  try {
    await session.addListener(ws, lang);
  } catch (err) {
    console.error(`[session:${session.id}] failed to open ${lang} channel:`, err.message);
    ws.send(JSON.stringify({ type: 'error', message: 'Could not start translation for this language. Try again.' }));
    ws.close(4500, 'translator connect failed');
    return;
  }
  console.log(`[session:${session.id}] listener joined (${lang})`);
  ws.send(JSON.stringify({ type: 'status', state: 'connected', lang, title: session.title }));

  ws.on('close', () => {
    session.removeListener(ws, lang);
    console.log(`[session:${session.id}] listener left (${lang})`);
  });
}

function broadcastToAll(session, obj) {
  for (const channel of session.channels.values()) channel.broadcast(obj);
}

server.listen(PORT, () => {
  const nets = os.networkInterfaces();
  const lanIps = Object.values(nets)
    .flat()
    .filter((n) => n && n.family === 'IPv4' && !n.internal)
    .map((n) => n.address);
  console.log(`Glotta server listening on port ${PORT}`);
  console.log(`  Local:   http://localhost:${PORT}`);
  for (const ip of lanIps) console.log(`  Network: http://${ip}:${PORT}`);
});
