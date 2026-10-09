import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_SERMON_PROOFREAD_PROMPT,
  compareCorrection,
  isFaithfulCorrection,
  proofreadSermon,
} from '../src/sermonProofread.js';

// A transcribed paragraph and Gemini 3.8 Flash's real correction of it.
const MISHEARD = 'And God was preparing a man for this calling. His name was William Tin Dale. uh Tin Dale '
  + 'was the product of when diligence, hard work, genius, infection, girliness and and deep rooted faith '
  + 'all converge together. He mastered eight languages, including Greek and Hebrew.';
const CORRECTED = 'And God was preparing a man for this calling. His name was William Tyndale. Tyndale was '
  + 'the product of when diligence, hard work, genius, affection, godliness, and deep-rooted faith all '
  + 'converge together. He mastered eight languages, including Greek and Hebrew.';

function geminiFetch(answer, requests = []) {
  return async (url, init) => {
    requests.push({ url, init });
    const paragraphs = JSON.parse(JSON.parse(init.body).contents[0].parts[0].text);
    const reply = await answer(paragraphs);
    if (reply instanceof Response) return reply;
    return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(reply) }] } }] });
  };
}

test('real corrections of misheard words, fillers and repeats are accepted', () => {
  assert.deepEqual(compareCorrection(MISHEARD, CORRECTED), {
    words: 44,
    changed: 11,
    replacedRun: 4,
    droppedRun: 0,
    addedRun: 0,
  });
  assert.equal(isFaithfulCorrection(MISHEARD, CORRECTED), true);
  assert.equal(isFaithfulCorrection('So uh um we we pray. Amen', 'So we pray. Amen.'), true);
  assert.equal(isFaithfulCorrection('Passover. Passo. That is a ten-down.', 'Passover. Passover, that is a Tyndale.'), true);
});

test('rewording, shortening and added text are rejected', () => {
  // A sentence dropped from the paragraph.
  assert.equal(isFaithfulCorrection(MISHEARD, CORRECTED.replace(' He mastered eight languages, including Greek and Hebrew.', '')), false);
  // An explanation added to the paragraph.
  assert.equal(isFaithfulCorrection(MISHEARD, `${CORRECTED} Tyndale translated the Bible into English.`), false);
  // A three-word phrase dropped mid-sentence.
  assert.equal(isFaithfulCorrection(MISHEARD, CORRECTED.replace('hard work, genius, ', '')), false);
  // The same ideas in the model's own words.
  assert.equal(isFaithfulCorrection(
    MISHEARD,
    'God readied a man for this task, William Tyndale. Diligence, effort, brilliance, warmth, holiness and a '
      + 'deep faith came together in him. He learned eight tongues, Greek and Hebrew among them.',
  ), false);
  assert.equal(isFaithfulCorrection(MISHEARD, '   '), false);
});

test('proofreading keeps faithful corrections and the original wherever a correction is not safe', async () => {
  const paragraphs = [MISHEARD, 'Second paragraph stays as it is.', 'Third uh paragraph.'];
  const { paragraphs: result, summary } = await proofreadSermon({
    paragraphs,
    model: 'gemini-3.8-flash',
    apiKeys: { gemini: { paid: 'key' } },
    fetchImpl: geminiFetch(() => ({
      paragraphs: [CORRECTED, 'Second paragraph stays as it is.', 'Here is a completely different text.'],
    })),
  });
  assert.deepEqual(result, [CORRECTED, 'Second paragraph stays as it is.', 'Third uh paragraph.']);
  assert.deepEqual(summary, {
    proofread: 'done',
    proofreadCorrected: 1,
    proofreadRejected: 1,
    proofreadFailed: 0,
    proofreadRetries: 0,
    proofreadFallback: 0,
  });
});

test('a part that still fails after three attempts keeps its paragraphs unchanged', async () => {
  const paragraphs = ['One uh.', 'Two um.'];
  const apiKeys = { gemini: { paid: 'key' } };
  const requests = [];
  const mismatched = await proofreadSermon({
    paragraphs,
    model: 'gemini-3.8-flash',
    fallbackModel: 'gemini-3.5-flash',
    apiKeys,
    retryDelayMs: 0,
    fetchImpl: geminiFetch(() => ({ paragraphs: ['One. Two.'] }), requests),
  });
  assert.equal(requests.length, 3, 'a reply that does not match is retried');
  assert.deepEqual(mismatched.paragraphs, paragraphs);
  assert.equal(mismatched.summary.proofreadFailed, 2);
  assert.equal(mismatched.summary.proofreadRetries, 2);
  assert.equal(mismatched.summary.proofreadError, 'reply did not match the paragraphs sent');

  const failed = await proofreadSermon({
    paragraphs,
    model: 'gemini-3.8-flash',
    fallbackModel: 'gemini-3.5-flash',
    apiKeys,
    retryDelayMs: 0,
    fetchImpl: geminiFetch(() => Response.json({ error: { message: 'overloaded' } }, { status: 503 })),
  });
  assert.deepEqual(failed.paragraphs, paragraphs);
  assert.equal(failed.summary.proofreadError, 'Gemini 503: overloaded');

  // A wrong model name or a missing key is reported after the same attempts.
  const misconfigured = await proofreadSermon({
    paragraphs,
    model: 'claude-x',
    fallbackModel: 'gpt-6-luna',
    apiKeys,
    retryDelayMs: 0,
  });
  assert.deepEqual(misconfigured.paragraphs, paragraphs);
  assert.equal(misconfigured.summary.proofreadError, 'missing openai key');
});

