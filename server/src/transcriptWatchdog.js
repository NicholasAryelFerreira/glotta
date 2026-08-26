export const SPEAKER_AUDIO_CHUNK_MS = 100;
export const SPEAKER_TRANSCRIPT_STALL_MS = 20_000;

/**
 * Counts voiced speaker audio since Gemini last emitted input transcription.
 * Wall-clock silence does not advance the watchdog, so a quiet room cannot
 * cause unnecessary reconnects.
 */
export class TranscriptWatchdog {
  constructor({
    stallMs = SPEAKER_TRANSCRIPT_STALL_MS,
    chunkMs = SPEAKER_AUDIO_CHUNK_MS,
    now = () => Date.now(),
  } = {}) {
    this.stallMs = stallMs;
    this.chunkMs = chunkMs;
    this.now = now;
    this.reset();
  }

  reset() {
    this.voicedAudioMs = 0;
    this.lastTranscriptAt = this.now();
  }

  recordTranscript() {
    this.reset();
  }

  recordAudio({ speechDetected, streamReady }) {
    if (!speechDetected || !streamReady) return null;
    this.voicedAudioMs += this.chunkMs;
    if (this.voicedAudioMs < this.stallMs) return null;

    const stalled = {
      voicedAudioMs: this.voicedAudioMs,
      elapsedSinceTranscriptMs: Math.max(0, this.now() - this.lastTranscriptAt),
    };
    this.reset();
    return stalled;
  }
}
