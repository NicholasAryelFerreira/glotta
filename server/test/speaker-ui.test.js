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
