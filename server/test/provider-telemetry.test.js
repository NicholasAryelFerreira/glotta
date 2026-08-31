import assert from 'node:assert/strict';
import test from 'node:test';
import { OpenAITranslator } from '../src/openaiTranslator.js';
import { Translator } from '../src/translator.js';

function readySocket() {
  return {
    readyState: 1,
    bufferedAmount: 0,
    send() {},
    close() {},
  };
}

test('both providers summarize input audio usage without logging audio content', (context) => {
  const lines = [];
  context.mock.method(console, 'log', (...args) => { lines.push(args.join(' ')); });
  const audio = Buffer.alloc(16_000 * 2 / 10, 7).toString('base64');
  const gemini = new Translator({
    apiKey: 'test-key',
    targetLanguage: 'pt-BR',
    sessionId: 'USEGEM',
    streamKind: 'speaker-transcript',
  });
  const openai = new OpenAITranslator({
    apiKey: 'test-key',
    targetLanguage: 'pt',
    sessionId: 'USEOAI',
    streamKind: 'speaker-transcript',
  });
  for (const provider of [gemini, openai]) {
    provider.ws = readySocket();
    provider.ready = true;
    provider.sendAudio(audio);
    provider.close();
  }

  const usage = lines.filter((line) => line.includes('"event":"provider-audio-usage"'));
  assert.equal(usage.length, 2);
  assert.match(usage[0], /"provider":"gemini"/);
  assert.match(usage[1], /"provider":"openai"/);
  assert.match(usage.join('\n'), /"inputAudioMs":100/);
  assert.doesNotMatch(usage.join('\n'), new RegExp(audio.slice(0, 24)));
});
