import { sendBrevoEmail } from './sermonEmail.js';
import {
  DEFAULT_SERMON_TRIM_MODEL,
  DEFAULT_SERMON_TRIM_PROMPT,
  trimModelProvider,
  trimSermon,
} from './sermonTrim.js';

// Collects the weekly session's speaker transcript during the configured
// Sunday service windows, then emails the sermon once per window. Everything
// stays in memory: the transcript is erased once its email is sent (or after
// the retries run out), and a server restart erases it too.

export const SERMON_SEND_DELAY_MS = 10 * 60_000;
export const SERMON_RETRY_INTERVAL_MS = 5 * 60_000;
export const SERMON_RETRY_WINDOW_MS = 30 * 60_000;
// Render's free plan sleeps after about 15 minutes without incoming requests,
// which would lose a transcript still waiting to be sent.
export const SERMON_KEEP_AWAKE_INTERVAL_MS = 5 * 60_000;
const TICK_MS = 30_000;
const DEFAULT_TIME_ZONE = 'America/Chicago';
// About six hours of speech, so a runaway stream cannot exhaust memory.
const MAX_WINDOW_CHARS = 400_000;
// A new paragraph starts at a pause after a finished sentence, once the
// current one has a few sentences, or after any long silence.
const PARAGRAPH_PAUSE_MS = 2_500;
const MIN_PARAGRAPH_WORDS = 25;
const MAX_PARAGRAPH_WORDS = 180;
const LONG_SILENCE_MS = 20_000;
const FINAL_KINDS = new Set(['input', 'input-final']);

const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const SHORT_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function logSermonEvent(event, fields = {}) {
  // Metadata only: transcript text is never logged.
  console.log(`[sermon-transcript] ${JSON.stringify({ ts: new Date().toISOString(), event, ...fields })}`);
}

function twoDigits(number) {
  return String(number).padStart(2, '0');
}

function hhmm(minutes) {
  return `${twoDigits(Math.floor(minutes / 60))}:${twoDigits(minutes % 60)}`;
}

function dateLabel(dateKey) {
  const [year, month, day] = dateKey.split('-').map(Number);
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).format(Date.UTC(year, month - 1, day));
}

function partOfDay(minutes) {
  if (minutes < 12 * 60) return 'Morning';
  if (minutes < 17 * 60) return 'Afternoon';
  return 'Evening';
}

/** The email's subject and heading, e.g. "Sunday Morning Sermon – October 11, 2026". */
export function sermonTitle(dateKey, window) {
  const day = DAY_NAMES[window.day];
  return `${day[0].toUpperCase()}${day.slice(1)} ${partOfDay(window.startMin)} Sermon – ${dateLabel(dateKey)}`;
}

function wordCount(text) {
  return text.split(/\s+/).filter(Boolean).length;
}

/** Parses "Sun 11:00-12:20, Sun 18:10-19:20" (24-hour local times). */
export function parseSermonWindows(value) {
  const windows = [];
  const invalid = [];
  for (const raw of String(value ?? '').split(/[,;\n]/)) {
    const part = raw.trim();
    if (!part) continue;
    const match = part.match(/^([a-z]+)\s+(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/i);
    const dayName = match?.[1].toLowerCase() ?? '';
    const day = dayName.length >= 3 ? DAY_NAMES.findIndex((name) => name.startsWith(dayName)) : -1;
    const [startHour, startMinute, endHour, endMinute] = match ? match.slice(2).map(Number) : [];
    const startMin = startHour * 60 + startMinute;
    const endMin = endHour * 60 + endMinute;
    if (
      day < 0 || startHour > 23 || endHour > 23 || startMinute > 59 || endMinute > 59
      || !(startMin < endMin)
    ) {
      invalid.push(part);
      continue;
    }
    windows.push({ day, startMin, endMin, label: `${SHORT_DAYS[day]} ${hhmm(startMin)}-${hhmm(endMin)}` });
  }
  return { windows, invalid };
}

export function isValidTimeZone(timeZone) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

const clockFormatters = new Map();

/** Local date, weekday (0 = Sunday), and minutes after midnight in timeZone. */
export function localClock(at, timeZone) {
  let formatter = clockFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      weekday: 'short',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
    clockFormatters.set(timeZone, formatter);
  }
  const parts = {};
  for (const { type, value } of formatter.formatToParts(new Date(at))) parts[type] = value;
  return {
    dateKey: `${parts.year}-${parts.month}-${parts.day}`,
    weekday: SHORT_DAYS.indexOf(parts.weekday),
    minutes: (Number(parts.hour) % 24) * 60 + Number(parts.minute),
  };
}

