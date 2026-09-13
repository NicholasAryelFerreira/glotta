import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const speakHtml = await readFile(new URL('../public/speak.html', import.meta.url), 'utf8');
const inlineScript = speakHtml.match(/<script>([\s\S]*?)<\/script>/)?.[1];

test('returning to the speaker page resumes suspended capture but respects Stop and hidden pages', async () => {
  const recover = inlineScript.match(/function recoverInterruptedCapture\(\)[\s\S]*?\n\}/)[0];
  let resumed = 0;
  let restarted = 0;
  const audioCtx = { state: 'suspended', resume: async () => { resumed++; audioCtx.state = 'running'; } };
  const context = {
    running: true, startPending: false, pageActive: true, speakerClaimed: true,
    document: { visibilityState: 'visible' }, audioCtx,
    mediaStream: { getAudioTracks: () => [{ readyState: 'live' }] },
    errEl: {}, setStatus() {}, stop() {}, start() { restarted++; },
  };
  vm.runInNewContext(`${recover}; recoverInterruptedCapture();`, context);
  await Promise.resolve();
  assert.equal(resumed, 1);
  assert.equal(restarted, 0);
  context.running = false;
  audioCtx.state = 'suspended';
  vm.runInNewContext(`${recover}; recoverInterruptedCapture();`, context);
  assert.equal(resumed, 1);
  context.running = true;
  context.document.visibilityState = 'hidden';
  vm.runInNewContext(`${recover}; recoverInterruptedCapture();`, context);
  assert.equal(resumed, 1);
  context.document.visibilityState = 'visible';
  context.mediaStream = { getAudioTracks: () => [{ readyState: 'ended' }] };
  vm.runInNewContext(`${recover}; recoverInterruptedCapture();`, context);
  assert.equal(restarted, 1);
  context.pageActive = false;
  vm.runInNewContext(`${recover}; recoverInterruptedCapture();`, context);
  assert.equal(restarted, 1);
});

test('loading either session type starts capture after restoring the microphone selection', async () => {
  const loadSession = inlineScript.match(/async function loadSession\(\)[\s\S]*?\n\}/)[0];
  for (const sessionId of ['SERMON', 'ABC123']) {
    const calls = [];
    const context = {
      sessionId, pageActive: true,
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
  }
});

test('automatic capture cleans up and allows retry when the browser suspends audio', async () => {
  const start = inlineScript.match(/async function start\(\)[\s\S]*?\n\}/)[0];
  let released = false;
  let trackStopped = false;
  const result = await vm.runInNewContext(`
    let running = false, startPending = false, pageActive = true;
    let mediaStream, audioCtx;
    const toggleBtn = { disabled: false }, errEl = {};
    const micSel = { value: 'default' };
    const publicConfigReady = Promise.resolve();
    function stop() {
      mediaStream.getTracks().forEach(t => t.stop());
      audioCtx.close();
      startPending = false;
      toggleBtn.disabled = false;
      release();
    }
    ${start}
    start().then(() => ({ startPending, disabled: toggleBtn.disabled, error: errEl.textContent }));
  `, {
    setStatus() {}, requestSpeakerClaim: async () => true, selectedIsClean: () => false,
    populateMics() {}, workletCode: '', Blob,
    URL: { createObjectURL: () => 'blob:test', revokeObjectURL() {} },
    navigator: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() { trackStopped = true; } }] }) } },
    AudioContext: class {
      state = 'suspended';
      audioWorklet = { addModule: async () => {} };
      resume() { return new Promise(() => {}); }
      close() {}
    },
    release() { released = true; },
  });
  assert.equal(result.startPending, false);
  assert.equal(result.disabled, false);
  assert.match(result.error, /Click Start speaking/);
  assert.ok(released && trackStopped);
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
