import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const speakHtml = await readFile(new URL('../public/speak.html', import.meta.url), 'utf8');
const inlineScript = speakHtml.match(/<script>([\s\S]*?)<\/script>/)?.[1];

test('speaker page omits the redundant listener-total message', () => {
  assert.doesNotMatch(speakHtml, /No listeners yet/);
  assert.doesNotMatch(speakHtml, /id="stats"/);
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

test('speaker page stops instead of reviving a session after the two-hour limit', () => {
  assert.match(
    speakHtml,
    /event\.reason === 'maximum duration reached'[\s\S]*?stop\(false\)[\s\S]*?sessionEnded\(\)/,
  );
  assert.match(speakHtml, /This session reached the 2-hour limit/);
});
