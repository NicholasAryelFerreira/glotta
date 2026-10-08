// Finds where the sermon starts and ends in a service transcript. The model
// only returns two sentence numbers; the server cuts the original text there,
// so the emailed sermon is always the transcript's own words.

export const DEFAULT_SERMON_TRIM_MODEL = 'gemini-3.5-flash';
export const DEFAULT_SERMON_TRIM_PROMPT = 'This is the transcript of a Sunday church service. '
  + 'Find the sermon: the message preached by the pastor. Start at the first sentence of '
  + 'the sermon, including the Bible passage the preacher reads to introduce it and any '
  + 'opening prayer by the preacher. End at the last sentence of the sermon, including '
  + "the preacher's closing prayer. Leave out everything else, such as worship songs, "
  + 'welcome and announcements, the offering, the final song and the benediction.';

// Appended to every prompt, including a custom SERMON_TRIM_PROMPT, so editing
// the prompt can never change the reply format the server depends on.
const REPLY_FORMAT = 'The transcript is split into numbered sentences, one per line, written as '
  + '[number] text. Reply with JSON only. "found" is true if the transcript contains the sermon. '
  + '"startSentence" and "endSentence" are the numbers of the first and last sentences of the '
  + 'sermon. "confidence" is "high", "medium" or "low".';

const TRIM_TIMEOUT_MS = 120_000;
// A shorter result is more likely a wrong cut than a sermon.
export const MIN_SERMON_WORDS = 100;
// Transcripts without punctuation are split into pieces of about this size.
const MAX_SENTENCE_WORDS = 60;
const LONG_SENTENCE_PIECE_WORDS = 40;

