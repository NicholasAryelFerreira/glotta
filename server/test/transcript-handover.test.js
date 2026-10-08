import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { WebSocketServer } from 'ws';
import { SessionManager } from '../src/sessionManager.js';
import {
  TRANSCRIPT_HANDOVER_DEADLINE_MARGIN_MS,
  TRANSCRIPT_HANDOVER_DRAIN_MAX_MS,
  TRANSCRIPT_HANDOVER_DRAIN_MIN_MS,
  TranscriptHandoverTranslator,
} from '../src/transcriptHandover.js';

// 100 ms of 16 kHz PCM16, the chunk size the speaker page sends.
const QUIET = Buffer.alloc(1_600 * 2).toString('base64');
const SPEECH = (() => {
  const pcm = Buffer.alloc(1_600 * 2);
  for (let i = 0; i < 1_600; i++) pcm.writeInt16LE(i % 2 ? 8_000 : -8_000, i * 2);
  return pcm.toString('base64');
})();

function fakeStreams(streamMode = 'transcription') {
  const streams = [];
  const createStream = (options) => {
    const stream = {
      options,
      streamMode,
      model: 'fake-model',
      ready: false,
      closed: false,
      sent: [],
      connect() { return Promise.resolve(); },
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
      interim(text) { options.onTranscript('input-interim', text); },
      final(text) { options.onTranscript('input-final', text); },
      goAway(timeLeftMs = 50_000) { options.onGoAway({ timeLeftMs }); },
    };
    streams.push(stream);
    return stream;
  };
  return { streams, createStream };
}

function transcriptStream(context, sessionId, streamMode) {
  const lines = [];
  context.mock.method(console, 'log', (...args) => lines.push(args.join(' ')));
  const heard = { transcript: [], statuses: [], errors: [] };
  const { streams, createStream } = fakeStreams(streamMode);
  const translator = new TranscriptHandoverTranslator({
    targetLanguage: 'en',
    sessionId,
    streamKind: 'speaker-transcript',
    provider: 'gemini',
    onAudio: () => {},
    onTranscript: (kind, text) => heard.transcript.push(`${kind}:${text}`),
    onStatus: (state) => heard.statuses.push(state),
    onError: (err) => heard.errors.push(err.message),
  }, { createStream });
  const handoverEvents = () => lines
    .filter((line) => line.includes('"event":"transcript-handover-'))
    .map((line) => JSON.parse(line.slice(line.indexOf('{'))));
  return { translator, streams, heard, handoverEvents };
}

function send(translator, chunk, count) {
  for (let i = 0; i < count; i++) translator.sendAudio(chunk);
}

test('Gemini speaker captions use the transcript handover wrapper', () => {
  const manager = new SessionManager('test-key');
  const captions = manager.createTranscriptStream('gemini', { targetLanguage: 'en' });
  assert.ok(captions instanceof TranscriptHandoverTranslator);
  assert.equal(captions.streamMode, 'transcription');
  assert.equal(captions.model, 'gemini-3.5-transcribe-live');
});

test('the speaker audio is split at a pause and no words are lost or repeated', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const { translator, streams, heard, handoverEvents } = transcriptStream(context, 'TRAN01');
  const [old] = streams;
  old.online();
  old.final('Before GoAway.');
  old.goAway(50_000);
  const standby = streams[1];

  send(translator, SPEECH, 12);
  standby.online();
  old.interim('the last');
  send(translator, QUIET, 3);
  assert.equal(translator.active, old, 'a 300 ms gap is not a pause');
  translator.sendAudio(QUIET);
  assert.equal(translator.active, standby, 'cut after 400 ms of quiet');
  assert.equal(old.sent.length, 16);
  assert.deepEqual(standby.sent, []);

  // After the cut the new connection hears the speaker; the old one silence.
  translator.sendAudio(SPEECH);
  assert.deepEqual(standby.sent, [SPEECH]);
  assert.equal(old.sent.at(-1), QUIET);

  standby.interim('New');
  standby.final('New phrase.');
  old.final('the last phrase.');
  assert.equal(old.closed, false, 'the old connection drains for at least a second');
  context.mock.timers.tick(TRANSCRIPT_HANDOVER_DRAIN_MIN_MS);
  assert.equal(old.closed, true);
  assert.deepEqual(heard.transcript, [
    'input-final:Before GoAway.',
    'input-interim:the last',
    'input-interim:New',
    'input-final:the last phrase.',
    'input-final:New phrase.',
  ]);
  assert.deepEqual(heard.statuses, ['translator-online']);
  const result = handoverEvents().at(-1);
  assert.equal(result.event, 'transcript-handover-complete');
  assert.equal(result.reason, 'pause');
  assert.equal(result.drainReason, 'finalized');
  assert.equal(result.heldFinals, 1);

  translator.sendAudio(SPEECH);
  assert.equal(old.sent.length, 17, 'a closed connection gets no more audio');
  translator.close();
});

test('the deadline cuts without a pause and keeps unfinalized words', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const { translator, streams, heard, handoverEvents } = transcriptStream(context, 'TRAN02');
  const [old] = streams;
  old.online();
  old.goAway(TRANSCRIPT_HANDOVER_DEADLINE_MARGIN_MS + 2_000);
  const standby = streams[1];
  standby.online();
  send(translator, SPEECH, 15);
  old.interim('words never finalized');
  context.mock.timers.tick(2_000);
  assert.equal(translator.active, standby);

  translator.sendAudio(SPEECH);
  assert.deepEqual(standby.sent, [SPEECH]);
  context.mock.timers.tick(TRANSCRIPT_HANDOVER_DRAIN_MIN_MS);
  assert.equal(old.closed, false, 'still waiting for the interim to be finalized');
  context.mock.timers.tick(TRANSCRIPT_HANDOVER_DRAIN_MAX_MS - TRANSCRIPT_HANDOVER_DRAIN_MIN_MS);
  assert.equal(old.closed, true);
  assert.deepEqual(heard.transcript, [
    'input-interim:words never finalized',
    'input-final:words never finalized',
  ]);
  const result = handoverEvents().at(-1);
  assert.equal(result.reason, 'deadline');
  assert.equal(result.drainReason, 'drain-timeout');
  assert.equal(result.unfinalizedKept, true);
  translator.close();
});

