import {
  DEFAULT_SERMON_FALLBACK_MODEL,
  EMAIL_MODEL_RETRY_DELAY_MS,
  callEmailModel,
  emailModelProvider,
} from './sermonTrim.js';

// Corrects the trimmed sermon a few paragraphs at a time with the same
// SERMON_EMAIL_MODEL: filler words removed, misheard words fixed. Each
// corrected paragraph is compared with the original and kept only if few
// words changed, so the model cannot reword, shorten, or add to the sermon.

export const DEFAULT_SERMON_PROOFREAD_PROMPT = 'This is part of a sermon transcribed automatically '
  + 'from live speech. Remove filler words such as "uh" and "um", and words repeated by accident, '
  + 'such as "the the". Correct words the transcription misheard, using the context of the sermon: '
  + 'names of people and places, books of the Bible and references, and theological terms. Fix '
  + 'punctuation, capitalization and spelling.';

// Appended to every prompt, including a custom SERMON_PROOFREAD_PROMPT, so a
// prompt edit cannot loosen the rules or change the reply the server checks.
const PROOFREAD_RULES = "Keep the preacher's own words, grammar and sentence order. Do not "
  + 'summarize, shorten, reorder, explain or add anything. If you are not sure a word was '
  + 'misheard, leave it as it is. The input is a JSON array of paragraphs. Reply with JSON only: '
  + '"paragraphs" is an array with exactly one corrected paragraph for each input paragraph, in '
  + 'the same order.';

const PROOFREAD_TIMEOUT_MS = 120_000;
// Paragraphs are sent in batches of about this many words, a few at a time.
const BATCH_WORDS = 1_000;
const MAX_PARALLEL_REQUESTS = 3;
// A corrected paragraph is kept only if it changed at most about a third of
// its words (at least a few). Misheard words may be replaced, up to five in a
// row ("Tin Dale. Tin Dale" -> "Tyndale. Tyndale"), but at most two words in a
// row may be dropped or added without a replacement ("and and" -> "and"), so
// a removed phrase or an added explanation is never accepted.
const MAX_CHANGED_SHARE = 0.35;
const MIN_ALLOWED_CHANGES = 6;
const MAX_REPLACED_RUN = 5;
const MAX_DROPPED_OR_ADDED_RUN = 2;
// Paragraphs larger than this are left as they are rather than compared.
const MAX_COMPARE_CELLS = 400_000;
const FILLER_WORDS = new Set(['uh', 'um', 'uhm', 'umm', 'er', 'erm', 'hmm']);

const PARAGRAPHS_JSON_SCHEMA = {
  type: 'object',
  properties: { paragraphs: { type: 'array', items: { type: 'string' } } },
  required: ['paragraphs'],
  additionalProperties: false,
};

const PARAGRAPHS_GEMINI_SCHEMA = {
  type: 'OBJECT',
  properties: { paragraphs: { type: 'ARRAY', items: { type: 'STRING' } } },
  required: ['paragraphs'],
};

function comparableWords(text) {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) ?? [])
    .filter((word) => !FILLER_WORDS.has(word));
}

/**
 * How a correction differs from the original, ignoring case, punctuation and
 * filler words: words changed in total, and the longest runs of words
 * replaced, dropped without replacement, or added without replacement.
 */
export function compareCorrection(original, corrected) {
  const before = comparableWords(original);
  const after = comparableWords(corrected);
  if ((before.length + 1) * (after.length + 1) > MAX_COMPARE_CELLS) return null;
  // Longest common subsequence of words, then walk it back to find the gaps.
  const table = Array.from({ length: before.length + 1 }, () => new Uint16Array(after.length + 1));
  for (let i = 1; i <= before.length; i++) {
    for (let j = 1; j <= after.length; j++) {
      table[i][j] = before[i - 1] === after[j - 1]
        ? table[i - 1][j - 1] + 1
        : Math.max(table[i - 1][j], table[i][j - 1]);
    }
  }
  const matches = [];
  for (let i = before.length, j = after.length; i > 0 && j > 0;) {
    if (before[i - 1] === after[j - 1]) {
      matches.push([i - 1, j - 1]);
      i -= 1;
      j -= 1;
    } else if (table[i - 1][j] >= table[i][j - 1]) {
      i -= 1;
    } else {
      j -= 1;
    }
  }
  matches.reverse();
  let replacedRun = 0;
  let droppedRun = 0;
  let addedRun = 0;
  let previous = [-1, -1];
  for (const match of [...matches, [before.length, after.length]]) {
    const dropped = match[0] - previous[0] - 1;
    const added = match[1] - previous[1] - 1;
    if (dropped > 0 && added > 0) replacedRun = Math.max(replacedRun, dropped, added);
    else if (dropped > 0) droppedRun = Math.max(droppedRun, dropped);
    else if (added > 0) addedRun = Math.max(addedRun, added);
    previous = match;
  }
  const common = matches.length;
  return {
    words: before.length,
    changed: before.length - common + after.length - common,
    replacedRun,
    droppedRun,
    addedRun,
  };
}

