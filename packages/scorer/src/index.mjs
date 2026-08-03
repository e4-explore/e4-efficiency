// @e4/post-scorer — FREE core, public.
//
// Score a social post the way the target platform's algorithm would, before you
// publish. Clean-room from documented signals; X (Twitter) first. Deterministic
// and dependency-free: returns a 0–100 score, subscores, and the NAMED ISSUES
// holding the post back (which levers are weak) — the diagnosis.
//
// The written fixes for those issues and the iterate-to-maximize auto-optimizer
// are the paid tier, @e4/post-scorer-pro, which builds on this package.
//
//   import { evaluatePost } from '@e4/post-scorer';
//   const r = await evaluatePost('my draft', { platform: 'x' });
//   // r.score, r.subscores, r.issues[], r.fixesAvailable

import * as x from './platforms/x/index.mjs';

// Bumped when weights/heuristics change, so recorded predictions can be traced
// to the model that produced them (keep in step with package.json).
export const VERSION = '0.1.0';

const PLATFORMS = { x };

export function getPlatform(name = 'x') {
  const p = PLATFORMS[name];
  if (!p) throw new Error(`Unknown platform "${name}". Available: ${Object.keys(PLATFORMS).join(', ')}.`);
  return p;
}

// Evaluate a post (deterministic, free). options: { platform = 'x' }
export function evaluatePost(input, { platform = 'x' } = {}) {
  return getPlatform(platform).evaluate(input);
}

export { PLATFORMS };
