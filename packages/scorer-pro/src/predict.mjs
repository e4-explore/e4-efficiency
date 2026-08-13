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

function buildPrompt(features) {
  return `You are modeling how X's (Twitter's) current Grok/Phoenix recommendation model would treat this post.
The model predicts a probability for each action, then sums them weighted. Relative weights (for context, weakest→strongest):
- like ${ACTION_WEIGHTS.like}, photo-expand ${ACTION_WEIGHTS.photoExpand} / video-open ${ACTION_WEIGHTS.videoOpen} (a tap to look closer at the media), retweet ${ACTION_WEIGHTS.retweet}, quote ${ACTION_WEIGHTS.quote}, share ${ACTION_WEIGHTS.share} (esp. share-via-DM)
- bookmark/save ${ACTION_WEIGHTS.bookmark} (a strong "lasting value" signal, second only to replies), follow ${ACTION_WEIGHTS.follow}
- open + dwell ${ACTION_WEIGHTS.openAndDwell}, profile click + engage ${ACTION_WEIGHTS.profileClickAndEngage}, reply ${ACTION_WEIGHTS.reply} (~27× a like)
- the author replying back into a reply ${ACTION_WEIGHTS.replyEngagedByAuthor} (by far the strongest positive)
- negative feedback (report/block/mute/"not interested"/scrolled past without dwelling) ${ACTION_WEIGHTS.negativeFeedback} (punishes hard)

Feed context that shapes what actually wins (not part of these per-action probabilities, but judge with it in mind):
- Most reach for a small/creator account is OUT-OF-NETWORK, which X discounts. The signals that overcome that discount are replies, bookmarks (saves) and dwell — so reward posts a STRANGER with zero context would save or read twice, not just posts an existing fan would like.
- Ranking and visibility are separate: even a high-scoring post can be suppressed by visibility filtering if it trips a safety/spam label. Misleading, inflammatory, or engagement-farming posts risk that regardless of engagement.

Estimate, for a typical reader who sees this post, the PROBABILITY (0..1) of each action. Be calibrated: a like comes from a small fraction of viewers, bookmarks/replies are rarer, author-reply-exchanges rarer still, follows/shares/quotes rarest; photo-expand/video-open only apply when media is present. Judge the content on its merits — original, substantive posts that invite genuine back-and-forth or are worth saving score high; recycled/aggregated/low-effort or bland posts score low; spammy/misleading/inflammatory posts carry real negative-feedback and visibility risk. Hashtags barely matter now (the model reads meaning, not tags).

POST:
"""
${features.text}
"""
Has media attached: ${features.hasMedia ? features.mediaType : 'no'}

Return ONLY JSON:
{
  "probabilities": {
    "like": 0..1, "photoExpand": 0..1, "videoOpen": 0..1, "retweet": 0..1, "quote": 0..1,
    "share": 0..1, "bookmark": 0..1, "follow": 0..1, "reply": 0..1,
    "replyEngagedByAuthor": 0..1, "profileClickAndEngage": 0..1,
    "openAndDwell": 0..1, "videoWatch50": 0..1, "negativeFeedback": 0..1
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
    const reply = await llm(buildPrompt(features));
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