function findWindow(windows, clock) {
  return windows.find((window) => (
    window.day === clock.weekday && clock.minutes >= window.startMin && clock.minutes < window.endMin
  )) ?? null;
}

function joinText(current, text) {
  // Add the space a provider occasionally omits after a sentence or comma.
  if (/[.!?,;:…]$/.test(current) && /^[\p{L}\p{N}]/u.test(text)) return `${current} ${text}`;
  return current + text;
}

/** Joins transcript pieces into readable paragraphs. */
export function buildParagraphs(pieces) {
  const paragraphs = [];
  let current = '';
  let currentWords = 0;
  for (const piece of pieces) {
    if (current.trim()) {
      const endsSentence = /[.!?…]["”’')\]]*\s*$/.test(current);
      const pause = piece.pauseBeforeMs ?? 0;
      if (
        pause >= LONG_SILENCE_MS
        || (endsSentence && currentWords >= MIN_PARAGRAPH_WORDS && pause >= PARAGRAPH_PAUSE_MS)
        || (endsSentence && currentWords >= MAX_PARAGRAPH_WORDS)
      ) {
        paragraphs.push(current);
        current = '';
        currentWords = 0;
      }
    }
    current = joinText(current, piece.text);
    currentWords += wordCount(piece.text);
  }
  if (current.trim()) paragraphs.push(current);
  return paragraphs.map((paragraph) => paragraph.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

function escapeHtml(text) {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * Subject, plain text, and HTML for one service window's email: the title and
 * the transcript only. Technical details go to the logs instead.
 */
export function composeSermonEmail({ dateKey, window, paragraphs }) {
  const title = sermonTitle(dateKey, window);
  const text = [title, '', paragraphs.join('\n\n')].join('\n');
  const html = [
    '<div style="font-family:Georgia,\'Times New Roman\',serif;font-size:16px;line-height:1.6;color:#1f2933;max-width:680px">',
    `<h1 style="font-size:22px;margin:0 0 20px">${escapeHtml(title)}</h1>`,
    ...paragraphs.map((paragraph) => `<p style="margin:0 0 14px">${escapeHtml(paragraph)}</p>`),
    '</div>',
  ].join('\n');
  return { subject: title, text, html };
}

export class SermonTranscriptArchive {
  constructor({
    weeklySessionId,
    windows,
    timeZone = DEFAULT_TIME_ZONE,
    trimTranscript,
    sendEmail,
    keepAwake = () => {},
    now = () => Date.now(),
  }) {
    this.weeklySessionId = weeklySessionId;
    this.windows = windows;
    this.timeZone = timeZone;
    this.trimTranscript = trimTranscript;
    this.sendEmail = sendEmail;
    this.keepAwake = keepAwake;
    this.now = now;
    this.entries = new Map(); // window key -> transcript waiting to be emailed
    this.lastKeepAwakeAt = 0;
    this.timer = null;
    // A start inside a window may mean a restart lost the text before it.
    this.startedAt = now();
    const startClock = localClock(this.startedAt, timeZone);
    const startWindow = findWindow(windows, startClock);
    this.startedInWindowKey = startWindow ? this.#windowKey(startClock, startWindow) : null;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick().catch((err) => console.error(`[sermon-transcript] tick failed: ${err.message}`));
    }, TICK_MS);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Called for every speaker transcript event; keeps only the weekly session's finalized text inside a window. */
  record(sessionId, kind, text) {
    if (sessionId !== this.weeklySessionId || typeof text !== 'string' || !text) return;
    const at = this.now();
    const clock = localClock(at, this.timeZone);
    const window = findWindow(this.windows, clock);
    if (!window) return;
    const key = this.#windowKey(clock, window);
    let entry = this.entries.get(key);
    if (kind === 'input-interim') {
      // Not stored, but the first hypothesis after a stored piece marks when
      // speech resumed, which separates pauses from transcription time.
      if (entry?.resumedAt === null) entry.resumedAt = at;
      return;
    }
    if (!FINAL_KINDS.has(kind)) return;
    if (!entry) entry = this.#createEntry(key, window, clock, at);
    if (entry.chars + text.length > MAX_WINDOW_CHARS) {
      if (!entry.truncated) {
        entry.truncated = true;
        logSermonEvent('transcript-capped', { window: key, chars: entry.chars });
      }
      return;
    }
    const pauseBeforeMs = entry.lastPieceAt === null ? 0 : (entry.resumedAt ?? at) - entry.lastPieceAt;
    entry.pieces.push({ at, text, pauseBeforeMs });
    entry.chars += text.length;
    entry.lastPieceAt = at;
    entry.resumedAt = null;
  }

  /** Sends due emails and keeps the server awake while any are waiting. */
  async tick() {
    if (this.entries.size === 0) return;
    const now = this.now();
    if (now - this.lastKeepAwakeAt >= SERMON_KEEP_AWAKE_INTERVAL_MS) {
      this.lastKeepAwakeAt = now;
      try {
        Promise.resolve(this.keepAwake()).catch(() => {});
      } catch { /* keeping awake is best effort */ }
    }
    const deliveries = [];
    for (const entry of this.entries.values()) {
      if (entry.busy || now < entry.nextAttemptAt) continue;
      entry.busy = true;
      deliveries.push(this.#deliver(entry).finally(() => { entry.busy = false; }));
    }
    await Promise.all(deliveries);
  }

  #windowKey(clock, window) {
    return `${clock.dateKey} ${window.label}`;
  }

  #createEntry(key, window, clock, at) {
    // Local minute boundaries match UTC ones in whole-minute time zones.
    const windowEndsAt = at - (at % 60_000) + (window.endMin - clock.minutes) * 60_000;
    const sendAt = windowEndsAt + SERMON_SEND_DELAY_MS;
    const entry = {
      key,
      dateKey: clock.dateKey,
      window,
      sendAt,
      nextAttemptAt: sendAt,
      giveUpAt: sendAt + SERMON_RETRY_WINDOW_MS,
      pieces: [],
      chars: 0,
      lastPieceAt: null,
      resumedAt: null,
      truncated: false,
      serverStartedInWindow: this.startedInWindowKey === key,
      busy: false,
      attempts: 0,
      email: null,
    };
    this.entries.set(key, entry);
    logSermonEvent('collecting', {
      window: key,
      sendAt: new Date(sendAt).toISOString(),
      serverStartedInWindow: entry.serverStartedInWindow,
    });
    return entry;
  }

  async #deliver(entry) {
    try {
      if (!entry.email) entry.email = await this.#prepare(entry);
      entry.attempts += 1;
      await this.sendEmail(entry.email.message);
      this.entries.delete(entry.key);
      logSermonEvent('sent', { window: entry.key, attempts: entry.attempts, ...entry.email.summary });
    } catch (err) {
      const now = this.now();
      if (now + SERMON_RETRY_INTERVAL_MS > entry.giveUpAt) {
        this.entries.delete(entry.key);
        logSermonEvent('discarded', { window: entry.key, attempts: entry.attempts, error: err.message });
        return;
      }
      entry.nextAttemptAt = now + SERMON_RETRY_INTERVAL_MS;
      logSermonEvent('send-failed', {
        window: entry.key,
        attempts: entry.attempts,
        retryAt: new Date(entry.nextAttemptAt).toISOString(),
        error: err.message,
      });
    }
  }

  async #prepare(entry) {
    const paragraphs = buildParagraphs(entry.pieces);
    let trim;
    try {
      trim = await this.trimTranscript(paragraphs);
    } catch (err) {
      trim = { status: 'full', reason: 'model-error', error: err.message };
    }
    const body = trim?.status === 'trimmed' ? trim.paragraphs : paragraphs;
    const message = composeSermonEmail({ dateKey: entry.dateKey, window: entry.window, paragraphs: body });
    const summary = {
      pieces: entry.pieces.length,
      transcriptWords: paragraphs.reduce((total, paragraph) => total + wordCount(paragraph), 0),
      emailWords: body.reduce((total, paragraph) => total + wordCount(paragraph), 0),
      trim: trim?.status ?? 'full',
      trimReason: trim?.reason ?? null,
      trimModel: trim?.model ?? null,
      trimError: trim?.error ?? null,
      serverStartedInWindow: entry.serverStartedInWindow,
      truncated: entry.truncated,
    };
    // Only the composed email is kept until it is sent.
    entry.pieces = [];
    return { message, summary };
  }
}

