import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { WebSocketServer } from 'ws';
import {
  HANDOVER_DEADLINE_MARGIN_MS,
  HANDOVER_MIN_WARMUP_MS,
  HandoverTranslator,
  pcm16Base64IsSilent,
} from '../src/handoverTranslator.js';
import { OpenAITranslator } from '../src/openaiTranslator.js';
import { SessionManager } from '../src/sessionManager.js';
import { goAwayTimeLeftMs, Translator } from '../src/translator.js';

// 250 ms of 24 kHz PCM16, the chunk size Gemini streams to listeners.
const SILENT = Buffer.alloc(6_000 * 2).toString('base64');
const SPEECH = (() => {
  const pcm = Buffer.alloc(6_000 * 2);
  for (let i = 0; i < 6_000; i++) pcm.writeInt16LE(i % 2 ? 8_000 : -8_000, i * 2);
  return pcm.toString('base64');
})();

function fakeStreams() {
  const streams = [];
  const createStream = (options) => {
    const stream = {
      options,
      ready: false,
      closed: false,
      sent: [],
      connect() {
        this.connectCalls = (this.connectCalls || 0) + 1;
        return Promise.resolve();
      },
      sendAudio(chunk) { this.sent.push(chunk); },
      close() {
        this.closed = true;
        this.ready = false;
      },
      online() {
        this.ready = true;
        options.onStatus('translator-online');
      },
      lost() {
        this.ready = false;
        options.onStatus('translator-reconnecting');
      },
      audio(chunk) { options.onAudio(chunk); },
      caption(text) { options.onTranscript('output', text); },
      goAway(timeLeftMs = 50_000) { options.onGoAway({ timeLeftMs }); },
    };
    streams.push(stream);
    return stream;
  };
  return { streams, createStream };
}

function listenerStream(context, sessionId) {
  const lines = [];
  context.mock.method(console, 'log', (...args) => lines.push(args.join(' ')));
  const heard = { audio: [], captions: [], statuses: [], errors: [] };
  const { streams, createStream } = fakeStreams();
  const translator = new HandoverTranslator({
    targetLanguage: 'es',
    sessionId,
    streamKind: 'listener',
    provider: 'gemini',
    onAudio: (data) => heard.audio.push(data),
    onTranscript: (kind, text) => heard.captions.push(`${kind}:${text}`),
    onStatus: (state) => heard.statuses.push(state),
    onError: (err) => heard.errors.push(err.message),
  }, { createStream });
  const handoverEvents = () => lines
    .filter((line) => line.includes('"event":"gemini-handover-'))
    .map((line) => JSON.parse(line.slice(line.indexOf('{'))));
  return { translator, streams, heard, handoverEvents };
}

test('GoAway time left is read from protobuf durations', () => {
  assert.equal(goAwayTimeLeftMs('50s'), 50_000);
  assert.equal(goAwayTimeLeftMs('49.5s'), 49_500);
  assert.equal(goAwayTimeLeftMs({ seconds: '50', nanos: 0 }), 50_000);
  assert.equal(goAwayTimeLeftMs('unknown'), null);
  assert.equal(goAwayTimeLeftMs({}), null);
});

test('silence detection separates quiet PCM from speech', () => {
  assert.equal(pcm16Base64IsSilent(SILENT), true);
  assert.equal(pcm16Base64IsSilent(SPEECH), false);
  assert.equal(pcm16Base64IsSilent(''), true);
});

test('only Gemini listener streams use the handover wrapper', () => {
  const manager = new SessionManager('test-key');
  assert.ok(manager.createTranslator('gemini', { targetLanguage: 'es' }) instanceof HandoverTranslator);
  assert.ok(manager.createTranslator('openai', { targetLanguage: 'es' }) instanceof OpenAITranslator);
  const captions = manager.createTranscriptStream('gemini', { targetLanguage: 'en' });
  assert.ok(captions instanceof Translator);
  assert.ok(!(captions instanceof HandoverTranslator));
});

