import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { cutAtPause, transcribeRecording, wavHeader } from '../src/sermonRecording.js';
import { SermonTranscriptArchive, createSermonTranscriptArchive, parseSermonWindows } from '../src/sermonTranscript.js';
import { SessionManager } from '../src/sessionManager.js';

const MINUTE = 60_000;
// Sunday, October 11, 2026, 11:00 AM in Alabama (CDT, UTC-5).
const SUNDAY_11AM = Date.parse('2026-10-11T16:00:00Z');
const WINDOWS = parseSermonWindows('Sun 11:00-12:20').windows;
const SECOND_BYTES = 32_000;

function tone(seconds, amplitude = 8_000) {
  const pcm = Buffer.alloc(Math.round(seconds * SECOND_BYTES));
  for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(i % 2 ? amplitude : -amplitude, i * 2);
  return pcm;
}

function tempDir(context) {
  const dir = mkdtempSync(join(tmpdir(), 'glotta-recording-test-'));
  context.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function quietLogs(context) {
  const lines = [];
  context.mock.method(console, 'log', (...args) => lines.push(args.join(' ')));
  context.mock.method(console, 'error', (...args) => lines.push(args.join(' ')));
  return lines;
}

function transcriptionReply(text) {
  return Response.json({ candidates: [{ content: { parts: [{ audioTranscription: { text } }] }, finishReason: 'STOP' }] });
}

test('the WAV header describes 16 kHz mono PCM16', () => {
  const header = wavHeader(32_000);
  assert.equal(header.toString('ascii', 0, 4), 'RIFF');
  assert.equal(header.readUInt32LE(4), 36 + 32_000);
  assert.equal(header.readUInt16LE(22), 1);
  assert.equal(header.readUInt32LE(24), 16_000);
  assert.equal(header.readUInt16LE(34), 16);
  assert.equal(header.readUInt32LE(40), 32_000);
});

test('pieces are cut at the quietest moment near their end', () => {
  // 20 s of sound with a half-second pause starting at 17 s.
  const pcm = Buffer.concat([tone(17), Buffer.alloc(SECOND_BYTES / 2), tone(2.5)]);
  const cut = cutAtPause(pcm, 15);
  assert.ok(cut > 17 * SECOND_BYTES && cut < 17.5 * SECOND_BYTES, `cut at ${cut / SECOND_BYTES} s`);
  assert.equal(cut % 2, 0);
});

test('a recording is transcribed piece by piece and joined', async (context) => {
  const dir = tempDir(context);
  const path = join(dir, 'audio.pcm');
  // Three seconds of sound, a pause, three more seconds: 2-second pieces.
  writeFileSync(path, Buffer.concat([tone(1.8), Buffer.alloc(SECOND_BYTES / 5), tone(1.8), Buffer.alloc(SECOND_BYTES / 5), tone(1)]));
  const requests = [];
  const result = await transcribeRecording({
    path,
    apiKey: 'key',
    pieceSeconds: 2,
    minIntervalMs: 0,
    retryDelayMs: 0,
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      requests.push({ url, body, apiKey: init.headers['x-goog-api-key'] });
      return transcriptionReply(`Piece ${requests.length}.`);
    },
  });
  assert.equal(result.text, 'Piece 1.\n\nPiece 2.\n\nPiece 3.');
  assert.equal(result.pieces, 3);
  assert.match(requests[0].url, /models\/gemini-3\.5-transcribe:generateContent$/);
  assert.equal(requests[0].apiKey, 'key');
  const [audio, instruction] = requests[0].body.contents[0].parts;
  assert.equal(audio.inlineData.mimeType, 'audio/wav');
  assert.equal(Buffer.from(audio.inlineData.data, 'base64').toString('ascii', 0, 4), 'RIFF');
  assert.equal(instruction.text, 'Transcribe this audio.');
});

