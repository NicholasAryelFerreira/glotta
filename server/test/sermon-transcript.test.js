import assert from 'node:assert/strict';
import test from 'node:test';
import { sendBrevoEmail } from '../src/sermonEmail.js';
import {
  SERMON_KEEP_AWAKE_INTERVAL_MS,
  SERMON_RETRY_INTERVAL_MS,
  SermonTranscriptArchive,
  buildParagraphs,
  composeSermonEmail,
  createSermonTranscriptArchive,
  localClock,
  parseSermonWindows,
} from '../src/sermonTranscript.js';
import {
  DEFAULT_SERMON_TRIM_PROMPT,
  splitSentences,
  emailModelProvider,
  trimSermon,
} from '../src/sermonTrim.js';
import { SessionManager } from '../src/sessionManager.js';

const MINUTE = 60_000;
// Sunday, October 11, 2026, 11:00 AM in Alabama (CDT, UTC-5).
const SUNDAY_11AM = Date.parse('2026-10-11T16:00:00Z');
const WINDOWS = parseSermonWindows('Sun 11:00-12:20, Sun 18:10-19:20').windows;
const SECRET_WORDS = 'grace upon grace';
// Thirty six-word sentences: long enough to count as a sermon.
const SERMON_SENTENCES = Array.from({ length: 30 }, () => 'Grace is a gift we receive.').join(' ');

function quietLogs(context) {
  const lines = [];
  context.mock.method(console, 'log', (...args) => lines.push(args.join(' ')));
  context.mock.method(console, 'error', (...args) => lines.push(args.join(' ')));
  return lines;
}

function archiveHarness(context, { start = SUNDAY_11AM - 30 * MINUTE, sendEmail, trimTranscript } = {}) {
  const lines = quietLogs(context);
  let now = start;
  const sent = [];
  const keepAwake = [];
  const archive = new SermonTranscriptArchive({
    weeklySessionId: 'SERMON',
    windows: WINDOWS,
    timeZone: 'America/Chicago',
    now: () => now,
    keepAwake: () => keepAwake.push(now),
    trimTranscript: trimTranscript ?? (async (paragraphs) => ({
      status: 'trimmed',
      model: 'test-model',
      paragraphs: paragraphs.slice(1),
    })),
    sendEmail: sendEmail ?? (async (message) => { sent.push(message); }),
  });
  return {
    archive,
    sent,
    keepAwake,
    lines,
    at(time) { now = time; },
  };
}

test('service windows parse day names and 24-hour times', () => {
  const { windows, invalid } = parseSermonWindows('Sun 11:00-12:20, sunday 18:10 - 19:20, Wed 9:05-9:30, Fun 1:00-2:00, Sun 12:00-11:00');
  assert.deepEqual(windows.map((window) => window.label), [
    'Sun 11:00-12:20',
    'Sun 18:10-19:20',
    'Wed 09:05-09:30',
  ]);
  assert.deepEqual(invalid, ['Fun 1:00-2:00', 'Sun 12:00-11:00']);
});

test('local clock follows Central daylight and standard time', () => {
  assert.deepEqual(localClock(Date.parse('2026-10-11T16:30:00Z'), 'America/Chicago'), {
    dateKey: '2026-10-11',
    weekday: 0,
    minutes: 11 * 60 + 30,
  });
  assert.deepEqual(localClock(Date.parse('2026-12-13T17:30:00Z'), 'America/Chicago'), {
    dateKey: '2026-12-13',
    weekday: 0,
    minutes: 11 * 60 + 30,
  });
});

test('only the weekly session\'s finalized text inside a window is kept', (context) => {
  const harness = archiveHarness(context);
  harness.at(SUNDAY_11AM - MINUTE);
  harness.archive.record('SERMON', 'input-final', 'Before the window.');
  harness.at(SUNDAY_11AM + MINUTE);
  harness.archive.record('OTHER1', 'input-final', 'Another session.');
  harness.archive.record('SERMON', 'input-interim', 'Interim only');
  harness.archive.record('SERMON', 'output', 'Translated text');
  harness.archive.record('SERMON', 'input-final', 'Kept.');
  harness.archive.record('SERMON', 'input', ' Also kept.');
  harness.at(SUNDAY_11AM + 80 * MINUTE);
  harness.archive.record('SERMON', 'input-final', 'At 12:20, after the window.');
  assert.equal(harness.archive.entries.size, 1);
  const [entry] = harness.archive.entries.values();
  assert.equal(entry.key, '2026-10-11 Sun 11:00-12:20');
  assert.deepEqual(entry.pieces.map((piece) => piece.text), ['Kept.', ' Also kept.']);
});