test('listeners move to a warmed standby at a pause without a reconnect status', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const { translator, streams, heard, handoverEvents } = listenerStream(context, 'HAND01');
  const [old] = streams;
  old.online();
  assert.deepEqual(heard.statuses, ['translator-online']);

  old.goAway(50_000);
  assert.equal(streams.length, 2);
  const standby = streams[1];
  assert.equal(standby.connectCalls, 1);

  translator.sendAudio('before-standby-ready');
  assert.deepEqual(old.sent, ['before-standby-ready']);
  assert.deepEqual(standby.sent, []);

  standby.online();
  translator.sendAudio('during-overlap');
  assert.deepEqual(old.sent, ['before-standby-ready', 'during-overlap']);
  assert.deepEqual(standby.sent, ['during-overlap']);

  // Only the old connection reaches listeners during the overlap.
  old.caption('uno');
  old.audio(SPEECH);
  standby.caption('uno bis');
  standby.audio(SPEECH);
  standby.options.onError(new Error('standby error'));
  assert.deepEqual(heard.captions, ['output:uno']);
  assert.deepEqual(heard.audio, [SPEECH]);
  assert.deepEqual(heard.errors, []);

  // A pause before the warm-up ends is not enough.
  old.audio(SILENT);
  old.audio(SILENT);
  standby.audio(SILENT);
  assert.equal(translator.active, old);

  context.mock.timers.tick(HANDOVER_MIN_WARMUP_MS);
  old.audio(SPEECH);
  standby.audio(SILENT);
  assert.equal(translator.active, old, 'old connection is still speaking');
  standby.audio(SPEECH);
  old.audio(SILENT);
  old.audio(SILENT);
  assert.equal(translator.active, old, 'standby is still speaking');
  standby.audio(SILENT);
  assert.equal(translator.active, standby);
  assert.equal(old.closed, true);
  assert.equal(heard.audio.at(-1), SILENT, 'the switching chunk keeps playback even');

  const heardBefore = heard.audio.length;
  old.audio(SPEECH);
  old.caption('late old caption');
  standby.audio(SPEECH);
  standby.caption('dos');
  assert.equal(heard.audio.length, heardBefore + 1);
  assert.deepEqual(heard.captions, ['output:uno', 'output:dos']);

  translator.sendAudio('after-switch');
  assert.equal(old.sent.at(-1), 'during-overlap');
  assert.equal(standby.sent.at(-1), 'after-switch');
  assert.deepEqual(heard.statuses, ['translator-online']);

  const [start, complete] = handoverEvents();
  assert.equal(start.event, 'gemini-handover-start');
  assert.equal(start.timeLeftMs, 50_000);
  assert.equal(complete.event, 'gemini-handover-complete');
  assert.equal(complete.reason, 'pause');
  assert.equal(complete.standbyOutputTranscripts, 1);

  // The cleared deadline cannot fire later, and the next GoAway starts again.
  context.mock.timers.tick(60_000);
  assert.equal(streams.length, 2);
  standby.goAway(50_000);
  assert.equal(streams.length, 3);
  translator.close();
  assert.equal(streams[2].closed, true);
  assert.equal(standby.closed, true);
});

test('the deadline switches to a translating standby when no pause arrives', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const { translator, streams, heard, handoverEvents } = listenerStream(context, 'HAND02');
  const [old] = streams;
  old.online();
  old.goAway(50_000);
  const standby = streams[1];
  standby.online();
  old.caption('sigue');
  standby.caption('sigue');
  for (let i = 0; i < 20; i++) {
    old.audio(SPEECH);
    standby.audio(SPEECH);
  }
  context.mock.timers.tick(50_000 - HANDOVER_DEADLINE_MARGIN_MS - 1);
  assert.equal(translator.active, old);
  context.mock.timers.tick(1);
  assert.equal(translator.active, standby);
  assert.equal(old.closed, true);
  assert.deepEqual(heard.statuses, ['translator-online']);
  assert.equal(handoverEvents().at(-1).reason, 'deadline');
  translator.close();
});

test('a standby that never translates is dropped and the old reconnect path stays', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const { translator, streams, heard, handoverEvents } = listenerStream(context, 'HAND03');
  const [old] = streams;
  old.online();
  old.goAway(50_000);
  const standby = streams[1];
  standby.online();
  context.mock.timers.tick(HANDOVER_MIN_WARMUP_MS);
  old.caption('hablando');
  old.audio(SILENT);
  old.audio(SILENT);
  standby.audio(SILENT);
  assert.equal(translator.active, old);

  context.mock.timers.tick(50_000);
  assert.equal(translator.active, old);
  assert.equal(standby.closed, true);
  assert.equal(handoverEvents().at(-1).event, 'gemini-handover-abandoned');
  assert.equal(handoverEvents().at(-1).reason, 'standby-not-translating');

  old.lost();
  assert.deepEqual(heard.statuses, ['translator-online', 'translator-reconnecting']);
  translator.close();
});

test('a failed standby falls back without telling listeners', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const { translator, streams, heard, handoverEvents } = listenerStream(context, 'HAND04');
  const [old] = streams;
  old.online();
  old.goAway(50_000);
  const standby = streams[1];
  standby.lost();
  assert.equal(standby.closed, true);
  assert.equal(translator.handover, null);
  assert.deepEqual(heard.statuses, ['translator-online']);
  assert.equal(handoverEvents().at(-1).reason, 'standby-closed');

  context.mock.timers.tick(60_000);
  assert.equal(translator.active, old);
  old.lost();
  assert.deepEqual(heard.statuses, ['translator-online', 'translator-reconnecting']);
  translator.close();
});

