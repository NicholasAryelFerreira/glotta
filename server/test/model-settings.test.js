import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const MODEL_SETTINGS = [
  'GEMINI_TRANSLATE_MODEL',
  'GEMINI_TRANSCRIBE_MODEL',
  'OPENAI_TRANSLATE_MODEL',
  'OPENAI_TRANSCRIBE_MODEL',
];

// Model names are read when a module loads, so each case loads fresh copies.
async function loadWithSettings(values, tag) {
  const previous = Object.fromEntries(MODEL_SETTINGS.map((name) => [name, process.env[name]]));
  for (const name of MODEL_SETTINGS) delete process.env[name];
  Object.assign(process.env, values);
  try {
    return {
      gemini: await import(`../src/translator.js?${tag}`),
      openai: await import(`../src/openaiTranslator.js?${tag}`),
    };
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test('without settings the current models are used', async () => {
  const { gemini, openai } = await loadWithSettings({}, 'defaults');
  assert.equal(gemini.geminiSetupMessage({ targetLanguage: 'es' }).setup.model, 'models/gemini-3.5-live-translate-preview');
  assert.equal(gemini.geminiSetupMessage({ streamMode: 'transcription' }).setup.model, 'models/gemini-3.5-transcribe-live');
  assert.equal(openai.openAIWebSocketUrl('translation'), 'wss://api.openai.com/v1/realtime/translations?model=gpt-realtime-translate');
  assert.equal(
    openai.openAISessionUpdate('en', 'transcription').session.audio.input.transcription.model,
    'gpt-live-transcribe',
  );
});

test('Render settings switch each live model', async () => {
  const { gemini, openai } = await loadWithSettings({
    GEMINI_TRANSLATE_MODEL: 'gemini-9-live-translate',
    GEMINI_TRANSCRIBE_MODEL: ' models/gemini-9-transcribe ',
    OPENAI_TRANSLATE_MODEL: 'gpt-9-translate',
    OPENAI_TRANSCRIBE_MODEL: 'gpt-9-transcribe',
  }, 'changed');
  assert.equal(gemini.geminiSetupMessage({ targetLanguage: 'es' }).setup.model, 'models/gemini-9-live-translate');
  assert.equal(gemini.geminiSetupMessage({ streamMode: 'transcription' }).setup.model, 'models/gemini-9-transcribe');
  const listener = new gemini.Translator({ apiKey: 'key', targetLanguage: 'es' });
  assert.equal(listener.model, 'gemini-9-live-translate', 'usage logs report the configured model');
  assert.equal(openai.openAIWebSocketUrl('translation'), 'wss://api.openai.com/v1/realtime/translations?model=gpt-9-translate');
  assert.equal(
    openai.openAISessionUpdate('en', 'transcription').session.audio.input.transcription.model,
    'gpt-9-transcribe',
  );
});

test('the home page shows the configured OpenAI translation model', async () => {
  const page = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(page, /PROVIDER_NOTES\.openai = PROVIDER_NOTES\.openai\.replace\('gpt-realtime-translate', d\.models\.openaiTranslate\)/);
  const server = await readFile(new URL('../src/index.js', import.meta.url), 'utf8');
  assert.match(server, /models: \{ openaiTranslate: OPENAI_TRANSLATION_MODEL \}/);
});
