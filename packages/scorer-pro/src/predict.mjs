// LLM engagement-probability predictor for X. The deterministic layer reads
// signals off the text; this layer judges the things only a reader can — is the
// hook strong, will this actually pull replies, is it risky enough to get muted.
// It returns per-action probabilities we blend with the feature priors, plus
// qualitative notes (hook, clarity, critique, suggestions).

import { featurePriors } from '../../scorer/src/platforms/x/score.mjs';
import { ACTION_WEIGHTS } from '../../scorer/src/platforms/x/weights.mjs';

const clamp01 = (n) => Math.max(0, Math.min(1, Number(n) || 0));

// How much to trust the LLM vs the feature prior when both exist. The prior is
// a stabilizer, so the LLM leads but can't run away on its own.
const LLM_WEIGHT = 0.7;

// Scoring must be reproducible: the same post should get the same grade every
// time, or the grader looks random. So the scoring call runs near-deterministic.
// (Rewriting is the opposite — it wants variety across attempts; see
// REWRITE_TEMPERATURE in optimize.mjs.) Adapters that honor a per-call
// `temperature` option (the bundled Gemini/Anthropic/OpenAI ones do) use this;
// any that ignore it simply keep their own default.
const SCORING_TEMPERATURE = 0.1;

function buildPrompt(features) {
  return `You are modeling how X's (Twitter's) current Grok/Phoenix recommendation model would treat this post. It predicts a probability for each action, then sums them times the ACTUAL published production weights (xai-org/x-algorithm param.rs). Those weights, from most to least valuable:
- share-via-copy-link ${ACTION_WEIGHTS.shareViaCopyLink} (the single biggest positive) — someone copies the link to send it
- a reply on your ORIGINAL from a mutual follower = reply ${ACTION_WEIGHTS.reply} + a ${ACTION_WEIGHTS.bidiFollowReplyBoost} boost = 20 (tied for biggest). Originals only; your own replies don't get the boost
- quote ${ACTION_WEIGHTS.quote}, any reply ${ACTION_WEIGHTS.reply}, share-via-DM ${ACTION_WEIGHTS.shareViaDm}
- follow-from-post ${ACTION_WEIGHTS.followAuthor}, share-button ${ACTION_WEIGHTS.share}, repost ${ACTION_WEIGHTS.retweet}
- like ${ACTION_WEIGHTS.like}, post-click ${ACTION_WEIGHTS.click}, link-open ${ACTION_WEIGHTS.openLink}
- photo-expand / video-open / quality-video-view / quoted-click ${ACTION_WEIGHTS.photoExpand} each (tiny)
- continuous dwell time ${ACTION_WEIGHTS.contDwellTime} (nearly nothing). Yes/no dwell ${ACTION_WEIGHTS.dwell} and profile-click ${ACTION_WEIGHTS.profileClick} are literally worth ZERO
NEGATIVES dwarf everything: report ${ACTION_WEIGHTS.report}, mute ${ACTION_WEIGHTS.muteAuthor} (worse than block), not-interested ${ACTION_WEIGHTS.notInterested}, block ${ACTION_WEIGHTS.blockAuthor}, scrolled-past-without-dwelling ${ACTION_WEIGHTS.notDwelled}. One predicted report is ~468 likes of damage.

Feed context that shapes what actually wins (judge with it in mind):
- Most reach for a small/creator account is OUT-OF-NETWORK, taxed x0.75. The only things that beat that tax are ORIGINALS a STRANGER with zero context will reply to, quote, DM, or copy-link. Replies/reposts are taxed x0.75 even for followers, so they aren't a reach play. Likes, profile visits and time-on-post are almost decorative.
- Ranking and visibility are separate machines: even a high-scoring post gets DROPPED from out-of-network recommendations if it trips a spam / "Do Not Amplify" / NSFW / misleading label. So spicy-but-risky loses to safe-but-substantive.

Estimate, for a typical reader who sees this post, the PROBABILITY (0..1) of each action. Be calibrated: likes come from a small fraction of viewers; replies rarer; copy-link/DM/quote/follow rarest; the negatives are very rare but catastrophic when they fire. photo-expand/video-open/quality-view only apply with media (video quality view needs a ≥10s video). Reward original, substantive posts a stranger would forward or argue with; mark down bland/recycled/low-effort posts; flag real report/mute/block/not-interested risk for anything spammy, misleading, inflammatory, or engagement-farming.

POST:
"""
${features.text}
"""
Has media attached: ${features.hasMedia ? features.mediaType : 'no'}

Return ONLY JSON:
{
  "probabilities": {
    "like": 0..1, "click": 0..1, "openLink": 0..1, "retweet": 0..1, "quote": 0..1,
    "reply": 0..1, "shareViaDm": 0..1, "share": 0..1, "shareViaCopyLink": 0..1,
    "followAuthor": 0..1, "bidiFollowReplyBoost": 0..1, "photoExpand": 0..1,
    "videoOpen": 0..1, "vqv": 0..1, "contDwellTime": 0..1,
    "report": 0..1, "muteAuthor": 0..1, "notInterested": 0..1, "blockAuthor": 0..1, "notDwelled": 0..1
  },
  "hookStrength": 0..1,   // does the first line stop the scroll?
  "clarity": 0..1,        // is the one idea instantly clear?
  "critique": "one sentence on the single biggest thing holding this post back",
  "suggestions": ["specific, actionable rewrite ideas (semantic, not mechanical)"]
}`;
}

// Blend two probability maps: llm-weighted average, keeping any key present.
function blend(prior, llm) {
  const out = {};
  const keys = new Set([...Object.keys(prior), ...Object.keys(llm)]);
  for (const k of keys) {
    const a = prior[k] ?? 0;
    const b = llm[k];
    out[k] = b == null ? a : clamp01(LLM_WEIGHT * b + (1 - LLM_WEIGHT) * a);
  }
  return out;
}

// Resolve probabilities + notes. With no `llm`, returns feature priors and
// empty notes (deterministic path). With an `llm` adapter, predicts and blends;
// any model error falls back to priors rather than throwing.
export async function predict(features, llm) {
  const prior = featurePriors(features);
  if (!llm) return { probs: prior, notes: {}, source: 'features' };

  try {
    const reply = await llm(buildPrompt(features), { temperature: SCORING_TEMPERATURE });
    const rawProbs = reply?.probabilities || {};
    const llmProbs = {};
    for (const k of Object.keys(prior)) if (rawProbs[k] != null) llmProbs[k] = clamp01(rawProbs[k]);
    const notes = {
      hookStrength: reply?.hookStrength != null ? clamp01(reply.hookStrength) : undefined,
      clarity: reply?.clarity != null ? clamp01(reply.clarity) : undefined,
      critique: typeof reply?.critique === 'string' ? reply.critique : undefined,
      suggestions: Array.isArray(reply?.suggestions) ? reply.suggestions.filter((s) => typeof s === 'string') : [],
    };
    return { probs: blend(prior, llmProbs), notes, source: 'hybrid' };
  } catch (err) {
    return { probs: prior, notes: {}, source: 'features', error: String(err?.message || err) };
  }
}
