import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate } from '../src/platforms/x/index.mjs';
import { reachMultiplier, lengthFactor, expectedValue } from '../src/platforms/x/score.mjs';
import { extractFeatures } from '../src/platforms/x/features.mjs';

test('deterministic evaluate returns a bounded score, subscores, and issues (no fix text)', async () => {
  const r = await evaluate('updated the settings page today');
  assert.ok(r.score >= 0 && r.score <= 100);
  for (const v of Object.values(r.subscores)) assert.ok(v >= 0 && v <= 100);
  assert.equal(r.tier, 'free');
  assert.ok(Array.isArray(r.issues));
  // Free tier withholds the "how": issues carry lever/subscore/severity, no text.
  for (const i of r.issues) {
    assert.ok(i.lever && i.subscore && i.severity);
    assert.equal(i.text, undefined);
  }
  assert.equal(r.fixesAvailable, r.issues.length);
});

test('a body link shows up as a reach lever and lowers the multiplier', () => {
  const withLink = reachMultiplier(extractFeatures('great read https://example.com'));
  const without = reachMultiplier(extractFeatures('great read, no link here'));
  assert.ok(withLink.multiplier < without.multiplier);
  assert.ok(withLink.levers.some((l) => l.lever === 'body-link' && l.subscore === 'reach'));
});

test('a reply-less post flags a high-severity reply-bait issue', async () => {
  const r = await evaluate('updated the settings page today');
  assert.ok(r.issues.some((i) => i.lever === 'reply-bait' && i.severity === 'high'));
});

test('media boosts reach; video boosts more than image', () => {
  const none = reachMultiplier(extractFeatures({ text: 'x'.repeat(80) })).multiplier;
  const img = reachMultiplier(extractFeatures({ text: 'x'.repeat(80), hasMedia: true, mediaType: 'image' })).multiplier;
  const vid = reachMultiplier(extractFeatures({ text: 'x'.repeat(80), hasMedia: true, mediaType: 'video' })).multiplier;
  assert.ok(img > none);
  assert.ok(vid > img);
});

test('excess hashtags penalize reach and carry a count', () => {
  const spammy = reachMultiplier(extractFeatures('shipping a feature #build #ship #dev #code #oss'));
  const clean = reachMultiplier(extractFeatures('shipping a feature #build'));
  assert.ok(spammy.multiplier < clean.multiplier);
  const tag = spammy.levers.find((l) => l.lever === 'hashtags');
  assert.ok(tag && tag.count >= 1);
});

test('length factor peaks in the ideal band and flags a lever when off', () => {
  assert.equal(lengthFactor(extractFeatures('x'.repeat(120))).factor, 1);
  assert.equal(lengthFactor(extractFeatures('short')).lever, 'length-thin');
  assert.ok(lengthFactor(extractFeatures('x'.repeat(275))).factor < 1);
});

test('a reply-inviting post scores at least as high as a flat one', async () => {
  const flat = await evaluate('updated the settings page today');
  const baity = await evaluate('rebuilt the settings page. what setting do you always change first?');
  assert.ok(baity.score >= flat.score);
});

test('negative-feedback probability drags net expected value down', () => {
  // report is the heaviest published negative weight (−234).
  const safe = expectedValue({ like: 0.2, reply: 0.05, report: 0 });
  const risky = expectedValue({ like: 0.2, reply: 0.05, report: 0.01 });
  assert.ok(risky.net < safe.net);
  // A 1% predicted report should swamp a healthy like+reply upside.
  assert.ok(risky.net < 0);
});