test('one email is sent ten minutes after the window ends, combining every session in it', async (context) => {
  const { archive, sent, lines, at } = archiveHarness(context);
  at(SUNDAY_11AM + 5 * MINUTE);
  archive.record('SERMON', 'input-final', `Opening words about ${SECRET_WORDS}.`);
  // The speaker's session ends and a new one starts under the same code.
  at(SUNDAY_11AM + 30 * MINUTE);
  archive.record('SERMON', 'input-final', 'After a restart.');
  // Still live at 12:20: collecting stops, the session itself is untouched.
  at(SUNDAY_11AM + 80 * MINUTE + 1);
  archive.record('SERMON', 'input-final', 'Still talking at 12:20.');

  at(SUNDAY_11AM + 89 * MINUTE);
  await archive.tick();
  assert.equal(sent.length, 0, 'not before 12:30');
  at(SUNDAY_11AM + 90 * MINUTE);
  await archive.tick();
  assert.equal(sent.length, 1);
  assert.equal(archive.entries.size, 0, 'erased once sent');
  // Only the title and the trimmed transcript: no technical notes.
  assert.equal(sent[0].subject, 'Sunday Morning Sermon – October 11, 2026');
  assert.equal(sent[0].text, 'Sunday Morning Sermon – October 11, 2026\n\nAfter a restart.');

  at(SUNDAY_11AM + 200 * MINUTE);
  await archive.tick();
  assert.equal(sent.length, 1, 'never a second email for the window');
  const sentLog = lines.find((line) => line.includes('"event":"sent"'));
  assert.match(sentLog, /"trim":"trimmed","trimReason":null,"trimModel":"test-model"/);
  assert.ok(lines.every((line) => !line.includes(SECRET_WORDS)), 'transcript text is never logged');
});

test('the evening window gets its own email', async (context) => {
  const { archive, sent, at } = archiveHarness(context);
  at(SUNDAY_11AM + 10 * MINUTE);
  archive.record('SERMON', 'input-final', 'Morning.');
  at(Date.parse('2026-10-11T23:15:00Z')); // 6:15 PM
  archive.record('SERMON', 'input-final', 'Evening.');
  assert.equal(archive.entries.size, 2);
  at(Date.parse('2026-10-12T00:30:00Z')); // 7:30 PM
  await archive.tick();
  assert.equal(sent.length, 2);
  assert.equal(sent[0].subject, 'Sunday Morning Sermon – October 11, 2026');
  assert.equal(sent[1].subject, 'Sunday Evening Sermon – October 11, 2026');
});

test('a failed send retries, then the transcript is discarded', async (context) => {
  let attempts = 0;
  const { archive, lines, at } = archiveHarness(context, {
    sendEmail: async () => {
      attempts += 1;
      throw new Error('Brevo 401 (unauthorized)');
    },
  });
  at(SUNDAY_11AM + 5 * MINUTE);
  archive.record('SERMON', 'input-final', 'Words.');
  let time = SUNDAY_11AM + 90 * MINUTE;
  for (let i = 0; i < 10; i++) {
    at(time);
    await archive.tick();
    time += SERMON_RETRY_INTERVAL_MS;
  }
  // Every five minutes from 12:30 through 1:00 PM.
  assert.equal(attempts, 7);
  assert.equal(archive.entries.size, 0);
  assert.ok(lines.some((line) => line.includes('"event":"send-failed"')));
  assert.ok(lines.some((line) => line.includes('"event":"discarded"')));
});

