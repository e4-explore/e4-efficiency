// Combine deterministic features + per-action engagement probabilities into a
// 0–100 score, explainable subscores, and concrete suggestions. Pure and
// dependency-free: probabilities come in already resolved (from feature priors,
// an LLM, or a blend of both), so this module has no I/O and is fully testable.

import {
  ACTION_WEIGHTS,
  POSITIVE_ACTIONS,
  NEGATIVE_ACTIONS,
  REFERENCE_EV,
  REACH,
  LENGTH,
} from './weights.mjs';

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const round = (n, d = 0) => {
  const f = 10 ** d;
  return Math.round(n * f) / f;
};

// Feature-only probability prior. Lets the scorer produce a sensible result with
// NO LLM (graceful degradation), and gives the LLM predictor a baseline to blend
// against so one bad model call can't swing a score wildly. Each value is a
// rough P(action) in [0,1] inferred from what we can read off the text.
export function featurePriors(f) {
  // Baselines for an average post, nudged by content signals.
  let like = 0.14;
  let retweet = 0.03;
  let share = 0.015;
  let follow = 0.01;
  let reply = 0.04;
  let replyEngagedByAuthor = 0.02;
  let profileClickAndEngage = 0.03;
  let openAndDwell = 0.08;
  let videoWatch50 = f.mediaType === 'video' ? 0.2 : 0;
  let negativeFeedback = 0.02;

  // Reply-bait lifts the two reply-related actions (the heavy hitters).
  if (f.invitesReply) {
    reply += 0.05;
    replyEngagedByAuthor += 0.03;
  }
  // Media lifts dwell and likes.
  if (f.hasMedia) {
    like += 0.04;
    openAndDwell += 0.04;
    share += 0.005;
  }
  // Scannable list-y posts get opened/dwelt on.
  if (f.looksLikeList) openAndDwell += 0.03;
  // A thin one-liner under-informs; a rich post earns more dwell.
  if (f.length < LENGTH.min) openAndDwell -= 0.03;

  // Spam-ish tells raise negative-feedback risk (the -74 weight bites here).
  if (f.hashtags > 2) negativeFeedback += 0.01 * (f.hashtags - 2);
  if (f.capsRatio > 0.6) negativeFeedback += 0.02;
  if (f.hasPunctuationSpam) negativeFeedback += 0.02;
  if (f.emoji > REACH.emojiSpamThreshold) negativeFeedback += 0.01;

  const p = {
    like,
    retweet,
    share,
    follow,
    reply,
    replyEngagedByAuthor,
    profileClickAndEngage,
    openAndDwell,
    videoWatch50,
    negativeFeedback,
  };
  for (const k of Object.keys(p)) p[k] = clamp(p[k], 0, 1);
  return p;
}

// Deterministic reach multiplier from documented heuristics. Returns the
// multiplier plus the named LEVERS that moved it — lever id + which subscore it
// belongs to + its impact. NO fix text lives here: the free tier surfaces WHICH
// levers are weak (the diagnosis); turning a lever into written advice is the
// paid tier's job (@e4/post-scorer-pro maps lever ids -> guidance).
export function reachMultiplier(f) {
  const levers = [];
  let m = 1;

  if (f.hasBodyLink) {
    m *= REACH.bodyLinkPenalty;
    levers.push({ lever: 'body-link', delta: REACH.bodyLinkPenalty - 1, subscore: 'reach' });
  }
  if (f.hasMedia) {
    const boost = f.mediaType === 'video' ? REACH.videoBoost : REACH.mediaBoost;
    m *= boost;
    // A positive lever (media present) — not an issue, so no lever pushed.
  } else {
    levers.push({ lever: 'no-media', delta: -(REACH.mediaBoost - 1), subscore: 'reach' });
  }

  const extraHashtags = Math.max(0, f.hashtags - REACH.hashtagFreeAllowance);
  if (extraHashtags > 0) {
    const pen = REACH.hashtagPenaltyPer ** extraHashtags;
    m *= pen;
    levers.push({ lever: 'hashtags', delta: pen - 1, subscore: 'reach', count: extraHashtags });
  }
  const extraMentions = Math.max(0, f.mentions - REACH.mentionFreeAllowance);
  if (extraMentions > 0) {
    const pen = REACH.mentionPenaltyPer ** extraMentions;
    m *= pen;
    levers.push({ lever: 'mentions', delta: pen - 1, subscore: 'reach', count: extraMentions });
  }
  if (f.capsRatio > 0.6) {
    m *= REACH.shoutPenalty;
    levers.push({ lever: 'all-caps', delta: REACH.shoutPenalty - 1, subscore: 'reach' });
  }
  if (f.hasPunctuationSpam) {
    m *= REACH.shoutPenalty;
    levers.push({ lever: 'punctuation', delta: REACH.shoutPenalty - 1, subscore: 'reach' });
  }
  if (f.emoji > REACH.emojiSpamThreshold) {
    m *= REACH.emojiSpamPenalty;
    levers.push({ lever: 'emoji', delta: REACH.emojiSpamPenalty - 1, subscore: 'reach' });
  }

  m = Math.max(REACH.floor, m);
  return { multiplier: m, levers };
}

