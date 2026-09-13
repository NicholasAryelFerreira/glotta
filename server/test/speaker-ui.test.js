import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const speakHtml = await readFile(new URL('../public/speak.html', import.meta.url), 'utf8');
const inlineScript = speakHtml.match(/<script>([\s\S]*?)<\/script>/)?.[1];


test('loading either session type starts capture after restoring the microphone selection', async () => {
  const loadSession = inlineScript.match(/async function loadSession\(\)[\s\S]*?\n\}/)[0];
  for (const sessionId of ['SERMON', 'ABC123']) {
    const calls = [];
    const context = {
      sessionId, pageActive: true, captureGeneration: 0,
      fetch: async () => ({ ok: true, json: async () => ({}) }),
      document: { getElementById: () => ({}) },
      connectWs: () => calls.push('connect'),
      populateMics: async () => calls.push('microphones'),
      start: async () => calls.push('start'),
    };
    await vm.runInNewContext(`${loadSession}; loadSession();`, context);
    assert.deepEqual(calls, ['connect', 'microphones', 'start']);
    context.pageActive = false;
    calls.length = 0;
    await vm.runInNewContext(`${loadSession}; loadSession();`, context);
    assert.deepEqual(calls, ['connect', 'microphones']);
    context.pageActive = true;
    context.captureGeneration = 1;
    calls.length = 0;
    await vm.runInNewContext(`${loadSession}; loadSession();`, context);
    assert.deepEqual(calls, ['connect', 'microphones'], 'late page load must not override a manual stop');
  }
});


test('speaker page shows only languages with active listeners', () => {
  assert.doesNotMatch(speakHtml, /No listeners yet/);
  assert.doesNotMatch(speakHtml, /id="stats"/);
  assert.match(speakHtml, /if \(n <= 0\) continue;/);
  assert.match(speakHtml, /chip\.textContent = `\$\{l\} · \$\{n\}`/);
});

test('speaker page inline script remains valid JavaScript', () => {
  assert.ok(inlineScript, 'expected an inline speaker script');
  assert.doesNotThrow(() => new vm.Script(inlineScript));
});

test('speaker page reports voiced audio and shows transcript recovery states', () => {
  assert.match(speakHtml, /const AUDIO_STATS_INTERVAL_MS = 60_000;/);
  assert.match(speakHtml, /speechDetected: Boolean\(speechDetected\)/);
  assert.match(speakHtml, /Transcript stalled — reconnecting…/);
  assert.match(speakHtml, /Transcript reconnecting…/);
  assert.match(speakHtml, /msg\.state === 'transcript-online'/);
});

test('speaker page clears a stale connection error after reclaiming the audio input', () => {
  assert.match(
    speakHtml,
    /msg\.type === 'speaker-claim' && msg\.state === 'granted'[\s\S]*?if \(!claimExpected\)[\s\S]*?return;\s*\}\s*errEl\.textContent = '';\s*if \(running\) setStatus\('live'\);/,
  );
});

test('speaker page replaces interim transcription and commits finalized text', () => {
  const boundedText = inlineScript.match(/function boundedText[\s\S]*?\n\}/)?.[0];
  const updateSpeakerTranscript = inlineScript.match(
    /function updateSpeakerTranscript[\s\S]*?\n\}/,
  )?.[0];
  assert.ok(boundedText, 'expected boundedText helper');
  assert.ok(updateSpeakerTranscript, 'expected updateSpeakerTranscript helper');
  assert.match(speakHtml, /typeof msg\.kind === 'string'[\s\S]*?msg\.kind\.startsWith\('input'\)/);

  const transcriptEl = {
    textContent: 'placeholder',
    scrollHeight: 100,
    scrollTop: 0,
    classList: { remove() {} },
  };
  const displayed = vm.runInNewContext(`
    const MAX_LIVE_TRANSCRIPT_CHARS = 24_000;
    let transcriptStarted = false;
    let committedTranscript = '';
    let interimTranscript = '';
    ${boundedText}
    ${updateSpeakerTranscript}
    const snapshots = [];
    updateSpeakerTranscript('input-interim', 'The quick');
    snapshots.push(transcriptEl.textContent);
    updateSpeakerTranscript('input-interim', 'The quick brown fox');
    snapshots.push(transcriptEl.textContent);
    updateSpeakerTranscript('input-final', 'The quick brown fox.');
    snapshots.push(transcriptEl.textContent);
    updateSpeakerTranscript('input-interim', ' Next thought');
    snapshots.push(transcriptEl.textContent);
    snapshots;
  `, { transcriptEl });

  assert.deepEqual(Array.from(displayed), [
    'The quick',
    'The quick brown fox',
    'The quick brown fox.',
    'The quick brown fox. Next thought',
  ]);
});

