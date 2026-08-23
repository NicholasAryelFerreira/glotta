import assert from 'node:assert/strict';
import test from 'node:test';

test('continuous PCM player preserves waveform continuity across chunks', async () => {
  let Processor;
  globalThis.sampleRate = 48_000;
  globalThis.AudioWorkletProcessor = class {
    constructor() {
      this.port = { onmessage: null };
    }
  };
  globalThis.registerProcessor = (name, constructor) => {
    assert.equal(name, 'pcm-stream-player');
    Processor = constructor;
  };

  await import(`../public/listener-player.js?test=${Date.now()}`);
  const player = new Processor();
  const source = new Float32Array(12_000);
  for (let i = 0; i < source.length; i += 1) {
    source[i] = 0.4 * Math.sin((2 * Math.PI * 440 * i) / 24_000);
  }

  for (let start = 0; start < source.length; start += 2_400) {
    player.port.onmessage({
      data: { type: 'audio', samples: source.slice(start, start + 2_400) },
    });
  }

  const rendered = [];
  for (let block = 0; block < 210; block += 1) {
    const output = new Float32Array(128);
    player.process([], [[output]]);
    rendered.push(...output);
  }

  let peak = 0;
  let maxJump = 0;
  for (let i = 1; i < rendered.length; i += 1) {
    assert.ok(Number.isFinite(rendered[i]));
    peak = Math.max(peak, Math.abs(rendered[i]));
    maxJump = Math.max(maxJump, Math.abs(rendered[i] - rendered[i - 1]));
  }

  assert.ok(peak > 0.3, `expected audible output, got peak ${peak}`);
  assert.ok(maxJump < 0.05, `unexpected playback discontinuity ${maxJump}`);
});

test('configured listener buffer drops oldest audio beyond two seconds', async () => {
  let Processor;
  const postedMetrics = [];
  globalThis.sampleRate = 48_000;
  globalThis.AudioWorkletProcessor = class {
    constructor() {
      this.port = {
        onmessage: null,
        postMessage(message) { postedMetrics.push(message); },
      };
    }
  };
  globalThis.registerProcessor = (_name, constructor) => { Processor = constructor; };

  await import(`../public/listener-player.js?buffer-test=${Date.now()}`);
  const player = new Processor();
  player.port.onmessage({ data: { type: 'configure', maxBufferSeconds: 2 } });
  player.port.onmessage({ data: { type: 'audio', samples: new Float32Array(72_000) } });

  assert.ok(player.available <= 48_000, `expected at most two seconds, got ${player.available / 24_000}s`);
  assert.equal(postedMetrics.at(-1)?.type, 'audio-metrics');
  assert.ok(postedMetrics.at(-1)?.droppedMs >= 1_000);
});
