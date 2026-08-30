import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const homeHtml = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const inlineScript = homeHtml.match(/<script>([\s\S]*?)<\/script>/)?.[1];

test('home page replaces Free/Paid with a Gemini-default provider selector', () => {
  assert.match(homeHtml, /name="provider"[^>]+value="gemini" checked/);
  assert.match(homeHtml, /name="provider"[^>]+value="openai"/);
  assert.match(homeHtml, /Google Gemini/);
  assert.match(homeHtml, /OpenAI GPT/);
  assert.doesNotMatch(homeHtml, /name="apiTier"|>Free<|>Paid</);
  assert.match(homeHtml, /body: JSON\.stringify\(\{ password, sessionId, provider \}\)/);
});

test('home page inline script remains valid JavaScript', () => {
  assert.ok(inlineScript, 'expected an inline home-page script');
  assert.doesNotThrow(() => new vm.Script(inlineScript));
});
