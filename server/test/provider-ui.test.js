import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const homeHtml = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const inlineScript = homeHtml.match(/<script>([\s\S]*?)<\/script>/)?.[1];

test('home page shows provider selection followed by a free-default tier selector', () => {
  assert.match(homeHtml, /name="provider"[^>]+value="gemini" checked/);
  assert.match(homeHtml, /name="provider"[^>]+value="openai"/);
  assert.match(homeHtml, /Google Gemini/);
  assert.match(homeHtml, /OpenAI GPT/);
  assert.match(homeHtml, /name="apiTier"[^>]+value="free" checked/);
  assert.match(homeHtml, /name="apiTier"[^>]+value="paid"/);
  assert.ok(homeHtml.indexOf('name="provider"') < homeHtml.indexOf('name="apiTier"'));
  assert.match(homeHtml, /tier-picker provider-picker/);
  assert.match(homeHtml, /provider === 'openai'/);
  assert.match(homeHtml, /availableTiers\[input\.value\] === false/);
  assert.match(homeHtml, /body: JSON\.stringify\(\{ password, sessionId, provider, apiTier \}\)/);
});

test('home page inline script remains valid JavaScript', () => {
  assert.ok(inlineScript, 'expected an inline home-page script');
  assert.doesNotThrow(() => new vm.Script(inlineScript));
});
