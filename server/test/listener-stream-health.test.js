import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const sessionManager = await readFile(new URL('../src/sessionManager.js', import.meta.url), 'utf8');
const serverIndex = await readFile(new URL('../src/index.js', import.meta.url), 'utf8');

test('listener streams recover at the live edge after voiced audio produces no output', () => {
  assert.match(sessionManager, /this\.outputWatchdog = new TranscriptWatchdog\(\)/);
  assert.match(sessionManager, /speechDetected: speechDetected === true,[\s\S]*?streamReady: this\.translator\.ready === true/);
  assert.match(sessionManager, /event: 'translation-stall'/);
  assert.match(sessionManager, /state: 'translation-stalled'/);
  assert.match(sessionManager, /this\.translator\.close\(\);[\s\S]*?this\.translator = this\.#createTranslator\(\)/);
});

test('listener stream metrics identify continuing output health without transcript content', () => {
  assert.match(sessionManager, /event: 'listener-output-health'/);
  assert.match(sessionManager, /outputAudioChunks: this\.outputHealth\.audioChunks/);
  assert.match(sessionManager, /outputTranscriptEvents: this\.outputHealth\.transcriptEvents/);
  assert.doesNotMatch(sessionManager, /listener-output-health[\s\S]{0,500}\btext\b/);
});

test('intentional stop sends speaker-paused while disconnect still sends speaker-offline', () => {
  const stopBranch = serverIndex.match(/msg\.type === 'stop-speaking'[\s\S]*?\} else if \(msg\.type === 'audio'/)?.[0];
  const closeBranch = serverIndex.match(/ws\.on\('close',[\s\S]*?\n  \}\);/)?.[0];
  assert.ok(stopBranch, 'expected stop-speaking branch');
  assert.ok(closeBranch, 'expected speaker close branch');
  assert.match(stopBranch, /state: 'speaker-paused'/);
  assert.doesNotMatch(stopBranch, /state: 'speaker-offline'/);
  assert.match(closeBranch, /state: 'speaker-offline'/);
  assert.match(
    serverIndex,
    /if \(!session\.speakerWs\)[\s\S]*?session\.speakerGraceTimer \? 'speaker-offline' : 'speaker-paused'/,
  );
});