test('a failing piece is retried, and a piece that keeps failing fails the recording', async (context) => {
  const dir = tempDir(context);
  const path = join(dir, 'audio.pcm');
  writeFileSync(path, tone(1));
  let calls = 0;
  const recovered = await transcribeRecording({
    path,
    apiKey: 'key',
    retryDelayMs: 0,
    minIntervalMs: 0,
    fetchImpl: async () => {
      calls += 1;
      return calls < 3 ? Response.json({ error: { message: 'overloaded' } }, { status: 503 }) : transcriptionReply('Amen.');
    },
  });
  assert.equal(recovered.text, 'Amen.');
  assert.equal(calls, 3);
  await assert.rejects(
    transcribeRecording({
      path,
      apiKey: 'key',
      retryDelayMs: 0,
      minIntervalMs: 0,
      fetchImpl: async () => Response.json({ error: { message: 'overloaded' } }, { status: 503 }),
    }),
    (err) => err.message === 'Gemini 503: overloaded' && err.piece === 1,
  );
});

// A fake clock: waiting moves time forward instead of sleeping.
function fakeClock() {
  let time = 0;
  const waits = [];
  return {
    now: () => time,
    wait: async (ms) => { waits.push(ms); time += ms; },
    waits,
  };
}

test('requests are spaced at least 61 seconds apart so the per-minute token limit is never reached', async (context) => {
  const dir = tempDir(context);
  const path = join(dir, 'audio.pcm');
  // Twelve minutes of sound, in pieces of at most four minutes (about 6,000 tokens).
  writeFileSync(path, tone(12 * 60));
  const clock = fakeClock();
  const startedAt = [];
  const result = await transcribeRecording({
    path,
    apiKey: 'key',
    now: clock.now,
    wait: clock.wait,
    fetchImpl: async () => {
      startedAt.push(clock.now());
      return transcriptionReply('Text.');
    },
  });
  assert.ok(result.pieces >= 3);
  assert.equal(startedAt.length, result.pieces);
  startedAt.slice(1).forEach((at, i) => assert.equal(at - startedAt[i], 61_000, 'one request per 61 seconds'));
});

test('"too many requests" waits as long as Google asks and names the limit if it keeps failing', async (context) => {
  const dir = tempDir(context);
  const path = join(dir, 'audio.pcm');
  writeFileSync(path, tone(1));
  const limited = (retryDelay) => Response.json({
    error: {
      code: 429,
      message: 'You exceeded your current quota, please check your plan and billing details.',
      details: [
        { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'InputTokensPerModelPerMinute' }] },
        ...(retryDelay ? [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay }] : []),
      ],
    },
  }, { status: 429 });

  const clock = fakeClock();
  let calls = 0;
  const recovered = await transcribeRecording({
    path,
    apiKey: 'key',
    now: clock.now,
    wait: clock.wait,
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) return limited('90s');
      if (calls === 2) return limited(null);
      return transcriptionReply('Amen.');
    },
  });
  assert.equal(recovered.text, 'Amen.');
  assert.deepEqual(clock.waits, [90_000, 61_000], 'Google asked for 90 s, then at least a minute');

  const failing = fakeClock();
  calls = 0;
  await assert.rejects(
    transcribeRecording({
      path,
      apiKey: 'key',
      now: failing.now,
      wait: failing.wait,
      fetchImpl: async () => { calls += 1; return limited('5s'); },
    }),
    (err) => err.status === 429 && err.piece === 1 && /^Gemini 429 \(InputTokensPerModelPerMinute\): You exceeded/.test(err.message),
  );
  assert.equal(calls, 5, 'rate limits get five attempts');
});

function recordingArchive(context, { transcribe, sendEmail, startedAt = SUNDAY_11AM - 30 * MINUTE } = {}) {
  const lines = quietLogs(context);
  const dir = tempDir(context);
  let now = startedAt;
  const sent = [];
  const archive = new SermonTranscriptArchive({
    weeklySessionId: 'SERMON',
    windows: WINDOWS,
    timeZone: 'America/Chicago',
    now: () => now,
    recordingDir: dir,
    transcribeRecording: transcribe ?? (async (path) => ({ text: `Recorded ${readFileSync(path).length} bytes.`, pieces: 1 })),
    trimTranscript: async (paragraphs) => ({ status: 'trimmed', model: 'test-model', paragraphs }),
    sendEmail: sendEmail ?? (async (message) => { sent.push(message); }),
  });
  return { archive, dir, sent, lines, at(time) { now = time; } };
}

