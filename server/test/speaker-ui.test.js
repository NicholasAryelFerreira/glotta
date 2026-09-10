import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const speakHtml = await readFile(new URL('../public/speak.html', import.meta.url), 'utf8');
const inlineScript = speakHtml.match(/<script>([\s\S]*?)<\/script>/)?.[1];

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
