import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ANOMALY_METRIC_LOG_INTERVAL_MS,
  HEALTH_METRIC_LOG_INTERVAL_MS,
  LIVE_EDGE_LISTENER_MAX_BUFFER_SECONDS,
  audioBufferLimitBytes,
  encodedPcmBytesPerSecond,
  estimateQueuedAudioMs,
  parseLiveEdgeMaxQueueSeconds,
  pendingAudioChunkLimit,
} from '../src/liveEdge.js';

test('healthy telemetry is summarized less often than active anomalies', () => {
  assert.equal(HEALTH_METRIC_LOG_INTERVAL_MS, 60_000);
  assert.equal(ANOMALY_METRIC_LOG_INTERVAL_MS, 10_000);
});

function simulateDegradedUpload({ limitBytes, seconds = 30 }) {
  const bytesPerSecond = encodedPcmBytesPerSecond(16_000);
  const chunkBytes = Math.ceil(bytesPerSecond / 10);
  const drainPerChunk = Math.ceil(chunkBytes * 0.25); // connection carries only 25% of live audio
  let bufferedBytes = 0;
  let peakBufferedBytes = 0;
  let droppedChunks = 0;

  for (let chunk = 0; chunk < seconds * 10; chunk += 1) {
    bufferedBytes = Math.max(0, bufferedBytes - drainPerChunk);
    if (bufferedBytes > limitBytes) {
      droppedChunks += 1;
    } else {
      bufferedBytes += chunkBytes;
    }
    peakBufferedBytes = Math.max(peakBufferedBytes, bufferedBytes);
  }

  return {
    droppedChunks,
    peakQueuedMs: estimateQueuedAudioMs(peakBufferedBytes, 16_000),
  };
}

test('live-edge configuration is opt-in and cannot exceed one second per queue', () => {
  assert.equal(parseLiveEdgeMaxQueueSeconds(undefined), 0);
  assert.equal(parseLiveEdgeMaxQueueSeconds('0'), 0);
  assert.equal(parseLiveEdgeMaxQueueSeconds('1'), 1);
  assert.equal(parseLiveEdgeMaxQueueSeconds('5'), 1);
  assert.equal(parseLiveEdgeMaxQueueSeconds('invalid'), 0);
  assert.equal(pendingAudioChunkLimit(1), 10);
  assert.equal(pendingAudioChunkLimit(0), 15);
});

test('recommended policy keeps Glotta-owned buffering within five seconds', () => {
  const networkQueueCount = 3; // speaker upload, Gemini upload, listener delivery
  const maximumOwnedBufferSeconds = (networkQueueCount * parseLiveEdgeMaxQueueSeconds('1'))
    + LIVE_EDGE_LISTENER_MAX_BUFFER_SECONDS;
  assert.equal(maximumOwnedBufferSeconds, 5);
});

test('degraded network simulation reproduces legacy lag and caps flagged queue near one second', () => {
  const legacy = simulateDegradedUpload({ limitBytes: 512_000 });
  const liveEdge = simulateDegradedUpload({
    limitBytes: audioBufferLimitBytes(16_000, 1, 512_000),
  });

  assert.ok(legacy.peakQueuedMs > 5_000, `legacy queue reached only ${legacy.peakQueuedMs}ms`);
  assert.ok(liveEdge.peakQueuedMs <= 1_100, `flagged queue reached ${liveEdge.peakQueuedMs}ms`);
  assert.ok(liveEdge.droppedChunks > 0, 'expected brief dropped audio on a severely degraded link');
});