test('the server is kept awake only while a transcript is waiting', async (context) => {
  const { archive, keepAwake, at } = archiveHarness(context);
  at(SUNDAY_11AM);
  await archive.tick();
  assert.equal(keepAwake.length, 0);
  archive.record('SERMON', 'input-final', 'Words.');
  for (let minute = 0; minute <= 90; minute += 0.5) {
    at(SUNDAY_11AM + minute * MINUTE);
    await archive.tick();
  }
  assert.equal(keepAwake.length, Math.floor(90 * MINUTE / SERMON_KEEP_AWAKE_INTERVAL_MS) + 1);
  at(SUNDAY_11AM + 120 * MINUTE);
  await archive.tick();
  assert.equal(keepAwake.length, 19, 'no more requests after the email is sent');
});

test('a server start inside a window is logged, not emailed', async (context) => {
  const { archive, sent, lines, at } = archiveHarness(context, {
    start: SUNDAY_11AM + 42 * MINUTE,
    trimTranscript: async (paragraphs) => ({ status: 'trimmed', model: 'test-model', paragraphs }),
  });
  archive.record('SERMON', 'input-final', 'Words.');
  at(SUNDAY_11AM + 90 * MINUTE);
  await archive.tick();
  assert.equal(sent[0].text, 'Sunday Morning Sermon – October 11, 2026\n\nWords.');
  const sentLog = lines.find((line) => line.includes('"event":"sent"'));
  assert.match(sentLog, /"serverStartedInWindow":true,"truncated":false/);
});

test('if trimming fails the full transcript is sent and the reason is logged', async (context) => {
  const { archive, sent, lines, at } = archiveHarness(context, {
    trimTranscript: async () => ({ status: 'full', reason: 'model-error', model: 'gemini-x', error: 'Gemini 404' }),
  });
  at(SUNDAY_11AM + 5 * MINUTE);
  archive.record('SERMON', 'input-final', 'Welcome.');
  archive.record('SERMON', 'input-final', ' Sermon.');
  at(SUNDAY_11AM + 90 * MINUTE);
  await archive.tick();
  assert.equal(sent[0].text, 'Sunday Morning Sermon – October 11, 2026\n\nWelcome. Sermon.');
  const sentLog = lines.find((line) => line.includes('"event":"sent"'));
  assert.match(sentLog, /"trim":"full","trimReason":"model-error","trimModel":"gemini-x","trimError":"Gemini 404"/);
});

test('paragraphs break at pauses after finished sentences and after long silences', () => {
  const sentence = (words) => `${Array.from({ length: words }, () => 'word').join(' ')}.`;
  const paragraphs = buildParagraphs([
    { text: sentence(30), pauseBeforeMs: 0 },
    { text: ` ${sentence(5)}`, pauseBeforeMs: 3_000 },
    { text: ' unfinished', pauseBeforeMs: 500 },
    { text: ' thought', pauseBeforeMs: 3_000 },
    { text: ' after a restart.', pauseBeforeMs: 60_000 },
  ]);
  assert.equal(paragraphs.length, 3);
  assert.equal(paragraphs[1], 'Word word word word word. Unfinished thought');
  assert.equal(paragraphs[2], 'After a restart.');
  assert.deepEqual(buildParagraphs([{ text: 'One.' }, { text: 'Two,' }, { text: 'three' }]), ['One. Two, three']);
});

test('finalized phrases are joined with spaces and sentences start with a capital', () => {
  // Pieces as Live Transcribe sent them in a real test: no spaces between them.
  const segment = (text) => ({ text, segment: true });
  assert.deepEqual(buildParagraphs([
    segment('We have made it to Hebrews 11'),
    segment("We're going to look at four verses. Hebrews 11."),
    segment('want to say thanks to everyone. those who have faith'),
    segment('and preserve their souls'),
    segment(', amen.'),
  ]), [
    "We have made it to Hebrews 11 We're going to look at four verses. Hebrews 11. "
      + 'Want to say thanks to everyone. Those who have faith and preserve their souls, amen.',
  ]);
  // Streamed fragments keep their own spacing and may continue a word.
  assert.deepEqual(buildParagraphs([{ text: ' Luther went to Witt' }, { text: 'enberg.' }]), ['Luther went to Wittenberg.']);
  // Abbreviations are not treated as sentence ends.
  assert.deepEqual(
    buildParagraphs([segment('The service is at 10 a.m. sharp in the U.S. office. it was good.')]),
    ['The service is at 10 a.m. sharp in the U.S. office. It was good.'],
  );
});

