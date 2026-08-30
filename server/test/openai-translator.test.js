import assert from 'node:assert/strict';
import test from 'node:test';
import {
  openAISessionUpdate,
  resamplePcm16Base64,
} from '../src/openaiTranslator.js';

test('OpenAI session selects the target language without a separate transcription model', () => {
  assert.deepEqual(openAISessionUpdate('pt'), {
    type: 'session.update',
    session: {
      audio: {
        output: { language: 'pt' },
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