// Soft length bell → factor in ~[0.8, 1], plus a named lever when it's off.
export function lengthFactor(f) {
  const n = f.length;
  if (n >= LENGTH.idealLow && n <= LENGTH.idealHigh) return { factor: 1, lever: null };
  if (n < LENGTH.min) return { factor: 0.82, lever: 'length-thin' };
  if (n < LENGTH.idealLow) {
    const t = (n - LENGTH.min) / (LENGTH.idealLow - LENGTH.min);
    return { factor: 0.9 + 0.1 * t, lever: null };
  }
  const t = clamp((n - LENGTH.idealHigh) / (LENGTH.max - LENGTH.idealHigh), 0, 1);
  const factor = 1 - 0.15 * t;
  const lever = n > LENGTH.max ? 'length-over' : n > (LENGTH.idealHigh + LENGTH.max) / 2 ? 'length-crammed' : null;
  return { factor, lever, overBy: n > LENGTH.max ? n - LENGTH.max : 0 };
}

// Impact magnitude → coarse severity band (for free-tier issue flags).
function severityOf(impact) {
  if (impact >= 0.1) return 'high';
  if (impact >= 0.04) return 'medium';
  return 'low';
}

// Expected value of the ranker score: Σ w·P, split into upside and downside.
export function expectedValue(probs) {
  let up = 0;
  let down = 0;
  for (const a of POSITIVE_ACTIONS) up += (ACTION_WEIGHTS[a] || 0) * (probs[a] || 0);
  for (const a of NEGATIVE_ACTIONS) down += Math.abs(ACTION_WEIGHTS[a] || 0) * (probs[a] || 0);
  return { up, down, net: up - down };
}

// Full scoring. `probs` is the resolved per-action probability map. `notes`
// optionally carries LLM-provided qualitative notes (hook, clarity) folded into
// subscores. The FREE result carries `issues` — the named levers that are weak,
// each with the subscore it hurts and a severity — but no fix text and no
// rewrite. Those (the "how") are the paid tier.
export function scorePost(features, probs, notes = {}) {
  const f = features;
  const { up, down, net } = expectedValue(probs);

  // Normalize net EV against the reference into a 0–100 "ranker" base.
  const rankerBase = clamp((net / REFERENCE_EV) * 100, 0, 100);

  const reach = reachMultiplier(f);
  const len = lengthFactor(f);

  const overall = clamp(round(rankerBase * reach.multiplier * len.factor), 0, 100);

  // Subscores, each 0–100 and independently meaningful.
  const engagement = clamp(round((up / REFERENCE_EV) * 100), 0, 100);
  // Safety: 100 = no predicted negative feedback; drops as risk rises.
  const safety = clamp(round(100 - (down / Math.abs(ACTION_WEIGHTS.negativeFeedback)) * 100 * 4), 0, 100);
  const reachScore = clamp(round((reach.multiplier / REACH.videoBoost) * 100), 0, 100);
  const hook = clamp(round(notes.hookStrength != null ? notes.hookStrength * 100 : (f.firstLine.length >= 20 ? 60 : 45)), 0, 100);
  const clarity = clamp(round(notes.clarity != null ? notes.clarity * 100 : (len.factor * 100)), 0, 100);

  // Named issues (the free-tier diagnosis) — lever id, which subscore it hurts,
  // impact, severity. Strongest first. No text: that's @e4/post-scorer-pro.
  const issues = [];
  for (const lv of reach.levers) {
    issues.push({ lever: lv.lever, subscore: lv.subscore, impact: Math.abs(lv.delta), severity: severityOf(Math.abs(lv.delta)), ...(lv.count ? { count: lv.count } : {}) });
  }
  if (len.lever) {
    const impact = 1 - len.factor;
    issues.push({ lever: len.lever, subscore: 'clarity', impact, severity: severityOf(impact), ...(len.overBy ? { overBy: len.overBy } : {}) });
  }
  if (!f.invitesReply) {
    issues.push({ lever: 'reply-bait', subscore: 'engagement', impact: 0.2, severity: 'high' });
  }
  issues.sort((a, b) => b.impact - a.impact);

  return {
    platform: 'x',
    score: overall,
    subscores: { engagement, safety, reach: reachScore, hook, clarity },
    expectedValue: { upside: round(up, 2), downside: round(down, 2), net: round(net, 2) },
    reachMultiplier: round(reach.multiplier, 3),
    lengthFactor: round(len.factor, 3),
    probabilities: probs,
    issues,
    // Count of paid fixes available, so the free tier can say "3 fixes available".
    fixesAvailable: issues.length,
  };
}