const BOUNDS_JSON_SCHEMA = {
  type: 'object',
  properties: {
    found: { type: 'boolean' },
    startSentence: { type: 'integer' },
    endSentence: { type: 'integer' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
  },
  required: ['found', 'startSentence', 'endSentence', 'confidence'],
  additionalProperties: false,
};

const BOUNDS_GEMINI_SCHEMA = {
  type: 'OBJECT',
  properties: {
    found: { type: 'BOOLEAN' },
    startSentence: { type: 'INTEGER' },
    endSentence: { type: 'INTEGER' },
    confidence: { type: 'STRING', enum: ['high', 'medium', 'low'] },
  },
  required: ['found', 'startSentence', 'endSentence', 'confidence'],
  propertyOrdering: ['found', 'startSentence', 'endSentence', 'confidence'],
};

/** Picks the provider from the model name: gemini-* or gpt-*, o3, o4-mini... */
export function trimModelProvider(model) {
  const name = String(model ?? '').trim().replace(/^models\//, '');
  if (/^gemini/i.test(name)) return { provider: 'gemini', model: name };
  if (/^(gpt|chatgpt|o\d)/i.test(name)) return { provider: 'openai', model: name };
  return { provider: null, model: name };
}

function wordCount(text) {
  return text.split(/\s+/).filter(Boolean).length;
}

function splitLongSentence(sentence) {
  const words = sentence.split(/\s+/).filter(Boolean);
  if (words.length <= MAX_SENTENCE_WORDS) return [sentence];
  const pieces = [];
  for (let i = 0; i < words.length; i += LONG_SENTENCE_PIECE_WORDS) {
    pieces.push(words.slice(i, i + LONG_SENTENCE_PIECE_WORDS).join(' '));
  }
  return pieces;
}

/** Sentences of each paragraph, numbered from 1 across the whole transcript. */
export function splitSentences(paragraphs) {
  const sentences = [];
  paragraphs.forEach((paragraph, index) => {
    const parts = paragraph.match(/[^.!?…]+(?:[.!?…]+["”’')\]]*|$)/g) ?? [];
    for (const part of parts) {
      for (const text of splitLongSentence(part.trim())) {
        if (text) sentences.push({ paragraph: index, text });
      }
    }
  });
  return sentences;
}

function numberedTranscript(sentences) {
  return sentences.map((sentence, index) => `[${index + 1}] ${sentence.text}`).join('\n');
}

function responseError(provider, status, body) {
  const message = body?.error?.message ?? body?.message ?? '';
  return new Error(`${provider} ${status}${message ? `: ${String(message).slice(0, 200)}` : ''}`);
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function requestGeminiBounds({ model, apiKey, instructions, transcript, fetchImpl, timeoutMs }) {
  const response = await fetchImpl(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: instructions }] },
        contents: [{ role: 'user', parts: [{ text: transcript }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: BOUNDS_GEMINI_SCHEMA,
        },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    },
  );
  const body = await readJson(response);
  if (!response.ok) throw responseError('Gemini', response.status, body);
  const parts = body?.candidates?.[0]?.content?.parts ?? [];
  const text = parts.filter((part) => !part.thought && part.text).map((part) => part.text).join('');
  if (!text) throw new Error(`Gemini returned no answer (${body?.candidates?.[0]?.finishReason ?? 'unknown'})`);
  return JSON.parse(text);
}

async function requestOpenAIBounds({ model, apiKey, instructions, transcript, fetchImpl, timeoutMs }) {
  const response = await fetchImpl('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      instructions,
      input: transcript,
      text: {
        format: { type: 'json_schema', name: 'sermon_bounds', strict: true, schema: BOUNDS_JSON_SCHEMA },
      },
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await readJson(response);
  if (!response.ok) throw responseError('OpenAI', response.status, body);
  const text = (body?.output ?? [])
    .filter((item) => item.type === 'message')
    .flatMap((item) => item.content ?? [])
    .filter((content) => content.type === 'output_text')
    .map((content) => content.text)
    .join('');
  if (!text) throw new Error(`OpenAI returned no answer (${body?.status ?? 'unknown'})`);
  return JSON.parse(text);
}

/**
 * Returns the sermon's paragraphs, or the reason the full transcript should be
 * sent instead. Never throws.
 */
export async function trimSermon({
  paragraphs,
  model = DEFAULT_SERMON_TRIM_MODEL,
  prompt = DEFAULT_SERMON_TRIM_PROMPT,
  apiKeys = {},
  fetchImpl = fetch,
  timeoutMs = TRIM_TIMEOUT_MS,
}) {
  const choice = trimModelProvider(model);
  const result = { model: choice.model };
  const sentences = splitSentences(paragraphs);
  if (sentences.length === 0) return { ...result, status: 'full', reason: 'empty' };
  if (!choice.provider) return { ...result, status: 'full', reason: 'unknown-model' };
  const apiKey = choice.provider === 'gemini'
    ? apiKeys.gemini?.paid || apiKeys.gemini?.free
    : apiKeys.openai;
  if (!apiKey) return { ...result, status: 'full', reason: `missing-${choice.provider}-key` };

  let bounds;
  try {
    const request = choice.provider === 'gemini' ? requestGeminiBounds : requestOpenAIBounds;
    bounds = await request({
      model: choice.model,
      apiKey,
      instructions: `${prompt.trim()}\n\n${REPLY_FORMAT}`,
      transcript: numberedTranscript(sentences),
      fetchImpl,
      timeoutMs,
    });
  } catch (err) {
    return { ...result, status: 'full', reason: 'model-error', error: err.message };
  }

  const start = Number(bounds?.startSentence);
  const end = Number(bounds?.endSentence);
  const usable = Number.isInteger(start) && Number.isInteger(end)
    && start >= 1 && end >= start && end <= sentences.length;
  if (bounds?.found !== true || !usable) return { ...result, status: 'full', reason: 'not-found' };
  if (bounds.confidence !== 'high' && bounds.confidence !== 'medium') {
    return { ...result, status: 'full', reason: 'low-confidence' };
  }

  const selected = sentences.slice(start - 1, end);
  const trimmed = [];
  let lastParagraph = null;
  for (const sentence of selected) {
    if (sentence.paragraph !== lastParagraph) trimmed.push([]);
    trimmed.at(-1).push(sentence.text);
    lastParagraph = sentence.paragraph;
  }
  const trimmedParagraphs = trimmed.map((group) => group.join(' '));
  const words = trimmedParagraphs.reduce((total, paragraph) => total + wordCount(paragraph), 0);
  if (words < MIN_SERMON_WORDS) return { ...result, status: 'full', reason: 'too-short' };
  return {
    ...result,
    status: 'trimmed',
    paragraphs: trimmedParagraphs,
    startSentence: start,
    endSentence: end,
    sentences: sentences.length,
    confidence: bounds.confidence,
  };
}
