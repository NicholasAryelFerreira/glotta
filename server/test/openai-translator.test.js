import assert from 'node:assert/strict';
import test from 'node:test';
import {
  OPENAI_GRACEFUL_CLOSE_TIMEOUT_MS,
  OpenAITranslator,
  openAISessionUpdate,
  openAIWebSocketUrl,
  resamplePcm16Base64,
} from '../src/openaiTranslator.js';

test('OpenAI translation session selects the target language', () => {
  assert.deepEqual(openAISessionUpdate('pt'), {
    type: 'session.update',
    session: {
      audio: {
        output: { language: 'pt' },
      },
    },
  });
});

test('OpenAI speaker transcript session uses gpt-live-transcribe with live English deltas', () => {
  assert.equal(
    openAIWebSocketUrl('transcription'),
    'wss://api.openai.com/v1/realtime?intent=transcription',
  );
  assert.deepEqual(openAISessionUpdate('en', 'transcription'), {
    type: 'session.update',
    session: {
      type: 'transcription',
      audio: {
        input: {
          format: { type: 'audio/pcm', rate: 24_000 },
          transcription: {
            model: 'gpt-live-transcribe',
            languages: ['en'],
            delay: 'low',
          },
        },
      },
    },
  });
});

test('OpenAI audio is resampled from 16 kHz PCM16 to 24 kHz PCM16', () => {
  const input = Buffer.alloc(4);
  input.writeInt16LE(0, 0);
  input.writeInt16LE(10_000, 2);

  const output = Buffer.from(resamplePcm16Base64(input.toString('base64')), 'base64');
  assert.equal(output.length, 6);
  assert.equal(output.readInt16LE(0), 0);
  assert.equal(output.readInt16LE(2), 6_667);
  assert.equal(output.readInt16LE(4), 10_000);
});

test('OpenAI graceful close requests a final drain and remains bounded', async () => {
  const sent = [];
  let socketClosed = false;
  const translator = new OpenAITranslator({
    apiKey: 'test-key',
    targetLanguage: 'pt',
  });
  translator.ws = {
    readyState: 1,
    send(payload) { sent.push(JSON.parse(payload)); },
    close() { socketClosed = true; },
  };
  translator.ready = true;

  const closing = translator.close({ graceful: true, timeoutMs: 5 });
  assert.deepEqual(sent, [{ type: 'session.close' }]);
  await closing;
  assert.equal(socketClosed, true);
  assert.equal(OPENAI_GRACEFUL_CLOSE_TIMEOUT_MS, 2_000);
});
