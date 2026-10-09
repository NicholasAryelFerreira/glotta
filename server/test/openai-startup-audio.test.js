import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { WebSocketServer } from 'ws';
import { OpenAITranslator } from '../src/openaiTranslator.js';
import { SessionManager } from '../src/sessionManager.js';

// 100 ms of 16 kHz PCM16, the chunk size the speaker page sends.
const CHUNK = Buffer.alloc(3_200, 1).toString('base64');

// Stands in for OpenAI: confirms the session shortly after it is configured
// and records every audio append it receives.
async function fakeOpenAI(context) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const appended = [];
  server.on('connection', (socket) => {
    socket.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'session.update') {
        setTimeout(() => socket.send(JSON.stringify({ type: 'session.updated' })), 20);
      }
      if (msg.type === 'input_audio_buffer.append' || msg.type === 'session.input_audio_buffer.append') {
        appended.push(msg.audio);
      }
    });
  });
  context.after(async () => {
    for (const client of server.clients) client.terminate();
    await new Promise((resolve) => server.close(resolve));
  });
  return { url: `ws://127.0.0.1:${server.address().port}`, appended };
}

function waitFor(predicate, timeoutMs = 2_000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const check = () => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error('timed out waiting'));
      setTimeout(check, 5);
    };
    check();
  });
}

function stream(url, options) {
  return new OpenAITranslator({
    apiKey: 'test-key',
    wsUrl: url,
    onAudio() {},
    onTranscript() {},
    onStatus() {},
    onError() {},
    ...options,
  });
}

test('the OpenAI speaker transcript keeps the audio sent while the session starts', async (context) => {
  context.mock.method(console, 'log', () => {});
  const { url, appended } = await fakeOpenAI(context);
  const transcript = stream(url, { targetLanguage: 'en', streamMode: 'transcription', pendingAudioSeconds: 5 });
  context.after(() => transcript.close());
  for (let i = 0; i < 30; i++) transcript.sendAudio(CHUNK); // 3 s before OpenAI is ready
  await transcript.connect();
  await waitFor(() => appended.length === 30);
  assert.equal(transcript.droppedPendingChunks, 0, 'the first words are not dropped');
});

test('listener translation streams keep the live-edge startup limit', async (context) => {
  context.mock.method(console, 'log', () => {});
  const { url, appended } = await fakeOpenAI(context);
  const listener = stream(url, { targetLanguage: 'es', streamMode: 'translation' });
  context.after(() => listener.close());
  for (let i = 0; i < 30; i++) listener.sendAudio(CHUNK);
  await listener.connect();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(appended.length < 30, 'listeners stay near live instead of catching up on old audio');
  assert.equal(listener.droppedPendingChunks, 30 - appended.length);
});

test('only the OpenAI speaker transcript gets the larger startup allowance', () => {
  const manager = new SessionManager({ gemini: 'gemini-key', openai: 'openai-key' });
  const transcript = manager.createTranscriptStream('openai', { targetLanguage: 'en' });
  assert.equal(transcript.pendingAudioLimit, 50);
  assert.equal(transcript.keepsStartupAudio, true);
  const listener = manager.createTranslator('openai', { targetLanguage: 'es' });
  assert.equal(listener.keepsStartupAudio, false);
});
