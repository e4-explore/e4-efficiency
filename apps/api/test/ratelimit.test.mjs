import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRateLimiter } from '../src/ratelimit.mjs';

test('allows up to max in a window, then blocks with a retryAfter', () => {
  let t = 0;
  const rl = createRateLimiter({ windowMs: 1000, max: 2, now: () => t });
  assert.equal(rl.check('a').allowed, true);
  assert.equal(rl.check('a').allowed, true);
  const blocked = rl.check('a');
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfter >= 1);
});

test('resets after the window elapses', () => {
  let t = 0;
  const rl = createRateLimiter({ windowMs: 1000, max: 1, now: () => t });
  assert.equal(rl.check('a').allowed, true);
  assert.equal(rl.check('a').allowed, false);
  t = 1000;
  assert.equal(rl.check('a').allowed, true);
});

test('tracks keys independently', () => {
  let t = 0;
  const rl = createRateLimiter({ windowMs: 1000, max: 1, now: () => t });
  assert.equal(rl.check('a').allowed, true);
  assert.equal(rl.check('b').allowed, true);
});
