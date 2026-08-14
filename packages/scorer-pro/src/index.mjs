// @e4/post-scorer-pro — PAID tier. Requires a valid license key.
//
// Builds on the free @e4/post-scorer core and adds the value that costs money to
// run and is hard to copy:
//   - LLM engagement prediction (blended with the free feature priors) for a
//     more accurate score,
//   - WRITTEN suggestions + critique (the "how" the free tier withholds),
//   - the iterate-to-maximize auto-optimizer.
//
// Bring your own LLM (inject an adapter). Every entry point asserts a license.
//
//   import { evaluatePro, optimizePost } from '@e4/post-scorer-pro';
//   const r = await evaluatePro('draft', { llm, licenseKey });   // full suggestions
//   const best = await optimizePost('draft', { llm, licenseKey, constraints });

import { extractFeatures } from '../../scorer/src/platforms/x/features.mjs';
import { featurePriors, scorePost } from '../../scorer/src/platforms/x/score.mjs';
import { predict } from './predict.mjs';
import { buildSuggestions } from './suggest.mjs';
import { optimizePost as optimizeLoop } from './optimize.mjs';
import { assertLicensed } from './license.mjs';

function assertPlatform(platform) {
  if (platform !== 'x') throw new Error(`Unsupported platform "${platform}".`);
}

// Internal: run the LLM+heuristic pass once, returning the raw pieces so the
// grade (free) and the fixes (paid) can be assembled without scoring twice.
async function computeGrade(input, { llm } = {}) {
  const features = extractFeatures(input);
  const { probs, notes, source, error } = await predict(features, llm);
  const base = scorePost(features, probs, notes);
  return { base, notes, features, source, error };
}

// Single-shot grade assembly.
async function gradeOnce(input, { llm } = {}) {
  const { base, notes, features, source, error } = await computeGrade(input, { llm });
  return {
    ...base,
    critique: notes.critique || null,
    features,
    tier: 'free',
    predictionSource: source,
    ...(error ? { predictionError: error } : {}),
  };
}

// ---- FREE-EVERYWHERE grader (NO license) --------------------------------
// The grade must be identical regardless of plan: an LLM-informed score,
// subscores, named issues, and the one-line critique (diagnosis). What it
// deliberately withholds is the WRITTEN fixes + the rewriter — those are the
// paid tools below. Ungated on purpose; run it server-side with the operator's
// key so every user (licensed or not) gets the same accurate number.
//
// `samples` (>1) stabilizes the number: the score is Σ(weight × P(action)) and
// the LLM's probability estimates jitter between calls, so a single sample can
// swing the score tens of points on a borderline post. Sampling N times and
// returning the median-BY-SCORE run gives a representative grade whose
// subscores + critique all come from that one run (internally consistent).
// Only meaningful with an llm — the deterministic path is already reproducible.
export async function gradeWithLlm(input, { platform = 'x', llm, samples = 1 } = {}) {
  assertPlatform(platform);
  if (!llm || samples <= 1) return gradeOnce(input, { llm });
  const runs = await Promise.all(Array.from({ length: samples }, () => gradeOnce(input, { llm })));
  runs.sort((a, b) => a.score - b.score);
  return runs[Math.floor((runs.length - 1) / 2)]; // lower-median on an even count
}

// ---- PAID cores (NO license check here) ---------------------------------
// These carry the money features. Callers that reach them directly (the API
// Worker) MUST have authorized the request themselves; the licensed wrappers
// below are the path for direct package/CLI consumers.
export async function suggestFixesUnchecked(input, { platform = 'x', llm } = {}) {
  assertPlatform(platform);
  const { base, notes, features, source, error } = await computeGrade(input, { llm });
  return {
    ...base,
    suggestions: buildSuggestions(base.issues, notes),
    critique: notes.critique || null,
    features,
    tier: 'pro',
    predictionSource: source,
    ...(error ? { predictionError: error } : {}),
  };
}

export async function optimizeUnchecked(input, { platform = 'x', llm, ...rest } = {}) {
  assertPlatform(platform);
  const evaluate = (inp, opts) => suggestFixesUnchecked(inp, opts);
  return optimizeLoop(input, { evaluate, llm, ...rest });
}

// ---- Licensed wrappers (CLI / direct package use) -----------------------
// Public: evaluate with full paid output. options: { platform='x', llm, licenseKey }
export async function evaluatePro(input, { platform = 'x', llm, licenseKey } = {}) {
  assertLicensed(licenseKey);
  return suggestFixesUnchecked(input, { platform, llm });
}

// Public: iterate the post toward a target score. options forwarded to the loop
// (constraints, targetScore, maxIterations, minGain, patience), plus { platform, llm, licenseKey }.
export async function optimizePost(input, { platform = 'x', llm, licenseKey, ...rest } = {}) {
  assertLicensed(licenseKey);
  return optimizeUnchecked(input, { platform, llm, ...rest });
}

export { verifyLicenseKey, verifyLicenseKeyWebCrypto, resolveLicenseKey } from './license.mjs';
export { fromGeminiFn, fromGeminiKey, fromAnthropic, fromOpenAICompatible } from './provider.mjs';
