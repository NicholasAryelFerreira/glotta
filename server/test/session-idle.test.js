import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionManager } from '../src/sessionManager.js';

test('session closes only after 60 minutes without speaker audio', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const manager = new SessionManager('test-key');
  const session = manager.create({ id: 'IDLE60', title: 'Idle timer test' });

  context.mock.timers.tick(59 * 60_000);
  assert.equal(manager.get(session.id), session);

  context.mock.timers.tick(60_000);
  assert.equal(manager.get(session.id), undefined);
});