test('speaker page stops instead of reviving a session after the two-hour limit', () => {
  assert.match(
    speakHtml,
    /event\.reason === 'maximum duration reached'[\s\S]*?stop\(false\)[\s\S]*?sessionEnded\(\)/,
  );
  assert.match(speakHtml, /This session reached the 2-hour limit/);
});

function captureHarness(t) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100_000 });
  const classList = { add() {}, remove() {} };
  let lastNode, starts = 0, stops = 0, resumed = 0;
  const track = { readyState: 'live', stop() { stops++; } };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  const sandbox = {
    Date, setTimeout, clearTimeout, pageActive: true, speakerClaimed: true,
    claimResolver: null, audioCtx: null, mediaStream: null, workletNode: null,
    toggleBtn: { classList }, toggleLabel: {}, errEl: {}, micSel: { value: 'default' },
    document: { visibilityState: 'visible' }, publicConfigReady: Promise.resolve(),
    setStatus() {}, selectedIsClean: () => false, populateMics() {},
    requestSpeakerClaim: async () => true, releaseSpeakerClaim() {},
    maybeReportAudioStats() {}, setAudioMeterVisible() {}, workletCode: '',
    updateAudioMeter: () => false, sendSpeakerAudio() {},
    Blob, URL: { createObjectURL: () => 'blob:test', revokeObjectURL() {} },
    navigator: { mediaDevices: { getUserMedia: async () => { starts++; return stream; } } },
    AudioContext: class {
      state = 'running';
      audioWorklet = { addModule: async () => {} };
      resume() { resumed++; this.state = 'running'; return Promise.resolve(); }
      close() { this.state = 'closed'; return Promise.resolve(); }
      createMediaStreamSource() { return { connect() {} }; }
    },
    AudioWorkletNode: class { port = {}; constructor() { lastNode = this; } disconnect() {} },
  };
  const ctx = vm.createContext(sandbox);
  const code = inlineScript.slice(inlineScript.indexOf('let running = false'), inlineScript.indexOf('setInterval(recoverInterruptedCapture'));
  vm.runInContext(code, ctx);
  return { ctx, sandbox, stream, track, run: code => vm.runInContext(code, ctx),
    frame: () => lastNode.port.onmessage({ data: [] }),
    counts: () => ({ starts, stops, resumed }) };
}

async function flushCapturePromises() { for (let i = 0; i < 25; i++) await Promise.resolve(); }

test('silent audio stays healthy; missing chunks recover with a bounded retry budget', async t => {
  const h = captureHarness(t);
  await h.run('start()');
  for (let i = 0; i < 120; i++) {
    t.mock.timers.tick(10_000);
    h.frame();
    await h.run('recoverInterruptedCapture()');
  }
  assert.equal(h.counts().starts, 1, 'twenty quiet minutes do not restart capture');
  for (let i = 0; i < 4; i++) {
    t.mock.timers.tick(10_000);
    await h.run('recoverInterruptedCapture()');
  }
  assert.equal(h.counts().starts, 4, 'only three automatic rebuilds');
  assert.equal(h.run('captureNeedsTap'), true);
  h.run('stop()');
  t.mock.timers.tick(30_000);
  await h.run('recoverInterruptedCapture()');
  assert.equal(h.counts().starts, 4);
  assert.equal(h.run('speakingIntended'), false);
});