test('a part that fails twice is answered by the OpenAI fallback model', async () => {
  const requests = [];
  let calls = 0;
  const { paragraphs, summary } = await proofreadSermon({
    paragraphs: ['Grace uh abounds.'],
    model: 'gemini-3.8-flash',
    apiKeys: { gemini: { paid: 'gemini-key' }, openai: 'openai-key' },
    retryDelayMs: 0,
    fetchImpl: async (url, init) => {
      calls += 1;
      requests.push({ url, body: JSON.parse(init.body) });
      if (url.includes('generativelanguage')) return Response.json({ error: { message: 'overloaded' } }, { status: 503 });
      return Response.json({
        output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ paragraphs: ['Grace abounds.'] }) }] }],
      });
    },
  });
  assert.equal(calls, 3);
  assert.match(requests[0].url, /gemini-3\.8-flash/);
  assert.match(requests[1].url, /gemini-3\.8-flash/);
  assert.equal(requests[2].url, 'https://api.openai.com/v1/responses');
  assert.equal(requests[2].body.model, 'gpt-6-luna', 'gpt-6-luna is the default fallback');
  assert.deepEqual(paragraphs, ['Grace abounds.']);
  assert.equal(summary.proofreadRetries, 2);
  assert.equal(summary.proofreadFallback, 1);
  assert.equal(summary.proofreadCorrected, 1);
});

test('a successful call is never repeated', async () => {
  const requests = [];
  const { summary } = await proofreadSermon({
    paragraphs: ['Grace uh abounds.'],
    model: 'gemini-3.8-flash',
    apiKeys: { gemini: { paid: 'key' } },
    retryDelayMs: 0,
    fetchImpl: geminiFetch(() => ({ paragraphs: ['A completely different sentence about nothing at all here.'] }), requests),
  });
  assert.equal(requests.length, 1, 'a rejected correction is not an error and is not retried');
  assert.equal(summary.proofreadRejected, 1);
  assert.equal(summary.proofreadRetries, 0);
});

test('long sermons are proofread in batches, a few requests at a time', async () => {
  const paragraph = (n) => `${Array.from({ length: 400 }, () => `word${n}`).join(' ')}.`;
  const paragraphs = Array.from({ length: 10 }, (_, n) => paragraph(n));
  const requests = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const { paragraphs: result, summary } = await proofreadSermon({
    paragraphs,
    model: 'gemini-3.8-flash',
    apiKeys: { gemini: { paid: 'key' } },
    fetchImpl: geminiFetch(async (batch) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return { paragraphs: batch };
    }, requests),
  });
  assert.equal(requests.length, 4, 'about 1,000 words per request');
  assert.equal(maxInFlight, 3);
  assert.deepEqual(result, paragraphs);
  assert.equal(summary.proofreadFailed, 0);
});

test('the prompt is followed by fixed rules, and OpenAI models get a strict schema', async () => {
  const requests = [];
  await proofreadSermon({
    paragraphs: ['Grace uh.'],
    model: 'gemini-3.8-flash',
    prompt: 'My own instructions.',
    apiKeys: { gemini: { paid: 'key' } },
    fetchImpl: geminiFetch((batch) => ({ paragraphs: batch }), requests),
  });
  const gemini = JSON.parse(requests[0].init.body);
  assert.match(gemini.systemInstruction.parts[0].text, /^My own instructions\.\n\nKeep the preacher's own words, grammar and sentence order\./);
  assert.equal(gemini.contents[0].parts[0].text, '["Grace uh."]');
  assert.equal(gemini.generationConfig.responseSchema.properties.paragraphs.type, 'ARRAY');

  let openai;
  const result = await proofreadSermon({
    paragraphs: ['Grace uh.'],
    model: 'gpt-5-mini',
    apiKeys: { openai: 'openai-key' },
    fetchImpl: async (url, init) => {
      openai = { url, body: JSON.parse(init.body), headers: init.headers };
      return Response.json({
        output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ paragraphs: ['Grace.'] }) }] }],
      });
    },
  });
  assert.equal(openai.url, 'https://api.openai.com/v1/responses');
  assert.equal(openai.headers.authorization, 'Bearer openai-key');
  assert.ok(openai.body.instructions.startsWith(DEFAULT_SERMON_PROOFREAD_PROMPT));
  assert.equal(openai.body.text.format.strict, true);
  assert.deepEqual(openai.body.text.format.schema.required, ['paragraphs']);
  assert.deepEqual(result.paragraphs, ['Grace.']);
});
