import assert from 'node:assert/strict';
import test from 'node:test';
import {
  geminiSetupMessage,
  normalizeUsageMetadata,
  transcriptionEvents,
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

test('Gemini Production speaker captions use text-only Live Transcribe setup', () => {
  assert.deepEqual(geminiSetupMessage({
    streamMode: 'transcription',
    targetLanguage: 'en',
  }), {
    setup: {
      model: 'models/gemini-3.5-transcribe-live',
      generationConfig: { responseModalities: ['TEXT'] },
      inputAudioTranscription: { languageCodes: [] },
    },
  });
});

test('Gemini listener and Testing caption streams retain Live Translate setup', () => {
  const message = geminiSetupMessage({
    targetLanguage: 'pt-BR',
    echoTargetLanguage: true,
    outputAudioTranscription: false,
  });
  assert.equal(message.setup.model, 'models/gemini-3.5-live-translate-preview');
  assert.deepEqual(message.setup.generationConfig, {
    responseModalities: ['AUDIO'],
    translationConfig: {
      targetLanguageCode: 'pt-BR',
      echoTargetLanguage: true,
    },
  });
  assert.deepEqual(message.setup.inputAudioTranscription, {});
  assert.equal(message.setup.outputAudioTranscription, undefined);
});

test('Live Transcribe exposes interim hypotheses separately from finalized text', () => {
  assert.deepEqual(transcriptionEvents({
    interim_input_transcription: { text: 'Words while speaking' },
    inputTranscription: { text: 'Words after speaking.' },
  }, 'transcription'), [
    { kind: 'input-interim', text: 'Words while speaking' },
    { kind: 'input-final', text: 'Words after speaking.' },
  ]);
});

test('Live Translate retains its existing finalized input and output events', () => {
  assert.deepEqual(transcriptionEvents({
    interimInputTranscription: { text: 'unused hypothesis' },
    inputTranscription: { text: 'Source words' },
    output_transcription: { text: 'Translated words' },
  }), [
    { kind: 'input', text: 'Source words' },
    { kind: 'output', text: 'Translated words' },
  ]);
});
