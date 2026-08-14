import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluatePro, optimizePost, gradeWithLlm, verifyLicenseKey } from '../src/index.mjs';

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

test('gradeWithLlm returns an LLM grade with NO license, and withholds written fixes', async () => {
  delete process.env.POST_SCORER_LICENSE_KEY;
  const r = await gradeWithLlm('we updated the onboarding flow to make it faster', { llm: stubLlm });
  assert.equal(r.tier, 'free');
  assert.equal(r.predictionSource, 'hybrid'); // the SAME LLM grade paid users get
  assert.equal(typeof r.score, 'number');
  assert.equal(typeof r.subscores.hook, 'number');
  assert.equal(r.critique, 'lead with the number'); // critique (diagnosis) is free
  assert.equal(r.suggestions, undefined); // written fixes are NOT free
});

test('gradeWithLlm works with no llm (deterministic, still ungated)', async () => {
  const r = await gradeWithLlm('a plain post with no question in it at all');
  assert.equal(r.predictionSource, 'features');
  assert.equal(typeof r.score, 'number');
  assert.equal(r.suggestions, undefined);
});

test('optimizer keeps trying after a non-improving rewrite (patience)', async () => {
  let n = 0;
  const strong = 'what should i automate next? tell me your worst task.';
  const llm = async (prompt) => {
    if (/Rewrite the post/.test(prompt)) {
      n += 1;
      // First draft is deliberately weak (long, crammed, no question → lower
      // score); the second is strong. Pre-fix, the loop quit after the first
      // miss and never reached the winning draft.
      return { post_text: n === 1 ? `marketing update ${'x'.repeat(240)}` : strong, rationale: 'r' };
    }
    return { probabilities: { like: 0.2, reply: 0.1 }, hookStrength: 0.7, clarity: 0.7, critique: 'weak', suggestions: [] };
  };
  const r = await optimizePost(
    { text: 'we shipped onboarding improvements today', hasMedia: false, mediaType: null },
    { llm, licenseKey: DEV_LICENSE, targetScore: 100, maxIterations: 2, minGain: 1, patience: 3 },
  );
  assert.equal(n, 2, 'made a second rewrite attempt instead of bailing on the first miss');
  assert.ok(r.improved, 'captured the later improving rewrite');
  assert.equal(r.best.text, strong);
});

test('gradeWithLlm samples>1 returns the median-by-score run (stabilizer)', async () => {
  // A stub whose returned like-probability (which drives the score) follows a
  // fixed sequence, so we can predict which sample is the median.
  const stubWithLikes = (likes) => {
    let i = 0;
    return async (prompt) => {
      if (/Rewrite the post/.test(prompt)) return { post_text: 'x', rationale: 'r' };
      const like = likes[Math.min(i++, likes.length - 1)];
      return { probabilities: { like }, hookStrength: 0.6, clarity: 0.6, critique: 'c', suggestions: [] };
    };
  };
  const scoreFor = async (like) => (await gradeWithLlm('a plain test post here', { llm: stubWithLikes([like]) })).score;
  const s = [await scoreFor(0.05), await scoreFor(0.9), await scoreFor(0.4)];
  const median = [...s].sort((a, b) => a - b)[1];
  const r = await gradeWithLlm('a plain test post here', { llm: stubWithLikes([0.05, 0.9, 0.4]), samples: 3 });
  assert.equal(r.score, median, `expected median ${median} of ${JSON.stringify(s)}, got ${r.score}`);
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

test('scoring runs cooler than rewriting (split temperature)', async () => {
  const seen = { score: null, rewrite: null };
  const recordingLlm = async (prompt, opts = {}) => {
    if (/Rewrite the post/.test(prompt)) {
      seen.rewrite = opts.temperature;
      return { post_text: 'cut signup from 3 minutes to 30 seconds. what is the slowest step in yours?', rationale: 'tighter' };
    }
    seen.score = opts.temperature;
    return { probabilities: { like: 0.2, reply: 0.12, replyEngagedByAuthor: 0.06 }, hookStrength: 0.8, clarity: 0.8, critique: 'c', suggestions: ['s'] };
  };
  await optimizePost(
    { text: 'we updated the onboarding flow to make it faster', hasMedia: true, mediaType: 'image' },
    // targetScore above the 0-100 range so a rewrite attempt always fires,
    // independent of what the stub happens to score under the current weights.
    { llm: recordingLlm, licenseKey: DEV_LICENSE, targetScore: 101, maxIterations: 1 },
  );
  assert.equal(typeof seen.score, 'number', 'scoring call received a temperature');
  assert.equal(typeof seen.rewrite, 'number', 'rewrite call received a temperature');
  assert.ok(seen.score < seen.rewrite, `scoring temp ${seen.score} should be < rewrite temp ${seen.rewrite}`);
});

test('optimizePost throws UNLICENSED without a key', async () => {
  delete process.env.POST_SCORER_LICENSE_KEY;
  await assert.rejects(() => optimizePost('draft', { llm: stubLlm }), (e) => e.code === 'UNLICENSED');
});
