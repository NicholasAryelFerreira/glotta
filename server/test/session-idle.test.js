import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeProvider,
  SESSION_MAX_DURATION_MINUTES,
  SessionManager,
} from '../src/sessionManager.js';

function fakeSpeakerSocket() {
  return {
    OPEN: 1,
    readyState: 1,
    sent: [],
    closed: false,
    send(payload) { this.sent.push(JSON.parse(payload)); },
    close(code, reason) {
      this.closed = true;
      this.closeCode = code;
      this.closeReason = reason;
      this.readyState = 3;
    },
  };
}

test('session closes only after 60 minutes without speaker audio', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const manager = new SessionManager('test-key');
  const session = manager.create({ id: 'IDLE60', title: 'Idle timer test' });

  context.mock.timers.tick(59 * 60_000);
  assert.equal(manager.get(session.id), session);

  context.mock.timers.tick(60_000);
  assert.equal(manager.get(session.id), undefined);
});

test('session closes after the two-hour maximum even when audio activity stays recent', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const manager = new SessionManager('test-key');
  const session = manager.create({ id: 'MAX120', title: 'Maximum duration test' });
  const speaker = fakeSpeakerSocket();
  session.addSpeakerSocket(speaker);

  context.mock.timers.tick(59 * 60_000);
  session.lastAudioAt = Date.now();
  context.mock.timers.tick(59 * 60_000);
  session.lastAudioAt = Date.now();
  assert.equal(manager.get(session.id), session);

  context.mock.timers.tick(2 * 60_000);
  assert.equal(SESSION_MAX_DURATION_MINUTES, 120);
  assert.equal(manager.get(session.id), undefined);
  assert.equal(speaker.closeCode, 1000);
  assert.equal(speaker.closeReason, 'maximum duration reached');
});

test('only one device can claim a session audio input at a time', () => {
  const manager = new SessionManager('test-key');
  const session = manager.create({ id: 'LOCK01', title: 'Speaker lock test' });
  const firstDevice = fakeSpeakerSocket();
  const secondDevice = fakeSpeakerSocket();

  session.addSpeakerSocket(firstDevice);
  session.addSpeakerSocket(secondDevice);

  // Merely opening either speaker page does not reserve the audio input.
  assert.equal(session.speakerWs, null);

  assert.equal(session.claimSpeaker(firstDevice), true);
  assert.equal(session.speakerWs, firstDevice);
  assert.equal(session.claimSpeaker(secondDevice), false);
  assert.equal(session.speakerWs, firstDevice);

  assert.equal(session.releaseSpeaker(secondDevice), false);
  assert.equal(session.releaseSpeaker(firstDevice), true);
  assert.equal(session.claimSpeaker(secondDevice), true);
  assert.equal(session.speakerWs, secondDevice);

  session.end('test complete');
  assert.equal(firstDevice.closed, true);
  assert.equal(secondDevice.closed, true);
});


test('sessions default to paid Gemini and preserve an explicit OpenAI provider', () => {
  const manager = new SessionManager({
    gemini: 'paid-gemini-test-key',
    openai: 'openai-test-key',
  });
  const defaultSession = manager.create({ id: 'GEMINI' });
  const openaiSession = manager.create({ id: 'OPENAI', provider: 'openai' });
  const unexpectedSession = manager.create({ id: 'SAFE01', provider: 'OPENAI' });

  try {
    assert.equal(defaultSession.provider, 'gemini');
    assert.equal(openaiSession.provider, 'openai');
    assert.equal(unexpectedSession.provider, 'gemini');
    assert.equal(manager.apiKeyForProvider('gemini'), 'paid-gemini-test-key');
    assert.equal(manager.apiKeyForProvider('openai'), 'openai-test-key');
    assert.equal(normalizeProvider(undefined), 'gemini');
  } finally {
    defaultSession.end('test complete');
    openaiSession.end('test complete');
    unexpectedSession.end('test complete');
  }
});