test('an early Gemini close hands over to a ready standby instead of reconnecting', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const { translator, streams, heard, handoverEvents } = listenerStream(context, 'HAND05');
  const [old] = streams;
  old.online();
  old.goAway(50_000);
  const standby = streams[1];
  standby.online();
  old.lost();
  assert.equal(translator.active, standby);
  assert.equal(old.closed, true);
  assert.deepEqual(heard.statuses, ['translator-online']);
  assert.equal(handoverEvents().at(-1).reason, 'provider-closed');
  standby.audio(SPEECH);
  assert.deepEqual(heard.audio, [SPEECH]);
  translator.close();
});

test('an early Gemini close before the standby is ready keeps the normal reconnect', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const { translator, streams, heard } = listenerStream(context, 'HAND06');
  const [old] = streams;
  old.online();
  old.goAway(50_000);
  const standby = streams[1];
  old.lost();
  assert.equal(translator.active, old);
  assert.equal(standby.closed, true);
  assert.deepEqual(heard.statuses, ['translator-online', 'translator-reconnecting']);
  translator.close();
});

test('closing a listener stream mid-handover closes both connections', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const { translator, streams, handoverEvents } = listenerStream(context, 'HAND07');
  const [old] = streams;
  old.online();
  old.goAway(50_000);
  translator.close();
  assert.equal(old.closed, true);
  assert.equal(streams[1].closed, true);
  assert.equal(handoverEvents().at(-1).reason, 'closed');
  context.mock.timers.tick(60_000);
  assert.equal(streams.length, 2);
  old.goAway(50_000);
  assert.equal(streams.length, 2, 'a closed stream never opens a standby');
});

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

test('real Gemini sockets: fresh standby setup, overlap, switch, and no reconnect', { timeout: 15_000 }, async (context) => {
  context.mock.method(console, 'log', () => {});
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const connections = [];
  server.on('connection', (socket) => {
    const connection = { socket, setup: null, audio: [], closed: false };
    socket.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.setup) {
        connection.setup = msg.setup;
        socket.send(JSON.stringify({ setupComplete: {} }));
      }
      if (msg.realtimeInput) connection.audio.push(msg.realtimeInput.audio.data);
    });
    socket.on('close', () => { connection.closed = true; });
    connections.push(connection);
  });
  const heard = { audio: [], captions: [], statuses: [] };
  const translator = new HandoverTranslator({
    apiKey: 'test-key',
    targetLanguage: 'es',
    sessionId: 'HANDWS',
    streamKind: 'listener',
    provider: 'gemini',
    wsBase: `ws://127.0.0.1:${server.address().port}`,
    onAudio: (data) => heard.audio.push(data),
    onTranscript: (kind, text) => heard.captions.push(`${kind}:${text}`),
    onStatus: (state) => heard.statuses.push(state),
    onError: () => {},
  });
  let oldStream = null;
  context.after(async () => {
    translator.close();
    oldStream?.close();
    for (const client of server.clients) client.terminate();
    await new Promise((resolve) => server.close(resolve));
  });
  const serverContent = (audio, caption) => JSON.stringify({
    serverContent: {
      outputTranscription: { text: caption },
      modelTurn: { parts: [{ inlineData: { data: audio, mimeType: 'audio/pcm;rate=24000' } }] },
    },
  });

  await translator.connect();
  const [old] = connections;
  oldStream = translator.active;
  old.socket.send(JSON.stringify({ sessionResumptionUpdate: { resumable: true, newHandle: 'old-handle' } }));
  // The deadline switch arrives one second after GoAway, well before warm-up.
  const timeLeft = `${(HANDOVER_DEADLINE_MARGIN_MS + 1_000) / 1000}s`;
  old.socket.send(JSON.stringify({ goAway: { timeLeft } }));
  await waitFor(() => translator.handover?.readyAt != null);
  const standby = connections[1];
  assert.deepEqual(standby.setup.sessionResumption, {}, 'the standby is a fresh session');

  translator.sendAudio('AAAA');
  await waitFor(() => old.audio.length === 1 && standby.audio.length === 1);
  standby.socket.send(serverContent(SPEECH, 'standby'));
  await waitFor(() => translator.handover?.standbyOutputs === 1);
  old.socket.send(serverContent(SPEECH, 'old'));
  await waitFor(() => heard.captions.length === 1);
  assert.deepEqual(heard.audio, [SPEECH]);
  assert.equal(translator.active, oldStream);

  await waitFor(() => translator.handover === null);
  assert.notEqual(translator.active, oldStream);
  assert.deepEqual(heard.captions, ['output:old']);
  await waitFor(() => old.closed);

  translator.sendAudio('BBBB');
  await waitFor(() => standby.audio.length === 2);
  assert.deepEqual(old.audio, ['AAAA']);
  standby.socket.send(serverContent(SILENT, 'nuevo'));
  await waitFor(() => heard.captions.length === 2);
  assert.deepEqual(heard.captions, ['output:old', 'output:nuevo']);

  // Translator's own reconnect would open a third connection after one second.
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  assert.equal(connections.length, 2);
  assert.deepEqual(heard.statuses, ['translator-online']);
});
