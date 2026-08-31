import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const translator = await readFile(new URL('../src/translator.js', import.meta.url), 'utf8');
const openaiTranslator = await readFile(new URL('../src/openaiTranslator.js', import.meta.url), 'utf8');
const serverIndex = await readFile(new URL('../src/index.js', import.meta.url), 'utf8');

test('Gemini lifecycle logs keep structured outcomes without duplicate routine lines', () => {
  assert.match(translator, /event: 'gemini-goaway'/);
  assert.match(translator, /event: 'gemini-unexpected-close'/);
  assert.match(translator, /event: 'gemini-setup'/);
  assert.match(translator, /event: 'first-source-transcript'/);
  assert.match(translator, /event: 'provider-audio-usage'/);
  assert.match(translator, /event: 'provider-stream-unavailable'/);
  assert.match(translator, /event: 'provider-stream-recovered'/);
  assert.doesNotMatch(translator, /setup complete/);
  assert.doesNotMatch(translator, /reconnecting in/);
});

test('OpenAI lifecycle logs expose setup, first output, closure, and queue health', () => {
  assert.match(openaiTranslator, /event: 'openai-setup'/);
  assert.match(openaiTranslator, /event: 'openai-first-output'/);
  assert.match(openaiTranslator, /event: 'openai-unexpected-close'/);
  assert.match(openaiTranslator, /event: 'first-source-transcript'/);
  assert.match(openaiTranslator, /event: 'provider-audio-usage'/);
  assert.match(openaiTranslator, /event: 'provider-stream-unavailable'/);
  assert.match(openaiTranslator, /event: 'provider-stream-recovered'/);
  assert.match(openaiTranslator, /type: 'session\.close'/);
  assert.match(openaiTranslator, /event\.type === 'session\.closed'/);
  assert.match(openaiTranslator, /stage: 'openai-websocket'|openai-websocket/);
  assert.doesNotMatch(openaiTranslator, /console\.log\([^\n]*event\.delta/);
});

test('listener departures include connection evidence for future network diagnosis', () => {
  assert.match(serverIndex, /listener left/);
  assert.match(serverIndex, /code: \$\{code\}/);
  assert.match(serverIndex, /connectedMs: \$\{Date\.now\(\) - connectedAt\}/);
  assert.match(serverIndex, /active: \$\{channel\.listeners\.size\}/);
  assert.match(serverIndex, /active speaker disconnected/);
  assert.match(serverIndex, /graceSeconds: \$\{SPEAKER_GRACE_MS \/ 1000\}/);
});
