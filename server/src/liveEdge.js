const MIN_LIVE_EDGE_QUEUE_SECONDS = 0.25;
const MAX_LIVE_EDGE_QUEUE_SECONDS = 1;
export const LIVE_EDGE_LISTENER_MAX_BUFFER_SECONDS = 2;
const AUDIO_CHUNKS_PER_SECOND = 10;
const JSON_ENVELOPE_BYTES_PER_CHUNK = 128;

// Healthy streams change slowly, so one aggregate per minute is enough to
// establish an end-to-end baseline without crowding incidents out of Render's
// retained log view. Anomalies stay more frequent so a sustained queue problem
// remains visible while it is happening.
export const HEALTH_METRIC_LOG_INTERVAL_MS = 60_000;
export const ANOMALY_METRIC_LOG_INTERVAL_MS = 10_000;

/**
 * A value of 0 disables the new policy. Enabled values are deliberately capped
 * at one second so the three network queues plus the listener's two-second
 * buffer cannot exceed Glotta's five-second application-owned latency budget.
 */
export function parseLiveEdgeMaxQueueSeconds(value) {
  if (value === undefined || value === null || value === '') return 0;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  return Math.min(MAX_LIVE_EDGE_QUEUE_SECONDS, Math.max(MIN_LIVE_EDGE_QUEUE_SECONDS, seconds));
}

export const LIVE_EDGE_MAX_QUEUE_SECONDS = parseLiveEdgeMaxQueueSeconds(
  process.env.LIVE_EDGE_MAX_QUEUE_SECONDS,
);

/** Approximate bytes queued by base64 PCM plus its JSON WebSocket envelope. */
export function encodedPcmBytesPerSecond(sampleRate) {
  const rawPcmBytes = sampleRate * 2; // signed 16-bit mono
  const base64Bytes = Math.ceil(rawPcmBytes * 4 / 3);
  return base64Bytes + (AUDIO_CHUNKS_PER_SECOND * JSON_ENVELOPE_BYTES_PER_CHUNK);
}

export function audioBufferLimitBytes(sampleRate, maxQueueSeconds, legacyLimitBytes) {
  if (!(maxQueueSeconds > 0)) return legacyLimitBytes;
  return Math.ceil(encodedPcmBytesPerSecond(sampleRate) * maxQueueSeconds);
}

export function pendingAudioChunkLimit(maxQueueSeconds, legacyChunkLimit = 15) {
  if (!(maxQueueSeconds > 0)) return legacyChunkLimit;
  return Math.max(1, Math.min(legacyChunkLimit, Math.floor(maxQueueSeconds * AUDIO_CHUNKS_PER_SECOND)));
}

export function estimateQueuedAudioMs(bufferedBytes, sampleRate) {
  if (!Number.isFinite(bufferedBytes) || bufferedBytes <= 0) return 0;
  return Math.round((bufferedBytes / encodedPcmBytesPerSecond(sampleRate)) * 1000);
}

export function logAudioMetric(metric) {
  console.log(`[audio-metrics] ${JSON.stringify({
    ts: new Date().toISOString(),
    ...metric,
  })}`);
}