test('only the weekly session\'s audio inside a window is recorded, and the email uses it', async (context) => {
  const { archive, dir, sent, lines, at } = recordingArchive(context);
  const second = tone(1).toString('base64');
  at(SUNDAY_11AM - MINUTE);
  archive.recordAudio('SERMON', second); // before the window
  at(SUNDAY_11AM + MINUTE);
  archive.recordAudio('OTHER1', second); // another session
  for (let i = 0; i < 12; i++) archive.recordAudio('SERMON', second);
  archive.record('SERMON', 'input-final', 'The live transcript.');
  at(SUNDAY_11AM + 80 * MINUTE + 1);
  archive.recordAudio('SERMON', second); // after the window
  await new Promise((resolve) => setTimeout(resolve, 50)); // writes reach the disk without blocking
  assert.equal(readdirSync(dir).length, 1);

  at(SUNDAY_11AM + 90 * MINUTE);
  await archive.tick();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, `Sunday Morning Sermon – October 11, 2026\n\nRecorded ${12 * SECOND_BYTES} bytes.`);
  assert.deepEqual(readdirSync(dir), [], 'the recording is deleted');
  const sentLog = lines.find((line) => line.includes('"event":"sent"'));
  assert.match(sentLog, /"source":"recording","recordingMinutes":0.2,"recordingPieces":1/);
});

test('if the recording cannot be transcribed the live transcript is used', async (context) => {
  const { archive, dir, sent, lines, at } = recordingArchive(context, {
    transcribe: async () => { throw Object.assign(new Error('Gemini 503: overloaded'), { piece: 3 }); },
  });
  at(SUNDAY_11AM + MINUTE);
  for (let i = 0; i < 12; i++) archive.recordAudio('SERMON', tone(1).toString('base64'));
  archive.record('SERMON', 'input-final', 'The live transcript.');
  at(SUNDAY_11AM + 90 * MINUTE);
  await archive.tick();
  assert.equal(sent[0].text, 'Sunday Morning Sermon – October 11, 2026\n\nThe live transcript.');
  assert.deepEqual(readdirSync(dir), []);
  const sentLog = lines.find((line) => line.includes('"event":"sent"'));
  assert.match(sentLog, /"source":"live","recordingMinutes":0.2,"recordingError":"Gemini 503: overloaded","recordingFailedPiece":3/);
});

test('a send that fails after a long transcription still gets its retries', async (context) => {
  let harness = null;
  let sendAttempts = 0;
  harness = recordingArchive(context, {
    transcribe: async () => {
      // Two hours of audio take about half an hour to transcribe.
      harness.at(SUNDAY_11AM + 130 * MINUTE);
      return { text: 'The sermon.', pieces: 30 };
    },
    sendEmail: async () => {
      sendAttempts += 1;
      if (sendAttempts === 1) throw new Error('Brevo 503');
    },
  });
  const { archive, lines, at } = harness;
  at(SUNDAY_11AM + MINUTE);
  for (let i = 0; i < 12; i++) archive.recordAudio('SERMON', tone(1).toString('base64'));
  at(SUNDAY_11AM + 90 * MINUTE);
  await archive.tick();
  assert.equal(archive.entries.size, 1, 'kept for a retry, not discarded');
  assert.ok(lines.some((line) => line.includes('"event":"send-failed"')));
  at(SUNDAY_11AM + 136 * MINUTE);
  await archive.tick();
  assert.equal(sendAttempts, 2);
  assert.ok(lines.some((line) => line.includes('"event":"sent"')));
});

