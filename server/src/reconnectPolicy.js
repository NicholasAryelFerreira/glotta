export const FAST_RECONNECT_ATTEMPTS = 5;
export const SLOW_RECONNECT_DELAY_MS = 30_000;

/** Retry quickly at first, then keep trying slowly for the life of the stream. */
export function reconnectDelayMs(attempt) {
  if (attempt > FAST_RECONNECT_ATTEMPTS) return SLOW_RECONNECT_DELAY_MS;
  return Math.min(1000 * 2 ** Math.max(0, attempt - 1), 10_000);
}

export function isFirstSlowReconnect(attempt) {
  return attempt === FAST_RECONNECT_ATTEMPTS + 1;
}