test('suspended capture resumes without rebuilding; hidden and intentionally stopped pages do not recover', async t => {
  const h = captureHarness(t);
  await h.run('start()');
  h.run("audioCtx.state = 'suspended'");
  h.sandbox.document.visibilityState = 'hidden';
  await h.run('recoverInterruptedCapture()');
  assert.equal(h.counts().resumed, 1);
  h.sandbox.document.visibilityState = 'visible';
  await h.run('recoverInterruptedCapture()');
  assert.equal(h.counts().resumed, 2);
  assert.equal(h.counts().starts, 1);
  h.run('stop()');
  await h.run('recoverInterruptedCapture()');
  assert.equal(h.counts().starts, 1);
});

test('Stop during microphone permission cancels late capture', async t => {
  const h = captureHarness(t);
  let grant;
  h.sandbox.navigator.mediaDevices.getUserMedia = () => new Promise(resolve => { grant = resolve; });
  const pending = h.run('start()');
  await flushCapturePromises();
  h.run('stop()');
  grant(h.stream);
  await pending;
  assert.equal(h.run('running || speakingIntended'), false);
  assert.ok(h.counts().stops > 0);
});

test('startup waits for slow audio resume instead of immediately requesting a tap', async t => {
  const h = captureHarness(t);
  let resume;
  h.sandbox.AudioContext.prototype.resume = function() {
    this.state = 'suspended';
    return new Promise(resolve => { resume = () => { this.state = 'running'; resolve(); }; });
  };
  const pending = h.run('start()');
  await flushCapturePromises();
  assert.equal(h.run('startPending'), true);
  t.mock.timers.tick(1_000);
  resume();
  await pending;
  assert.equal(h.run('running'), true);
  assert.equal(h.run('captureNeedsTap'), false);
  h.run('stop()');
});

test('failed recovery keeps speaking intent and can retry a temporary device error', async t => {
  const h = captureHarness(t);
  await h.run('start()');
  let calls = 0;
  h.sandbox.navigator.mediaDevices.getUserMedia = async () => {
    if (++calls === 1) throw new Error('temporary device error');
    return h.stream;
  };
  t.mock.timers.tick(10_000);
  await h.run('recoverInterruptedCapture()');
  assert.equal(h.run('speakingIntended'), true);
  assert.equal(h.run('running'), false);
  t.mock.timers.tick(5_000);
  await h.run('recoverInterruptedCapture()');
  assert.equal(h.run('running'), true);
  h.run('stop()');
});


test('blocked audio resume requests one tap and does not loop automatic restarts', async t => {
  const h = captureHarness(t);
  h.sandbox.AudioContext.prototype.resume = function() {
    this.state = 'suspended';
    return new Promise(() => {});
  };
  const pending = h.run('start()');
  await flushCapturePromises();
  t.mock.timers.tick(3_000);
  await pending;
  assert.equal(h.run('speakingIntended'), true);
  assert.equal(h.run('captureNeedsTap'), true);
  assert.equal(h.run('startPending || running'), false);
  assert.ok(h.counts().stops > 0);
  t.mock.timers.tick(60_000);
  await h.run('recoverInterruptedCapture()');
  assert.equal(h.counts().starts, 1);
});

test('Stop during a pending resume cannot restore capture or clear the stop state', async t => {
  const h = captureHarness(t);
  await h.run('start()');
  let resolveResume;
  h.sandbox.audioCtx.state = 'suspended';
  h.sandbox.audioCtx.resume = () => new Promise(resolve => { resolveResume = resolve; });
  const pending = h.run('recoverInterruptedCapture()');
  h.run('stop()');
  resolveResume();
  await pending;
  assert.equal(h.run('running || speakingIntended || startPending'), false);
  assert.equal(h.sandbox.toggleLabel.textContent, 'Start speaking');
  assert.equal(h.counts().starts, 1);
});
