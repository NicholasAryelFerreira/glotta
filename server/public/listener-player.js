const SOURCE_SAMPLE_RATE = 24_000;
const PREBUFFER_SECONDS = 0.25;
const BUFFER_CAPACITY_SECONDS = 4;
const FADE_SECONDS = 0.006;

/**
 * Continuous PCM player for Gemini's 24 kHz mono output.
 *
 * Gemini delivers many small PCM chunks. Playing each chunk with a separate
 * AudioBufferSourceNode can introduce a discontinuity whenever network jitter
 * makes the schedule run short. This processor keeps one continuous output
 * lane, resamples across chunk boundaries, and fades cleanly to silence only
 * when the stream genuinely runs dry.
 */
class PCMStreamPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.capacity = SOURCE_SAMPLE_RATE * BUFFER_CAPACITY_SECONDS;
    this.buffer = new Float32Array(this.capacity);
    this.readIndex = 0;
    this.writeIndex = 0;
    this.available = 0;
    this.readPhase = 0;
    this.playing = false;
    this.fadeGain = 0;
    this.tailSample = 0;
    this.prebufferSamples = Math.round(SOURCE_SAMPLE_RATE * PREBUFFER_SECONDS);
    this.fadeStep = 1 / Math.max(1, Math.round(sampleRate * FADE_SECONDS));

    this.port.onmessage = (event) => {
      const message = event.data || {};
      if (message.type === 'clear') {
        this.clear(true);
      } else if (message.type === 'audio' && message.samples) {
        this.push(message.samples);
      }
    };
  }

  clear(preserveTail = false) {
    this.readIndex = 0;
    this.writeIndex = 0;
    this.available = 0;
    this.readPhase = 0;
    this.playing = false;
    this.fadeGain = 0;
    if (!preserveTail) this.tailSample = 0;
  }

  drop(samples) {
    const count = Math.min(samples, this.available);
    this.readIndex = (this.readIndex + count) % this.capacity;
    this.available -= count;
    this.readPhase = 0;
  }

  push(rawSamples) {
    let samples = rawSamples instanceof Float32Array ? rawSamples : new Float32Array(rawSamples);
    if (samples.length >= this.capacity) {
      samples = samples.subarray(samples.length - this.capacity + 1);
      this.clear(true);
    }

    // Stay near the live edge if a suspended/backgrounded page accumulated
    // more data than the ring can hold.
    const overflow = this.available + samples.length - this.capacity;
    if (overflow > 0) {
      this.drop(overflow);
      this.playing = false;
      this.fadeGain = 0;
    }

    const first = Math.min(samples.length, this.capacity - this.writeIndex);
    this.buffer.set(samples.subarray(0, first), this.writeIndex);
    if (first < samples.length) this.buffer.set(samples.subarray(first), 0);
    this.writeIndex = (this.writeIndex + samples.length) % this.capacity;
    this.available += samples.length;
  }

  process(_inputs, outputs) {
    const output = outputs[0]?.[0];
    if (!output) return true;
    output.fill(0);

    if (!this.playing && this.available >= this.prebufferSamples) {
      this.playing = true;
      this.fadeGain = 0;
      this.tailSample = 0;
    }

    const sourceStep = SOURCE_SAMPLE_RATE / sampleRate;
    for (let i = 0; i < output.length; i += 1) {
      if (this.playing && this.available >= 2) {
        const nextIndex = nextIndexFor(this.readIndex, this.capacity);
        const current = this.buffer[this.readIndex];
        const next = this.buffer[nextIndex];
        const sample = current + (next - current) * this.readPhase;
        this.fadeGain = Math.min(1, this.fadeGain + this.fadeStep);
        output[i] = sample * this.fadeGain;
        this.tailSample = output[i];

        this.readPhase += sourceStep;
        while (this.readPhase >= 1 && this.available > 1) {
          this.readPhase -= 1;
          this.readIndex = nextIndexFor(this.readIndex, this.capacity);
          this.available -= 1;
        }
      } else {
        this.playing = false;
        this.fadeGain = 0;
        // Avoid cutting a non-zero waveform directly to silence.
        this.tailSample *= 0.94;
        if (Math.abs(this.tailSample) < 0.00001) this.tailSample = 0;
        output[i] = this.tailSample;
      }
    }
    return true;
  }
}

function nextIndexFor(index, capacity) {
  return index + 1 === capacity ? 0 : index + 1;
}

registerProcessor('pcm-stream-player', PCMStreamPlayer);