test('long stretches without a pause are split at sentence ends', () => {
  const paragraphs = buildParagraphs([{ text: `${SERMON_SENTENCES} ${SERMON_SENTENCES}`, segment: true }]);
  assert.equal(paragraphs.length, 3);
  for (const paragraph of paragraphs) {
    assert.ok(paragraph.split(' ').length <= 180, 'no paragraph runs past 180 words');
    assert.match(paragraph, /^Grace .*receive\.$/);
  }
  assert.equal(paragraphs.join(' '), `${SERMON_SENTENCES} ${SERMON_SENTENCES}`);
});

test('interim text marks when speech resumed so transcription time is not a pause', (context) => {
  const { archive, at } = archiveHarness(context);
  at(SUNDAY_11AM);
  archive.record('SERMON', 'input-final', 'First.');
  at(SUNDAY_11AM + 500);
  archive.record('SERMON', 'input-interim', 'Second');
  at(SUNDAY_11AM + 6_000);
  archive.record('SERMON', 'input-final', ' Second sentence.');
  const [entry] = archive.entries.values();
  assert.equal(entry.pieces[1].pauseBeforeMs, 500);
});

test('the email is the title and the HTML-escaped transcript', () => {
  const email = composeSermonEmail({
    dateKey: '2026-10-11',
    window: WINDOWS[1],
    paragraphs: ['Faith <and> "works" & love.', 'Second paragraph.'],
  });
  assert.equal(email.subject, 'Sunday Evening Sermon – October 11, 2026');
  assert.equal(email.text, 'Sunday Evening Sermon – October 11, 2026\n\nFaith <and> "works" & love.\n\nSecond paragraph.');
  assert.match(email.html, /<h1[^>]*>Sunday Evening Sermon – October 11, 2026<\/h1>/);
  assert.match(email.html, /Faith &lt;and&gt; &quot;works&quot; &amp; love\./);
  const weekday = composeSermonEmail({
    dateKey: '2026-10-08',
    window: parseSermonWindows('Thu 14:00-14:20').windows[0],
    paragraphs: ['Test.'],
  });
  assert.equal(weekday.subject, 'Thursday Afternoon Sermon – October 8, 2026');
});

test('the feature stays off until Brevo, recipients, sender, and windows are set', (context) => {
  const lines = quietLogs(context);
  const env = {
    BREVO_API_KEY: 'brevo-key',
    SERMON_EMAIL_TO: 'me@example.com',
    SERMON_EMAIL_FROM: 'me@example.com',
    SERMON_WINDOWS: 'Sun 11:00-12:20',
  };
  for (const name of Object.keys(env)) {
    assert.equal(createSermonTranscriptArchive({ env: { ...env, [name]: ' ' }, start: false }), null);
  }
  assert.equal(createSermonTranscriptArchive({ env: { ...env, SERMON_TIMEZONE: 'Mars/Base' }, start: false }), null);
  assert.equal(createSermonTranscriptArchive({ env: { ...env, SERMON_EMAIL_TO: 'not-an-address' }, start: false }), null);
  const archive = createSermonTranscriptArchive({
    env: {
      ...env,
      SERMON_EMAIL_TO: 'me@example.com, pastor@example.com',
      // An address already in To is not copied twice; an invalid one is ignored.
      SERMON_EMAIL_COPY_TO: 'ME@example.com, oops',
    },
    weeklySessionId: 'SERMON',
    start: false,
  });
  assert.ok(archive instanceof SermonTranscriptArchive);
  assert.equal(archive.timeZone, 'America/Chicago');
  const on = lines.find((line) => line.includes('email on'));
  assert.match(
    on,
    /recipients: 2; copies: 0; recording: off; model: gemini-3\.5-flash; fallback: gpt-6-luna; trim prompt: default; proofread: on \(default prompt\); keep-awake: off/,
  );
  assert.ok(lines.some((line) => line.includes('ignoring invalid SERMON_EMAIL_COPY_TO address')));
  assert.ok(lines.every((line) => !line.includes('brevo-key') && !line.includes('pastor@example.com')));

  const off = createSermonTranscriptArchive({
    env: { ...env, SERMON_EMAIL_MODEL: 'gemini-3.8-flash', SERMON_PROOFREAD: 'OFF' },
    start: false,
  });
  assert.equal(off.proofreadTranscript, null);
  assert.match(lines.at(-1), /model: gemini-3\.8-flash; fallback: gpt-6-luna; trim prompt: default; proofread: off;/);
});

