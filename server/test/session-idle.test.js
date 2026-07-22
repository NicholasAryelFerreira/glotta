import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeApiTier, SessionManager } from '../src/sessionManager.js';

test('session closes only after 60 minutes without speaker audio', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const manager = new SessionManager('test-key');
  const session = manager.create({ id: 'IDLE60', title: 'Idle timer test' });

  context.mock.timers.tick(59 * 60_000);
  assert.equal(manager.get(session.id), session);

  context.mock.timers.tick(60_000);
  assert.equal(manager.get(session.id), undefined);
});

test('sessions use the selected Gemini key and otherwise default to free', () => {
  const manager = new SessionManager({
    free: 'free-test-key',
    paid: 'paid-test-key',
  });
  const defaultSession = manager.create({ id: 'FREE01' });
  const paidSession = manager.create({ id: 'PAID01', apiTier: 'paid' });
  const unexpectedSession = manager.create({ id: 'SAFE01', apiTier: 'PAID' });

  try {
    assert.equal(defaultSession.apiTier, 'free');
    assert.equal(defaultSession.apiKey, 'free-test-key');
    assert.equal(paidSession.apiTier, 'paid');
    assert.equal(paidSession.apiKey, 'paid-test-key');
    assert.equal(unexpectedSession.apiTier, 'free');
    assert.equal(unexpectedSession.apiKey, 'free-test-key');
    assert.equal(normalizeApiTier(undefined), 'free');
  } finally {
    defaultSession.end('test complete');
    paidSession.end('test complete');
    unexpectedSession.end('test complete');
  }
});