test('Live Translate caption streams drain for the full window', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const { translator, streams, heard } = transcriptStream(context, 'TRAN03', 'translation');
  const [old] = streams;
  old.online();
  old.goAway(50_000);
  const standby = streams[1];
  standby.online();
  send(translator, SPEECH, 12);
  send(translator, QUIET, 4);
  assert.equal(translator.active, standby);
  standby.options.onTranscript('input', ' new');
  old.options.onTranscript('input', ' old');
  context.mock.timers.tick(TRANSCRIPT_HANDOVER_DRAIN_MIN_MS);
  assert.equal(old.closed, false);
  context.mock.timers.tick(TRANSCRIPT_HANDOVER_DRAIN_MAX_MS);
  assert.equal(old.closed, true);
  assert.deepEqual(heard.transcript, ['input: old', 'input: new']);
  translator.close();
});

test('a standby that is not ready by the deadline leaves the normal reconnect', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const { translator, streams, heard, handoverEvents } = transcriptStream(context, 'TRAN04');
  const [old] = streams;
  old.online();
  old.goAway(10_000);
  const standby = streams[1];
  send(translator, SPEECH, 12);
  send(translator, QUIET, 6);
  assert.equal(translator.active, old, 'no cut before the standby is ready');
  context.mock.timers.tick(10_000);
  assert.equal(standby.closed, true);
  assert.equal(translator.handover, null);
  assert.equal(handoverEvents().at(-1).reason, 'standby-not-ready');
  old.lost();
  assert.deepEqual(heard.statuses, ['translator-online', 'translator-reconnecting']);
  translator.close();
});

test('an early Gemini close moves to a ready standby without a reconnect status', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const { translator, streams, heard, handoverEvents } = transcriptStream(context, 'TRAN05');
  const [old] = streams;
  old.online();
  old.goAway(50_000);
  const standby = streams[1];
  standby.online();
  old.interim('cut short');
  old.lost();
  assert.equal(translator.active, standby);
  assert.equal(old.closed, true);
  assert.deepEqual(heard.statuses, ['translator-online']);
  assert.deepEqual(heard.transcript, ['input-interim:cut short', 'input-final:cut short']);
  assert.equal(handoverEvents().at(-1).reason, 'provider-closed');
  translator.sendAudio(SPEECH);
  assert.deepEqual(standby.sent, [SPEECH]);
  translator.close();
});

test('closing mid-drain closes both connections and keeps their final text', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const { translator, streams, heard } = transcriptStream(context, 'TRAN06');
  const [old] = streams;
  old.online();
  old.goAway(50_000);
  const standby = streams[1];
  standby.online();
  send(translator, SPEECH, 12);
  send(translator, QUIET, 4);
  standby.final('Held.');
  translator.close();
  assert.equal(old.closed, true);
  assert.equal(standby.closed, true);
  assert.deepEqual(heard.transcript, ['input-final:Held.']);
  context.mock.timers.tick(60_000);
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

test('real Gemini sockets: fresh standby, split audio, drain, and no reconnect', { timeout: 15_000 }, async (context) => {
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
  const heard = [];
  const statuses = [];
  const manager = new SessionManager('test-key');
  const translator = manager.createTranscriptStream('gemini', {
    targetLanguage: 'en',
    sessionId: 'TRANWS',
    streamKind: 'speaker-transcript',
    wsBase: `ws://127.0.0.1:${server.address().port}`,
    onAudio: () => {},
    onTranscript: (kind, text) => heard.push(`${kind}:${text}`),
    onStatus: (state) => statuses.push(state),
    onError: () => {},
  });
  context.after(async () => {
    translator.close();
    for (const client of server.clients) client.terminate();
    await new Promise((resolve) => server.close(resolve));
  });
  const final = (text) => JSON.stringify({ serverContent: { inputTranscription: { text } } });

  await translator.connect();
  const [old] = connections;
  assert.equal(old.setup.model, 'models/gemini-3.5-transcribe-live');
  old.socket.send(JSON.stringify({ goAway: { timeLeft: '50s' } }));
  await waitFor(() => translator.handover?.readyAt != null);
  const standby = connections[1];
  assert.equal(standby.setup.model, 'models/gemini-3.5-transcribe-live');

  send(translator, SPEECH, 12);
  send(translator, QUIET, 4);
  assert.equal(translator.handover, null, 'cut at the pause');
  translator.sendAudio(SPEECH);
  await waitFor(() => old.audio.length === 17 && standby.audio.length === 1);
  assert.deepEqual(standby.audio, [SPEECH]);
  assert.equal(old.audio.at(-1), QUIET);

  standby.socket.send(final(' After.'));
  old.socket.send(final(' Before.'));
  await waitFor(() => old.closed, 4_000);
  await waitFor(() => heard.length === 2);
  assert.deepEqual(heard, ['input-final: Before.', 'input-final: After.']);

  // Translator's own reconnect would open a third connection after a second.
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  assert.equal(connections.length, 2);
  assert.deepEqual(statuses, ['translator-online']);
});
