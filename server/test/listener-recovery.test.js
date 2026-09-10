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

test('listener loads only the selected provider target languages', () => {
  assert.match(joinHtml, /api\/languages\?provider=/);
  assert.match(joinHtml, /sess\.provider \|\| 'gemini'/);
});

test('listener can choose a language while waiting for any valid session', () => {
  const checkSession = joinHtml.match(/async function checkSession\(\) \{([\s\S]*?)\n\}/)?.[1];
  assert.ok(checkSession, 'expected checkSession');
  assert.match(checkSession, /await loadLanguages\('gemini'\);\s*langSel\.disabled = false;/);
  assert.match(
    checkSession,
    /sessionReady = Boolean\(sess\.speakerOnline\);\s*langSel\.disabled = false;/,
  );
  assert.match(
    checkSession,
    /if \(!sessionReady\) \{[\s\S]*?showWaitingForStart\(\);[\s\S]*?toggleBtn\.disabled = true;/,
  );
  assert.match(joinHtml, /langSel\.onchange = \(\) => \{ toggleBtn\.disabled = !langSel\.value \|\| !sessionReady; \};/);
  assert.doesNotMatch(checkSession, /isWeeklySession|SERMON/);
});

test('listener keeps service wording for SERMON and uses session wording for other codes', () => {
  assert.match(joinHtml, /isWeeklySession = sessionId\.toUpperCase\(\) === 'SERMON';/);
  assert.match(joinHtml, /isWeeklySession = config\.weeklySessionId === sessionId\.toUpperCase\(\);/);
  assert.match(joinHtml, /isWeeklySession \? 'Waiting for the service to start' : 'Waiting for the session to start'/);
  assert.match(joinHtml, /The service hasn't started yet\./);
  assert.match(joinHtml, /This session hasn't started yet\./);
});

test('listener starts with the language placeholder and preserves only a choice made on this page', () => {
  assert.match(joinHtml, /const selected = langSel\.value;/);
  assert.match(joinHtml, /if \(selected && \[\.\.\.langSel\.options\][\s\S]*?langSel\.value = selected;/);
  assert.doesNotMatch(joinHtml, /glotta\.lang|localStorage\.(?:getItem|setItem)\(LANG_KEY/);
});

test('listener UI hides provider details and gives three discreet listening options', () => {
  assert.doesNotMatch(joinHtml, /Google Gemini|OpenAI GPT/);
  assert.match(joinHtml, /Hold your phone to your ear, use headphones, or read the captions silently\./);
  assert.match(joinHtml, /sessionInfo'\)\.textContent = `Session \$\{sess\.sessionId\}`/);
});

test('audio recovery is bounded and replaces a stale listener socket', () => {
  assert.match(joinHtml, /const AUDIO_SETUP_TIMEOUT_MS = 5_000;/);
  assert.match(joinHtml, /async function resumeListening\(\)[\s\S]*?replaceListenerSocket\(\);/);
  assert.match(joinHtml, /window\.addEventListener\('online',[\s\S]*?replaceListenerSocket\(\);/);
  assert.match(joinHtml, /finally \{\s*audioSetupPending = false;\s*toggleBtn\.disabled = !sessionReady;/);
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

test('listener distinguishes a paused speaker from reconnecting and translation recovery', () => {
  assert.match(joinHtml, /msg\.state === 'speaker-paused'[\s\S]*?Speaker paused/);
  assert.match(joinHtml, /msg\.state === 'speaker-offline'[\s\S]*?Speaker reconnecting\.\.\./);
  assert.match(joinHtml, /msg\.state === 'translation-stalled'[\s\S]*?Translation stalled — reconnecting\.\.\./);
});

test('ended sessions keep the listen button disabled', () => {
  assert.match(
    joinHtml,
    /msg\.state === 'ended'\) \{\s*sessionReady = false;[\s\S]*?stop\(false\);/,
  );
  const stop = joinHtml.match(/function stop\(closeWs = true\) \{([\s\S]*?)\n\}/)?.[1];
  assert.ok(stop, 'expected stop');
  assert.match(stop, /statusEl\.querySelector\('\.off'\)[\s\S]*?toggleBtn\.disabled = true;/);
});