test('the configured archive trims and proofreads with one model, then sends through Brevo', async (context) => {
  const lines = quietLogs(context);
  const requests = [];
  const geminiAnswer = (reply) => Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(reply) }] } }] });
  const fetchImpl = async (url, init = {}) => {
    requests.push({ url, init });
    if (url.includes('generativelanguage')) {
      const body = JSON.parse(init.body);
      if (body.generationConfig.responseSchema.properties.paragraphs) {
        // Proofreading: punctuation-only correction of each paragraph.
        const paragraphs = JSON.parse(body.contents[0].parts[0].text);
        return geminiAnswer({ paragraphs: paragraphs.map((paragraph) => paragraph.replace('Amen.', 'Amen!')) });
      }
      return geminiAnswer({ found: true, startSentence: 1, endSentence: 31, confidence: 'high' });
    }
    if (url.endsWith('/healthz')) return new Response('ok');
    return Response.json({ messageId: '<id@brevo>' }, { status: 201 });
  };
  let now = SUNDAY_11AM;
  const archive = createSermonTranscriptArchive({
    env: {
      BREVO_API_KEY: 'brevo-key',
      SERMON_EMAIL_TO: 'pastor@example.com',
      SERMON_EMAIL_COPY_TO: 'me@example.com',
      SERMON_EMAIL_FROM: 'sender@example.com',
      SERMON_EMAIL_FROM_NAME: 'Glotta',
      SERMON_WINDOWS: 'Sun 11:00-12:20',
      SERMON_EMAIL_MODEL: 'gemini-3.8-flash',
      SERMON_TRIM_PROMPT: 'Keep only the sermon.',
      SERMON_PROOFREAD_PROMPT: 'Fix the misheard words.',
      SERMON_TRANSCRIBE_MODEL: 'off',
      RENDER_EXTERNAL_URL: 'https://glotta.example.com/',
    },
    weeklySessionId: 'SERMON',
    apiKeys: { gemini: { paid: 'gemini-key' } },
    fetchImpl,
    now: () => now,
    start: false,
  });
  archive.record('SERMON', 'input-final', SERMON_SENTENCES);
  archive.record('SERMON', 'input-final', ' Amen.');
  archive.record('SERMON', 'input-final', ' Final song.');
  now = SUNDAY_11AM + 90 * MINUTE;
  await archive.tick();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(requests[0].url, 'https://glotta.example.com/healthz');
  const [trim, proofread, ...more] = requests.filter(({ url }) => url.includes('generativelanguage'));
  assert.equal(more.length, 0, 'one trim call and one proofreading call for a short sermon');
  for (const call of [trim, proofread]) {
    assert.match(call.url, /models\/gemini-3\.8-flash:generateContent$/, 'both calls use SERMON_EMAIL_MODEL');
    assert.equal(call.init.headers['x-goog-api-key'], 'gemini-key');
  }
  const trimBody = JSON.parse(trim.init.body);
  assert.match(trimBody.systemInstruction.parts[0].text, /^Keep only the sermon\.\n\nThe transcript is split/);
  assert.match(trimBody.contents[0].parts[0].text, /^\[1\] Grace is a gift we receive\.$/m);
  assert.match(trimBody.contents[0].parts[0].text, /^\[32\] Final song\.$/m);
  const proofreadBody = JSON.parse(proofread.init.body);
  assert.match(proofreadBody.systemInstruction.parts[0].text, /^Fix the misheard words\.\n\nKeep the preacher's own words/);
  assert.doesNotMatch(proofreadBody.contents[0].parts[0].text, /Final song/, 'only the trimmed sermon is proofread');

  const brevo = requests.find(({ url }) => url.includes('brevo'));
  assert.equal(brevo.url, 'https://api.brevo.com/v3/smtp/email');
  assert.equal(brevo.init.headers['api-key'], 'brevo-key');
  const email = JSON.parse(brevo.init.body);
  assert.deepEqual(email.sender, { email: 'sender@example.com', name: 'Glotta' });
  assert.deepEqual(email.to, [{ email: 'pastor@example.com' }]);
  assert.deepEqual(email.bcc, [{ email: 'me@example.com' }], 'a hidden copy goes to the copy address');
  assert.equal(email.subject, 'Sunday Morning Sermon – October 11, 2026');
  assert.match(email.textContent, /^Sunday Morning Sermon – October 11, 2026\n\nGrace is a gift/);
  assert.match(email.textContent, /Amen!$/, 'the proofread text is sent');
  assert.doesNotMatch(email.textContent, /Final song/);
  assert.equal(archive.entries.size, 0);
  const sentLog = lines.find((line) => line.includes('"event":"sent"'));
  assert.match(sentLog, /"proofread":"done","proofreadCorrected":1,"proofreadRejected":0,"proofreadFailed":0/);
});

