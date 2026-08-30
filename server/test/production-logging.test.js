import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const translator = await readFile(new URL('../src/translator.js', import.meta.url), 'utf8');
const serverIndex = await readFile(new URL('../src/index.js', import.meta.url), 'utf8');

test('Gemini lifecycle logs keep structured outcomes without duplicate routine lines', () => {
  assert.match(translator, /event: 'gemini-goaway'/);
  assert.match(translator, /event: 'gemini-unexpected-close'/);
  assert.match(translator, /event: 'gemini-setup'/);
  assert.doesNotMatch(translator, /setup complete/);
  assert.doesNotMatch(translator, /reconnecting in/);
});

test('listener departures include connection evidence for future network diagnosis', () => {
  assert.match(serverIndex, /listener left/);
  assert.match(serverIndex, /code: \$\{code\}/);
  assert.match(serverIndex, /connectedMs: \$\{Date\.now\(\) - connectedAt\}/);
  assert.match(serverIndex, /active: \$\{channel\.listeners\.size\}/);
  assert.match(serverIndex, /active speaker disconnected/);
  assert.match(serverIndex, /graceSeconds: \$\{SPEAKER_GRACE_MS \/ 1000\}/);
});
