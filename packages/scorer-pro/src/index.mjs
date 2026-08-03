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

// Internal: full evaluation with no license check (callers must have asserted).
async function evaluateProUnchecked(input, { llm } = {}) {
  const features = extractFeatures(input);
  const { probs, notes, source, error } = await predict(features, llm);
  const base = scorePost(features, probs, notes);
  const suggestions = buildSuggestions(base.issues, notes);
  return {
    ...base,
    suggestions,
    critique: notes.critique || null,
    features,
    tier: 'pro',
    predictionSource: source,
    ...(error ? { predictionError: error } : {}),
  };
}

// Public: evaluate with full paid output. options: { platform='x', llm, licenseKey }
export async function evaluatePro(input, { platform = 'x', llm, licenseKey } = {}) {
  if (platform !== 'x') throw new Error(`Unsupported platform "${platform}".`);
  assertLicensed(licenseKey);
  return evaluateProUnchecked(input, { llm });
}

// Public: iterate the post toward a target score. options forwarded to the loop
// (constraints, targetScore, maxIterations, minGain), plus { platform, llm, licenseKey }.
export async function optimizePost(input, { platform = 'x', llm, licenseKey, ...rest } = {}) {
  if (platform !== 'x') throw new Error(`Unsupported platform "${platform}".`);
  assertLicensed(licenseKey);
  // License asserted once; the loop's per-iteration evaluate skips re-checking.
  const evaluate = (inp, opts) => evaluateProUnchecked(inp, opts);
  return optimizeLoop(input, { evaluate, llm, ...rest });
}

export { verifyLicenseKey, resolveLicenseKey } from './license.mjs';
export { fromGeminiFn, fromAnthropic, fromOpenAICompatible } from './provider.mjs';