test('model names choose Gemini or OpenAI', () => {
  assert.deepEqual(emailModelProvider('gemini-3.5-flash'), { provider: 'gemini', model: 'gemini-3.5-flash' });
  assert.deepEqual(emailModelProvider('models/gemini-pro-latest'), { provider: 'gemini', model: 'gemini-pro-latest' });
  assert.equal(emailModelProvider('gpt-5-mini').provider, 'openai');
  assert.equal(emailModelProvider('o4-mini').provider, 'openai');
  assert.equal(emailModelProvider('claude-x').provider, null);
});

test('sentences are numbered across paragraphs and long unpunctuated text is split', () => {
  const long = Array.from({ length: 100 }, (_, i) => `w${i}`).join(' ');
  const sentences = splitSentences(['One. Two? "Three!" Four', long]);
  assert.deepEqual(sentences.slice(0, 4).map((sentence) => sentence.text), ['One.', 'Two?', '"Three!"', 'Four']);
  assert.equal(sentences.length, 4 + 3);
  assert.equal(sentences[4].paragraph, 1);
  // Only a space after the punctuation ends a sentence, so numbers stay intact.
  assert.deepEqual(splitSentences(['Version 3.5 is out. It works.']).map((sentence) => sentence.text), [
    'Version 3.5 is out.',
    'It works.',
  ]);
});

function answer(bounds) {
  return async () => Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(bounds) }] } }] });
}

test('trimming falls back to the full transcript when the answer is unusable', async () => {
  const paragraphs = ['Welcome.', SERMON_SENTENCES, 'Bye.'];
  const apiKeys = { gemini: { paid: 'key' }, openai: 'openai-key' };
  const run = (bounds, extra = {}) => trimSermon({ paragraphs, apiKeys, fetchImpl: answer(bounds), ...extra });
  const trimmed = await run({ found: true, startSentence: 2, endSentence: 31, confidence: 'high' });
  assert.equal(trimmed.status, 'trimmed');
  assert.deepEqual(trimmed.paragraphs, [SERMON_SENTENCES]);
  assert.equal((await run({ found: true, startSentence: 2, endSentence: 31, confidence: 'low' })).reason, 'low-confidence');
  assert.equal((await run({ found: false, startSentence: 0, endSentence: 0, confidence: 'high' })).reason, 'not-found');
  assert.equal((await run({ found: true, startSentence: 2, endSentence: 99, confidence: 'high' })).reason, 'not-found');
  assert.equal((await run({ found: true, startSentence: 1, endSentence: 1, confidence: 'high' })).reason, 'too-short');
  // Errors are retried twice, the last time with the fallback model.
  const misconfigured = await run({}, { model: 'claude-x', fallbackModel: 'claude-y', retryDelayMs: 0 });
  assert.equal(misconfigured.reason, 'model-error');
  assert.equal(misconfigured.error, 'unknown model "claude-y"');
  assert.equal(misconfigured.attempts, 3);
  assert.equal((await run({}, { apiKeys: {}, retryDelayMs: 0 })).error, 'missing openai key');
  const failed = await trimSermon({
    paragraphs,
    apiKeys,
    retryDelayMs: 0,
    fetchImpl: async (url) => Response.json(
      { error: { message: 'quota exceeded' } },
      { status: url.includes('openai') ? 500 : 429 },
    ),
  });
  assert.equal(failed.reason, 'model-error');
  assert.equal(failed.error, 'OpenAI 500: quota exceeded');
});

