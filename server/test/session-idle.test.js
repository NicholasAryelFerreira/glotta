import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeApiTier, SessionManager } from '../src/sessionManager.js';

function fakeSpeakerSocket() {
  return {
    OPEN: 1,
    readyState: 1,
    sent: [],
    closed: false,
    send(payload) { this.sent.push(JSON.parse(payload)); },
    close() {
      this.closed = true;
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


test('sessions use the selected Gemini key and otherwise default to free', () => {
  const manager = new SessionManager({
    free: 'free-test-key',
    paid: 'paid-test-key',
  });
  const defaultSession = manager.create({ id: 'FREE01' });
  const paidSession = manager.create({ id: 'PAID01', apiTier: 'paid' });
  const unexpectedSession = manager.create({ id: 'SAFE01', apiTier: 'PAID' });

  try {
    assert.equal(defaultSession.apiTier, 'free');
    assert.equal(defaultSession.apiKey, 'free-test-key');
    assert.equal(paidSession.apiTier, 'paid');
    assert.equal(paidSession.apiKey, 'paid-test-key');
    assert.equal(unexpectedSession.apiTier, 'free');
    assert.equal(unexpectedSession.apiKey, 'free-test-key');
    assert.equal(normalizeApiTier(undefined), 'free');
  } finally {
    defaultSession.end('test complete');
    paidSession.end('test complete');
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
  assert.match(metrics[0], /"droppedChunks":10/);
  assert.match(metrics[1], /"event":"listener-player"/);
  assert.doesNotMatch(metrics.join('\n'), /data|transcript/i);
  session.end('test complete');
});
