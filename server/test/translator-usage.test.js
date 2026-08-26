import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeUsageMetadata,
  transcriptionSetupFields,
} from '../src/translator.js';

test('usage metadata logging normalizes token counts and modality details', () => {
  assert.deepEqual(normalizeUsageMetadata({
    promptTokenCount: 25,
    response_token_count: 20,
    totalTokenCount: 45,
    promptTokensDetails: [
      { modality: 'TEXT', tokenCount: 2407 },
      { modality: 'AUDIO', tokenCount: 25 },
    ],
    response_tokens_details: [{ modality: 'AUDIO', token_count: 20 }],
    serviceTier: 'STANDARD',
  }), {
    promptTokenCount: 25,
    responseTokenCount: 20,
    thoughtsTokenCount: null,
    cachedContentTokenCount: null,
    toolUsePromptTokenCount: null,
    totalTokenCount: 45,
    promptTokensDetails: [
      { modality: 'TEXT', tokenCount: 2407 },
      { modality: 'AUDIO', tokenCount: 25 },
    ],
    responseTokensDetails: [{ modality: 'AUDIO', tokenCount: 20 }],
    serviceTier: 'STANDARD',
  });
});

test('speaker transcript setup can omit only its unused output transcription', () => {
  assert.deepEqual(transcriptionSetupFields({ outputAudioTranscription: false }), {
    inputAudioTranscription: {},
  });
  assert.deepEqual(transcriptionSetupFields(), {
    inputAudioTranscription: {},
    outputAudioTranscription: {},
  });
});
