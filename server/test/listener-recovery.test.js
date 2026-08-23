import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const joinHtml = await readFile(new URL('../public/join.html', import.meta.url), 'utf8');
const inlineScript = joinHtml.match(/<script>([\s\S]*?)<\/script>/)?.[1];

test('listener page inline script remains valid JavaScript', () => {
  assert.ok(inlineScript, 'expected an inline listener script');
  assert.doesNotThrow(() => new vm.Script(inlineScript));
});

test('audio recovery is bounded and replaces a stale listener socket', () => {
  assert.match(joinHtml, /const AUDIO_SETUP_TIMEOUT_MS = 5_000;/);
  assert.match(joinHtml, /async function resumeListening\(\)[\s\S]*?replaceListenerSocket\(\);/);
  assert.match(joinHtml, /window\.addEventListener\('online',[\s\S]*?replaceListenerSocket\(\);/);
  assert.match(joinHtml, /finally \{\s*audioSetupPending = false;\s*toggleBtn\.disabled = false;/);
});

test('audio context is created before setup awaits to preserve mobile user activation', () => {
  const createPlayer = joinHtml.match(/async function createAudioPlayer\(\) \{([\s\S]*?)\n\}/)?.[1];
  assert.ok(createPlayer, 'expected createAudioPlayer');
  assert.ok(
    createPlayer.indexOf('new AudioContext') < createPlayer.indexOf('await withTimeout('),
    'AudioContext must be created before the first await',
  );
});

test('resume reuses an existing iPhone audio player before rebuilding it', () => {
  const resume = joinHtml.match(/async function resumeListening\(\) \{([\s\S]*?)\n\}/)?.[1];
  assert.ok(resume, 'expected resumeListening');
  assert.match(resume, /replaceListenerSocket\(\);\s*try \{\s*await resumeAudioPlayer\(\);/);
  assert.doesNotMatch(resume, /try \{\s*await destroyAudioPlayer\(\);/);

  const requireTap = joinHtml.match(/function requireResumeTap\(\) \{([\s\S]*?)\n\}/)?.[1];
  assert.ok(requireTap, 'expected requireResumeTap');
  assert.doesNotMatch(requireTap, /destroyAudioPlayer\(\)/);

  const resumePlayer = joinHtml.match(/async function resumeAudioPlayer\(\) \{([\s\S]*?)\n\}/)?.[1];
  assert.ok(resumePlayer, 'expected resumeAudioPlayer');
  assert.match(resumePlayer, /const resumePromise = ctx\.resume\(\);\s*primeAudioOutput\(ctx\);/);
  assert.match(resumePlayer, /await withTimeout\(resumePromise/);
  assert.match(resumePlayer, /if \(!ctx \|\| !playerNode[\s\S]*?await createAudioPlayer\(\);/);
});
