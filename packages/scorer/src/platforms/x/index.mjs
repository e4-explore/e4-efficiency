// X (Twitter) platform scorer — FREE tier: the deterministic evaluate().
// Pipeline: extract features -> feature-only engagement priors -> score into a
// 0–100 + subscores + NAMED ISSUES (which levers are weak). No LLM, no network,
// no fix text: the written suggestions and the auto-optimizer are the paid tier
// (@e4/post-scorer-pro), which builds on the exports here.

import { extractFeatures } from './features.mjs';
import { featurePriors, scorePost } from './score.mjs';

export const platform = 'x';

// Evaluate a post for X (deterministic).
//   input: a string, or { text, hasMedia, mediaType, hasLinkInReply }
// Returns score + subscores + issues (named, no fix text) + the resolved
// features (pro reuses these to add LLM prediction and written guidance).
export async function evaluate(input) {
  const features = extractFeatures(input);
  const probs = featurePriors(features);
  const result = scorePost(features, probs);
  return { ...result, features, tier: 'free', predictionSource: 'features' };
}

export { extractFeatures } from './features.mjs';
export { scorePost, featurePriors, reachMultiplier, lengthFactor, expectedValue, postingStrategyNotes } from './score.mjs';
export { SCORE_ADJUSTMENTS } from './weights.mjs';
