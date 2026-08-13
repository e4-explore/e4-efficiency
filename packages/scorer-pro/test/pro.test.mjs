import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluatePro, optimizePost, verifyLicenseKey } from '../src/index.mjs';

// A license signed by the embedded PRODUCTION public key. In real use this comes
// from POST_SCORER_LICENSE_KEY. If the key is rotated, re-sign with
// scripts/sign-license.mjs (POST_SCORER_SIGNING_KEY=<private pem>) and update this.
const DEV_LICENSE = 'v1.eyJzdWIiOiJlNC1leHBsb3JlLW93bmVyIiwicGxhbiI6InBybyIsImlhdCI6MTc4NTczNzAwMX0.H_mfGyUmZa5lbHrOeXJGwAsKkouGETviQ6Ym3tzGsR4X44pa-rRinIWvxWtuBiphSEPFBWw4aCYuj22y1mRJDA';

// Stub LLM (no network): predicts probabilities + notes, and rewrites on demand.
const stubLlm = async (prompt) => {
  if (/Rewrite the post/.test(prompt)) return { post_text: 'cut onboarding from 3 minutes to 30 seconds. what is the slowest step in your own signup?', rationale: 'tighter' };
  return { probabilities: { like: 0.28, reply: 0.16, quote: 0.05, shareViaCopyLink: 0.04, shareViaDm: 0.03, followAuthor: 0.02, click: 0.16, bidiFollowReplyBoost: 0.03, report: 0.001 }, hookStrength: 0.85, clarity: 0.85, critique: 'lead with the number', suggestions: ['open with the concrete metric'] };
};

test('the embedded dev license verifies', () => {
  const res = verifyLicenseKey(DEV_LICENSE);
  assert.equal(res.valid, true);
  assert.equal(res.plan, 'pro');
});

test('a tampered license fails', () => {
  assert.equal(verifyLicenseKey(DEV_LICENSE.slice(0, -4) + 'AAAA').valid, false);
  assert.equal(verifyLicenseKey('').valid, false);
  assert.equal(verifyLicenseKey('garbage').valid, false);
});

test('evaluatePro throws UNLICENSED without a key', async () => {
  delete process.env.POST_SCORER_LICENSE_KEY;
  await assert.rejects(() => evaluatePro('a draft', { llm: stubLlm }), (e) => e.code === 'UNLICENSED');
});

test('evaluatePro returns written suggestions + critique when licensed', async () => {
  const r = await evaluatePro('we updated the onboarding flow to make it faster', { llm: stubLlm, licenseKey: DEV_LICENSE });
  assert.equal(r.tier, 'pro');
  assert.equal(r.predictionSource, 'hybrid');
  assert.ok(r.suggestions.length > 0);
  assert.ok(r.suggestions.every((s) => typeof s.text === 'string' && s.text.length));
  assert.equal(r.critique, 'lead with the number');
});

test('optimizePost iterates higher when licensed', async () => {
  const r = await optimizePost(
    { text: 'we updated the onboarding flow to make it faster', hasMedia: true, mediaType: 'image' },
    { llm: stubLlm, licenseKey: DEV_LICENSE, targetScore: 92, maxIterations: 2 },
  );
  assert.ok(r.best.evaluation.score >= r.iterations[0].score);
  assert.ok(r.best.text.length > 0);
});

test('optimizePost throws UNLICENSED without a key', async () => {
  delete process.env.POST_SCORER_LICENSE_KEY;
  await assert.rejects(() => optimizePost('draft', { llm: stubLlm }), (e) => e.code === 'UNLICENSED');
});