test('sessions echo same-language output by default and allow an explicit opt-out', () => {
  const manager = new SessionManager('test-key');
  const defaultSession = manager.create({ id: 'ECHO01' });
  const silentSession = manager.create({ id: 'ECHO02', echoTargetLanguage: false });

  try {
    assert.equal(defaultSession.echoTargetLanguage, true);
    assert.equal(silentSession.echoTargetLanguage, false);
  } finally {
    defaultSession.end('test complete');
    silentSession.end('test complete');
  }
});

test('empty lingering language channels stop receiving provider audio without stopping speaker transcription', () => {
  const manager = new SessionManager('test-key');
  const session = manager.create({ id: 'LINGER' });
  let speakerAudioChunks = 0;
  let languageAudioChunks = 0;
  let languageHealthChecks = 0;

  session.speakerTranscriptTranslator = {
    ready: true,
    sendAudio() { speakerAudioChunks += 1; },
    close() {},
  };
  const channel = {
    listeners: new Set(),
    translator: { sendAudio() { languageAudioChunks += 1; } },
    recordSpeakerAudio() { languageHealthChecks += 1; },
    close() {},
  };
  session.channels.set('es', channel);

  session.pushAudio('first-chunk', { speechDetected: false });
  assert.equal(speakerAudioChunks, 1);
  assert.equal(languageAudioChunks, 0);
  assert.equal(languageHealthChecks, 0);

  channel.listeners.add(fakeSpeakerSocket());
  session.pushAudio('second-chunk', { speechDetected: false });
  assert.equal(speakerAudioChunks, 2);
  assert.equal(languageAudioChunks, 1);
  assert.equal(languageHealthChecks, 1);

  session.end('test complete');
});

test('audio telemetry logs counts without audio or transcript content', (context) => {
  const lines = [];
  context.mock.method(console, 'log', (...args) => { lines.push(args.join(' ')); });
  const manager = new SessionManager('test-key');
  const session = manager.create({ id: 'METRIC' });

  session.recordSpeakerClientMetrics({
    intervalMs: 10_000,
    capturedChunks: 100,
    sentChunks: 90,
    droppedChunks: 10,
    peakBufferedBytes: 45_000,
    currentBufferedBytes: 1_000,
  });
  session.recordListenerPlayerMetrics('pt-BR', {
    queuedMs: 1_900,
    droppedMs: 800,
    maxBufferSeconds: 2,
  });

  const metrics = lines.filter((line) => line.startsWith('[audio-metrics]'));
  assert.equal(metrics.length, 2);
  assert.match(metrics[0], /"event":"speaker-client"/);
  assert.match(metrics[0], /"provider":"gemini"/);
  assert.match(metrics[0], /"droppedChunks":10/);
  assert.match(metrics[1], /"event":"listener-player"/);
  assert.doesNotMatch(metrics.join('\n'), /data|transcript/i);
  session.end('test complete');
});

test('speaker client health reports aggregate older ten-second clients into one-minute logs', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1 });
  const lines = [];
  context.mock.method(console, 'log', (...args) => { lines.push(args.join(' ')); });
  const manager = new SessionManager('test-key');
  const session = manager.create({ id: 'AGGREG' });
  lines.length = 0;

  const report = () => session.recordSpeakerClientMetrics({
    intervalMs: 10_000,
    capturedChunks: 100,
    sentChunks: 99,
    droppedChunks: 1,
    peakBufferedBytes: 5_000,
    currentBufferedBytes: 1_000,
  });

  report();
  for (let interval = 0; interval < 5; interval += 1) {
    context.mock.timers.tick(10_000);
    report();
  }
  assert.equal(lines.filter((line) => line.includes('"event":"speaker-client"')).length, 1);

  context.mock.timers.tick(10_000);
  report();
  const metrics = lines.filter((line) => line.includes('"event":"speaker-client"'));
  assert.equal(metrics.length, 2);
  assert.match(metrics[1], /"intervalMs":60000/);
  assert.match(metrics[1], /"capturedChunks":600/);
  assert.match(metrics[1], /"sentChunks":594/);
  assert.match(metrics[1], /"droppedChunks":6/);
  session.end('test complete');
});