/** True when a correction stays faithful to the original paragraph. */
export function isFaithfulCorrection(original, corrected) {
  if (typeof corrected !== 'string' || !corrected.trim()) return false;
  const comparison = compareCorrection(original, corrected);
  if (!comparison) return false;
  const allowed = Math.max(MIN_ALLOWED_CHANGES, Math.ceil(comparison.words * MAX_CHANGED_SHARE));
  return comparison.changed <= allowed
    && comparison.replacedRun <= MAX_REPLACED_RUN
    && comparison.droppedRun <= MAX_DROPPED_OR_ADDED_RUN
    && comparison.addedRun <= MAX_DROPPED_OR_ADDED_RUN;
}

function wordCount(text) {
  return text.split(/\s+/).filter(Boolean).length;
}

function batchesOf(paragraphs) {
  const batches = [];
  let batch = null;
  paragraphs.forEach((paragraph, index) => {
    if (!batch || batch.words >= BATCH_WORDS) {
      batch = { start: index, paragraphs: [], words: 0 };
      batches.push(batch);
    }
    batch.paragraphs.push(paragraph);
    batch.words += wordCount(paragraph);
  });
  return batches;
}

/**
 * Returns the corrected paragraphs (originals wherever a correction was not
 * safe) and a summary for the log. Never throws.
 */
export async function proofreadSermon({
  paragraphs,
  model,
  prompt = DEFAULT_SERMON_PROOFREAD_PROMPT,
  apiKeys = {},
  fetchImpl = fetch,
  fallbackModel = DEFAULT_SERMON_FALLBACK_MODEL,
  timeoutMs = PROOFREAD_TIMEOUT_MS,
  retryDelayMs = EMAIL_MODEL_RETRY_DELAY_MS,
}) {
  const result = [...paragraphs];
  if (paragraphs.length === 0) return { paragraphs: result, summary: { proofread: 'skipped' } };
  const summary = {
    proofread: 'done',
    proofreadCorrected: 0,
    proofreadRejected: 0,
    proofreadFailed: 0,
    proofreadRetries: 0,
    proofreadFallback: 0,
  };
  const mainModel = emailModelProvider(model).model;
  const instructions = `${prompt.trim()}\n\n${PROOFREAD_RULES}`;
  const queue = batchesOf(paragraphs);
  const runBatch = async (batch) => {
    try {
      const answer = await callEmailModel({
        model,
        fallbackModel,
        apiKeys,
        request: {
          instructions,
          input: JSON.stringify(batch.paragraphs),
          schemaName: 'sermon_paragraphs',
          jsonSchema: PARAGRAPHS_JSON_SCHEMA,
          geminiSchema: PARAGRAPHS_GEMINI_SCHEMA,
        },
        check: (reply) => {
          const corrected = reply?.paragraphs;
          if (!Array.isArray(corrected) || corrected.length !== batch.paragraphs.length) {
            throw new Error('reply did not match the paragraphs sent');
          }
        },
        fetchImpl,
        timeoutMs,
        retryDelayMs,
      });
      summary.proofreadRetries += answer.attempts - 1;
      if (answer.model !== mainModel) summary.proofreadFallback += 1;
      const corrected = answer.reply.paragraphs;
      batch.paragraphs.forEach((original, offset) => {
        const fixed = typeof corrected[offset] === 'string' ? corrected[offset].trim() : '';
        if (fixed === original) return;
        if (isFaithfulCorrection(original, fixed)) {
          result[batch.start + offset] = fixed;
          summary.proofreadCorrected += 1;
        } else {
          summary.proofreadRejected += 1;
        }
      });
    } catch (err) {
      summary.proofreadRetries += (err.attempts ?? 1) - 1;
      summary.proofreadFailed += batch.paragraphs.length;
      summary.proofreadError ??= err.message;
    }
  };
  const workers = Array.from({ length: Math.min(MAX_PARALLEL_REQUESTS, queue.length) }, async () => {
    while (queue.length > 0) await runBatch(queue.shift());
  });
  await Promise.all(workers);
  return { paragraphs: result, summary };
}