test('a failed trim call is retried and a model answer is not', async () => {
  const paragraphs = ['Welcome.', SERMON_SENTENCES, 'Bye.'];
  const apiKeys = { gemini: { paid: 'key' }, openai: 'openai-key' };
  let calls = 0;
  const retried = await trimSermon({
    paragraphs,
    apiKeys,
    retryDelayMs: 0,
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) return Response.json({ error: { message: 'overloaded' } }, { status: 503 });
      return answer({ found: true, startSentence: 2, endSentence: 31, confidence: 'high' })();
    },
  });
  assert.equal(retried.status, 'trimmed');
  assert.equal(retried.attempts, 2);
  assert.equal(retried.model, 'gemini-3.5-flash');

  calls = 0;
  const notFound = await trimSermon({
    paragraphs,
    apiKeys,
    retryDelayMs: 0,
    fetchImpl: async () => {
      calls += 1;
      return answer({ found: false, startSentence: 0, endSentence: 0, confidence: 'low' })();
    },
  });
  assert.equal(notFound.reason, 'not-found');
  assert.equal(calls, 1, 'a model that answered "not found" is not asked again');
});

test('OpenAI models use the Responses API with a strict JSON schema', async () => {
  let request;
  const result = await trimSermon({
    paragraphs: ['Welcome.', SERMON_SENTENCES],
    model: 'gpt-5-mini',
    apiKeys: { openai: 'openai-key' },
    fetchImpl: async (url, init) => {
      request = { url, init };
      return Response.json({
        status: 'completed',
        output: [
          { type: 'reasoning', summary: [] },
          { type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ found: true, startSentence: 2, endSentence: 31, confidence: 'medium' }) }] },
        ],
      });
    },
  });
  assert.equal(request.url, 'https://api.openai.com/v1/responses');
  assert.equal(request.init.headers.authorization, 'Bearer openai-key');
  const body = JSON.parse(request.init.body);
  assert.equal(body.model, 'gpt-5-mini');
  assert.equal(body.text.format.type, 'json_schema');
  assert.equal(body.text.format.strict, true);
  assert.ok(body.instructions.startsWith(DEFAULT_SERMON_TRIM_PROMPT));
  assert.equal(result.status, 'trimmed');
  assert.equal(result.paragraphs.length, 1);
});

test('Brevo errors include the status and code', async () => {
  await assert.rejects(
    sendBrevoEmail({
      apiKey: 'key',
      from: { email: 'a@example.com', name: 'Glotta' },
      to: ['b@example.com'],
      subject: 'S',
      text: 'T',
      html: '<p>T</p>',
      fetchImpl: async () => Response.json({ code: 'unauthorized', message: 'Key not found' }, { status: 401 }),
    }),
    /Brevo 401 \(unauthorized: Key not found\)/,
  );
});

test('speaker transcript events reach the archive without affecting live captions', (context) => {
  quietLogs(context);
  const manager = new SessionManager('test-key');
  manager.createTranscriptStream = () => ({ ready: true, connect: async () => {}, sendAudio() {}, close() {} });
  const recorded = [];
  manager.sermonArchive = {
    record(sessionId, kind, text) {
      recorded.push([sessionId, kind, text]);
      if (text === 'boom') throw new Error('archive failure');
    },
  };
  const session = manager.create({ id: 'SERMON' });
  context.after(() => session.end('test cleanup'));
  const sent = [];
  const speaker = { OPEN: 1, readyState: 1, send: (payload) => sent.push(JSON.parse(payload)), close() {} };
  session.addSpeakerSocket(speaker);
  session.claimSpeaker(speaker);
  session.receiveSpeakerTranscript('Hello.', 'input-final');
  session.receiveSpeakerTranscript('boom', 'input-final');
  session.receiveSpeakerTranscript('Still live.', 'input-final');
  assert.deepEqual(recorded.map(([id, , text]) => `${id}:${text}`), ['SERMON:Hello.', 'SERMON:boom', 'SERMON:Still live.']);
  assert.deepEqual(sent.filter((msg) => msg.type === 'transcript').map((msg) => msg.text), ['Hello.', 'boom', 'Still live.']);
});
