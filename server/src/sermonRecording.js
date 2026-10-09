import { open } from 'node:fs/promises';

// Transcribes the speaker audio recorded during a service window after the
// window ends. Transcribing a whole recording is more accurate than the live
// transcript because the model hears what comes before and after each word.

// Speaker audio as the server receives it: 16 kHz mono PCM16.
const SAMPLE_RATE = 16_000;
const BYTES_PER_SECOND = SAMPLE_RATE * 2;
export const DEFAULT_SERMON_TRANSCRIBE_MODEL = 'gemini-3.5-transcribe';
// Five-minute pieces stay well under Gemini's 20 MB request limit once encoded.
const PIECE_SECONDS = 300;
// Each piece ends at the quietest moment of its last seconds so no word is split.
const CUT_SEARCH_SECONDS = 15;
const CUT_FRAME_BYTES = BYTES_PER_SECOND / 5; // 200 ms
const CUT_STEP_BYTES = BYTES_PER_SECOND / 10; // 100 ms
const REQUEST_TIMEOUT_MS = 120_000;
const ATTEMPTS = 3;
const RETRY_DELAY_MS = 15_000;
// A short pause between pieces keeps the work gentle on a small server.
const PAUSE_BETWEEN_PIECES_MS = 1_000;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A 44-byte WAV header for 16 kHz mono PCM16 data of the given length. */
export function wavHeader(dataBytes) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(BYTES_PER_SECOND, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataBytes, 40);
  return header;
}

/** Byte offset of the quietest 200 ms in the last seconds of a PCM16 buffer. */
export function cutAtPause(pcm, searchSeconds = CUT_SEARCH_SECONDS) {
  const start = Math.max(0, pcm.length - Math.round(searchSeconds * BYTES_PER_SECOND));
  let best = pcm.length;
  let bestEnergy = Infinity;
  for (let offset = start - (start % 2); offset + CUT_FRAME_BYTES <= pcm.length; offset += CUT_STEP_BYTES) {
    let energy = 0;
    for (let i = offset; i < offset + CUT_FRAME_BYTES; i += 2) energy += pcm.readInt16LE(i) ** 2;
    if (energy < bestEnergy) {
      bestEnergy = energy;
      best = offset + CUT_FRAME_BYTES / 2;
    }
  }
  return Math.max(2, best - (best % 2));
}

async function transcribePiece(pcm, { model, apiKey, fetchImpl, timeoutMs }) {
  const audio = Buffer.concat([wavHeader(pcm.length), pcm]).toString('base64');
  const response = await fetchImpl(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        contents: [{
          role: 'user',
          parts: [{ inlineData: { mimeType: 'audio/wav', data: audio } }, { text: 'Transcribe this audio.' }],
        }],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    },
  );
  let body = null;
  try {
    body = await response.json();
  } catch {
    // The status decides below.
  }
  if (!response.ok) {
    const message = body?.error?.message ? `: ${String(body.error.message).slice(0, 200)}` : '';
    throw new Error(`Gemini ${response.status}${message}`);
  }
  const candidate = body?.candidates?.[0];
  if (!candidate) throw new Error('Gemini returned no transcription');
  // The transcription model answers in audioTranscription rather than text.
  return (candidate.content?.parts ?? [])
    .map((part) => part.audioTranscription?.text ?? (part.thought ? '' : part.text ?? ''))
    .join('');
}

async function withRetries(task, retryDelayMs) {
  let lastError = null;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    if (attempt > 1) await wait(retryDelayMs);
    try {
      return await task();
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

/**
 * Transcribes a raw 16 kHz PCM16 recording in pieces of up to five minutes,
 * one at a time, each piece retried up to three times. Throws if a piece
 * still fails, so the caller can fall back to the live transcript.
 */
export async function transcribeRecording({
  path,
  model = DEFAULT_SERMON_TRANSCRIBE_MODEL,
  apiKey,
  fetchImpl = fetch,
  timeoutMs = REQUEST_TIMEOUT_MS,
  retryDelayMs = RETRY_DELAY_MS,
  pauseMs = PAUSE_BETWEEN_PIECES_MS,
  pieceSeconds = PIECE_SECONDS,
}) {
  const pieceBytes = Math.round(pieceSeconds * BYTES_PER_SECOND);
  const searchSeconds = Math.min(CUT_SEARCH_SECONDS, pieceSeconds / 4);
  const handle = await open(path, 'r');
  try {
    const { size } = await handle.stat();
    const usable = size - (size % 2);
    const texts = [];
    let offset = 0;
    let pieces = 0;
    while (offset < usable) {
      const length = Math.min(pieceBytes, usable - offset);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, offset);
      const last = offset + length >= usable;
      const cut = last ? length : cutAtPause(buffer, searchSeconds);
      const text = await withRetries(
        () => transcribePiece(buffer.subarray(0, cut), { model, apiKey, fetchImpl, timeoutMs }),
        retryDelayMs,
      );
      if (text.trim()) texts.push(text.trim());
      offset += cut;
      pieces += 1;
      if (offset < usable) await wait(pauseMs);
    }
    return { text: texts.join('\n\n'), pieces, seconds: Math.round(usable / BYTES_PER_SECOND) };
  } finally {
    await handle.close();
  }
}
