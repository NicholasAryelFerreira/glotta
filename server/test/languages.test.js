import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GEMINI_LANGUAGES,
  OPENAI_LANGUAGES,
  isSupportedLanguage,
  languagesForProvider,
} from '../src/languages.js';

test('language choices are scoped to the selected translation provider', () => {
  assert.equal(OPENAI_LANGUAGES.length, 13);
  assert.ok(GEMINI_LANGUAGES.length > 70);
  assert.equal(languagesForProvider('openai'), OPENAI_LANGUAGES);
  assert.equal(languagesForProvider('gemini'), GEMINI_LANGUAGES);
  assert.equal(isSupportedLanguage('pt', 'openai'), true);
  assert.equal(isSupportedLanguage('pt-BR', 'openai'), false);
  assert.equal(isSupportedLanguage('pt-BR', 'gemini'), true);
});
