import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FAST_RECONNECT_ATTEMPTS,
  SLOW_RECONNECT_DELAY_MS,
  isFirstSlowReconnect,
  reconnectDelayMs,
} from '../src/reconnectPolicy.js';

test('provider streams retry quickly and then continue slowly until closed', () => {
  assert.equal(FAST_RECONNECT_ATTEMPTS, 5);
  assert.deepEqual(
    [1, 2, 3, 4, 5].map(reconnectDelayMs),
    [1_000, 2_000, 4_000, 8_000, 10_000],
  );
  assert.equal(reconnectDelayMs(6), SLOW_RECONNECT_DELAY_MS);
  assert.equal(reconnectDelayMs(100), SLOW_RECONNECT_DELAY_MS);
  assert.equal(isFirstSlowReconnect(6), true);
  assert.equal(isFirstSlowReconnect(7), false);
});