test('a few seconds of audio use the live transcript, and silence alone sends nothing', async (context) => {
  let transcribed = 0;
  const { archive, sent, lines, at } = recordingArchive(context, {
    transcribe: async () => { transcribed += 1; return { text: '', pieces: 1 }; },
  });
  at(SUNDAY_11AM + MINUTE);
  for (let i = 0; i < 3; i++) archive.recordAudio('SERMON', tone(1).toString('base64'));
  at(SUNDAY_11AM + 90 * MINUTE);
  await archive.tick();
  assert.equal(transcribed, 0, 'three seconds is too short to transcribe separately');
  assert.equal(sent.length, 0);
  assert.ok(lines.some((line) => line.includes('"event":"nothing-to-send"')));
  assert.equal(archive.entries.size, 0);
});

test('recordings left from before a restart are cleared at start-up', (context) => {
  quietLogs(context);
  const dir = tempDir(context);
  writeFileSync(join(dir, 'old.pcm'), tone(1));
  const archive = new SermonTranscriptArchive({
    weeklySessionId: 'SERMON',
    windows: WINDOWS,
    recordingDir: dir,
    transcribeRecording: async () => ({ text: '', pieces: 0 }),
    trimTranscript: async () => ({}),
    sendEmail: async () => {},
  });
  assert.equal(archive.recordingDir, dir);
  assert.deepEqual(readdirSync(dir), []);
});

test('recording is on by default and can be switched off or pointed at another model', (context) => {
  const lines = quietLogs(context);
  const dir = tempDir(context);
  const env = {
    BREVO_API_KEY: 'brevo-key',
    SERMON_EMAIL_TO: 'me@example.com',
    SERMON_EMAIL_FROM: 'me@example.com',
    SERMON_WINDOWS: 'Sun 11:00-12:20',
  };
  const apiKeys = { gemini: { paid: 'gemini-key' } };
  const on = createSermonTranscriptArchive({ env, apiKeys, recordingDir: dir, start: false });
  assert.equal(on.recordingDir, dir);
  assert.match(lines.at(-1), /recording: on \(gemini-3\.5-transcribe\)/);

  createSermonTranscriptArchive({ env: { ...env, SERMON_TRANSCRIBE_MODEL: 'gemini-4-transcribe' }, apiKeys, recordingDir: dir, start: false });
  assert.match(lines.at(-1), /recording: on \(gemini-4-transcribe\)/);

  const off = createSermonTranscriptArchive({ env: { ...env, SERMON_TRANSCRIBE_MODEL: 'off' }, apiKeys, recordingDir: dir, start: false });
  assert.equal(off.recordingDir, null);
  assert.match(lines.at(-1), /recording: off/);

  createSermonTranscriptArchive({ env: { ...env, SERMON_TRANSCRIBE_MODEL: 'gpt-6-luna' }, apiKeys, recordingDir: dir, start: false });
  assert.ok(lines.some((line) => line.includes('recording off (SERMON_TRANSCRIBE_MODEL "gpt-6-luna" needs a Gemini model')));
});

test('speaker audio reaches the recorder without affecting the live session', (context) => {
  quietLogs(context);
  const manager = new SessionManager('test-key');
  const transcripts = [];
  manager.createTranscriptStream = () => ({
    ready: true,
    connect: async () => {},
    sendAudio(chunk) { transcripts.push(chunk); },
    close() {},
  });
  const recorded = [];
  manager.sermonArchive = {
    record() {},
    recordAudio(sessionId, chunk) {
      recorded.push([sessionId, chunk]);
      if (chunk === 'boom') throw new Error('disk full');
    },
  };
  const session = manager.create({ id: 'SERMON' });
  context.after(() => session.end('test cleanup'));
  session.pushAudio('AAAA');
  session.pushAudio('boom');
  session.pushAudio('BBBB');
  assert.deepEqual(recorded.map(([id, chunk]) => `${id}:${chunk}`), ['SERMON:AAAA', 'SERMON:boom', 'SERMON:BBBB']);
  assert.deepEqual(transcripts, ['AAAA', 'boom', 'BBBB'], 'the live transcript still gets every chunk');
  assert.equal(existsSync(join(tmpdir(), 'glotta-recording-test-never-created')), false);
});