/**
 * Builds the archive from environment settings, or returns null (feature off)
 * unless Brevo, the recipients, the sender, and the windows are configured.
 */
export function createSermonTranscriptArchive({
  env = process.env,
  weeklySessionId,
  apiKeys = {},
  fetchImpl = fetch,
  now = () => Date.now(),
  start = true,
} = {}) {
  const value = (name) => String(env[name] ?? '').trim();
  const off = (reason) => {
    console.log(`[sermon-transcript] email off (${reason})`);
    return null;
  };
  const missing = ['BREVO_API_KEY', 'SERMON_EMAIL_TO', 'SERMON_EMAIL_FROM', 'SERMON_WINDOWS']
    .filter((name) => !value(name));
  if (missing.length) return off(`missing ${missing.join(', ')}`);

  const timeZone = value('SERMON_TIMEZONE') || DEFAULT_TIME_ZONE;
  if (!isValidTimeZone(timeZone)) return off(`unknown SERMON_TIMEZONE "${timeZone}"`);
  const { windows, invalid } = parseSermonWindows(value('SERMON_WINDOWS'));
  if (invalid.length) console.error(`[sermon-transcript] ignoring SERMON_WINDOWS entries: ${invalid.join(', ')}`);
  if (windows.length === 0) return off('no valid SERMON_WINDOWS');
  const addresses = (name) => value(name).split(/[\s,;]+/).filter(Boolean);
  const isAddress = (email) => /^[^@\s]+@[^@\s]+$/.test(email);
  const recipients = addresses('SERMON_EMAIL_TO');
  if (!recipients.every(isAddress)) return off('invalid SERMON_EMAIL_TO address');
  // Optional hidden copy of every email; an address already in To is skipped.
  const copyAddresses = addresses('SERMON_EMAIL_COPY_TO');
  if (!copyAddresses.every(isAddress)) console.error('[sermon-transcript] ignoring invalid SERMON_EMAIL_COPY_TO address');
  const bcc = copyAddresses.filter((email) => (
    isAddress(email) && !recipients.some((to) => to.toLowerCase() === email.toLowerCase())
  ));

  const from = { email: value('SERMON_EMAIL_FROM'), name: value('SERMON_EMAIL_FROM_NAME') || 'Glotta' };
  const model = value('SERMON_TRIM_MODEL') || DEFAULT_SERMON_TRIM_MODEL;
  const prompt = value('SERMON_TRIM_PROMPT') || DEFAULT_SERMON_TRIM_PROMPT;
  if (!trimModelProvider(model).provider) {
    console.error(`[sermon-transcript] SERMON_TRIM_MODEL "${model}" is not a Gemini or OpenAI model name; `
      + 'emails will contain the full transcript.');
  }
  const brevoApiKey = value('BREVO_API_KEY');
  const publicUrl = (value('RENDER_EXTERNAL_URL') || value('PUBLIC_BASE_URL')).replace(/\/+$/, '');
  const keepAwake = publicUrl
    ? () => fetchImpl(`${publicUrl}/healthz`, { signal: AbortSignal.timeout(10_000) })
      .then((response) => response.arrayBuffer())
      .catch(() => {})
    : () => {};

  const archive = new SermonTranscriptArchive({
    weeklySessionId,
    windows,
    timeZone,
    now,
    keepAwake,
    trimTranscript: (paragraphs) => trimSermon({ paragraphs, model, prompt, apiKeys, fetchImpl }),
    sendEmail: (message) => sendBrevoEmail({
      apiKey: brevoApiKey,
      from,
      to: recipients,
      bcc,
      ...message,
      fetchImpl,
    }),
  });
  console.log(
    `[sermon-transcript] email on (windows: ${windows.map((window) => window.label).join(', ')} ${timeZone}; `
    + `recipients: ${recipients.length}; copies: ${bcc.length}; trim model: ${model}; `
    + `prompt: ${value('SERMON_TRIM_PROMPT') ? 'custom' : 'default'}; keep-awake: ${publicUrl ? 'on' : 'off'})`,
  );
  if (start) archive.start();
  return archive;
}
