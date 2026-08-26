import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SPEAKER_TRANSCRIPT_STALL_MS,
  TranscriptWatchdog,
} from '../src/transcriptWatchdog.js';

test('speaker transcript watchdog ignores silence and an unavailable stream', () => {
  const watchdog = new TranscriptWatchdog();
  const chunksToThreshold = SPEAKER_TRANSCRIPT_STALL_MS / 100;

  for (let i = 0; i < chunksToThreshold * 2; i += 1) {
    assert.equal(watchdog.recordAudio({ speechDetected: false, streamReady: true }), null);
    assert.equal(watchdog.recordAudio({ speechDetected: true, streamReady: false }), null);
  }
});

test('speaker transcript watchdog fires after 20 seconds of voiced audio', () => {
  let now = 1_000;
  const watchdog = new TranscriptWatchdog({ now: () => now });
  const chunksToThreshold = SPEAKER_TRANSCRIPT_STALL_MS / 100;

  for (let i = 1; i < chunksToThreshold; i += 1) {
    now += 100;
    assert.equal(watchdog.recordAudio({ speechDetected: true, streamReady: true }), null);
  }
  now += 100;
  assert.deepEqual(
    watchdog.recordAudio({ speechDetected: true, streamReady: true }),
    { voicedAudioMs: SPEAKER_TRANSCRIPT_STALL_MS, elapsedSinceOutputMs: SPEAKER_TRANSCRIPT_STALL_MS },
  );
});

test('new transcript resets accumulated voiced audio', () => {
  const watchdog = new TranscriptWatchdog({ stallMs: 500, chunkMs: 100 });

  for (let i = 0; i < 4; i += 1) {
    assert.equal(watchdog.recordAudio({ speechDetected: true, streamReady: true }), null);
  }
  watchdog.recordTranscript();
  for (let i = 0; i < 4; i += 1) {
    assert.equal(watchdog.recordAudio({ speechDetected: true, streamReady: true }), null);
  }
  assert.ok(watchdog.recordAudio({ speechDetected: true, streamReady: true }));
});

test('generic output resets accumulated voiced audio for listener streams', () => {
  const watchdog = new TranscriptWatchdog({ stallMs: 300, chunkMs: 100 });

  assert.equal(watchdog.recordAudio({ speechDetected: true, streamReady: true }), null);
  assert.equal(watchdog.recordAudio({ speechDetected: true, streamReady: true }), null);
  watchdog.recordOutput();
  assert.equal(watchdog.recordAudio({ speechDetected: true, streamReady: true }), null);
  assert.equal(watchdog.recordAudio({ speechDetected: true, streamReady: true }), null);
  assert.ok(watchdog.recordAudio({ speechDetected: true, streamReady: true }));
});
