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
  // Rough P(action) per impression for an AVERAGE post, nudged by content
  // signals. Values are small because these are per-viewer probabilities: most
  // people who see a post do nothing. The big-weight actions (copy-link,
  // mutual-reply, quote) are rare; likes are common but cheap (0.5).
  let like = 0.02;
  let click = 0.02; // open the post detail (weight 0.4)
  let openLink = f.hasBodyLink ? 0.012 : 0; // only meaningful with a link
  let contDwellTime = 0.4; // fraction who linger (weight 0.004 — nearly nothing)
  let postUnexplored = 0.35; // most impressions are first-sight (weight 0.02)
  let retweet = 0.004;
  let quote = 0.0012;
  let reply = 0.004;
  let shareViaDm = 0.0012;
  let share = 0.002; // share-button
  let shareViaCopyLink = 0.0008; // rare, but weight 20 makes it matter
  let followAuthor = 0.0012;
  let bidiFollowReplyBoost = 0.0008; // P(a reply is from a mutual on your original)
  let photoExpand = f.mediaType === 'image' ? 0.02 : 0;
  let videoOpen = f.mediaType === 'video' ? 0.03 : 0;
  let vqv = f.mediaType === 'video' ? 0.02 : 0; // needs a ≥10s video
  let quotedClick = 0;

  // Negative-feedback probabilities. Baselines are TINY (report/mute/etc. are
  // rare) but their weights are huge, so small moves matter a lot.
  let report = 0.00004;
  let muteAuthor = 0.00006;
  let notInterested = 0.0002;
  let blockAuthor = 0.00004;
  let notDwelled = 0.3; // shown-and-scrolled-past (weight -0.02); high for thin posts

  // A post that invites genuine conversation lifts the reply family AND the
  // shareable-forward actions (people quote/DM/copy-link a post worth arguing
  // with or worth sending to a friend). These are the highest-leverage moves.
  if (f.invitesReply) {
    reply += 0.006;
    quote += 0.0015;
    bidiFollowReplyBoost += 0.001;
    shareViaDm += 0.001;
    shareViaCopyLink += 0.0006;
  }
  // Media raises the click/expand/watch actions and gives people something to
  // dwell on (fewer scroll-pasts).
  if (f.hasMedia) {
    like += 0.015;
    click += 0.02;
    notDwelled -= 0.08;
    if (f.mediaType === 'image') photoExpand += 0.015;
    if (f.mediaType === 'video') { videoOpen += 0.02; vqv += 0.015; }
  }
  // A concrete, reference-quality post (a real number, a how/why, a scannable
  // list) is what a stranger copy-links or DMs to a friend — the single biggest
  // positive. It also holds attention, cutting the scroll-past rate.
  if (f.looksLikeList || (f.length >= LENGTH.idealLow && f.length <= LENGTH.idealHigh)) {
    shareViaCopyLink += 0.0006;
    shareViaDm += 0.0006;
    followAuthor += 0.0006;
    notDwelled -= 0.06;
  }
  // A thin one-liner under-informs and gets scrolled past (the "not dwelled"
  // soft negative), and gives nothing to forward.
  if (f.length < LENGTH.min) {
    notDwelled += 0.1;
    shareViaCopyLink = Math.max(0, shareViaCopyLink - 0.0004);
  }

  // Spam-ish tells raise the catastrophic negatives (report/mute/not-interested
  // carry −234 / −58.8 / −43.2, so even tiny bumps here dominate the score).
  const spam = (f.hashtags > 2 ? 0.00004 * (f.hashtags - 2) : 0)
    + (f.capsRatio > 0.6 ? 0.0001 : 0)
    + (f.hasPunctuationSpam ? 0.0001 : 0)
    + (f.emoji > REACH.emojiSpamThreshold ? 0.00006 : 0);
  report += spam;
  muteAuthor += spam * 1.5;
  notInterested += spam * 2;
  blockAuthor += spam;

  const p = {
    like, click, openLink, contDwellTime, postUnexplored,
    retweet, quote, reply, shareViaDm, share, shareViaCopyLink,
    followAuthor, bidiFollowReplyBoost, photoExpand, videoOpen, vqv, quotedClick,
    report, muteAuthor, notInterested, blockAuthor, notDwelled,
  };
  for (const k of Object.keys(p)) p[k] = clamp(p[k], 0, 1);
  return p;
}

// Directional, feed-context guidance from the documented post-ranker
// adjustments (SCORE_ADJUSTMENTS). These are NOT part of the per-post score —
// they depend on who follows you and what else you've posted — so we surface
// them as strategy notes the auto-poster can act on (cadence, growth framing,
// diversity). Pure and side-effect-free. `ctx` is optional:
//   { isNewAccount?: boolean, postedRecently?: boolean, hasVideo?: boolean }
export function postingStrategyNotes(ctx = {}) {
  const notes = [
    'Most of your reach is out-of-network (non-followers), where posts are taxed x0.75, so an ORIGINAL a stranger will reply to, quote, or copy-link is what wins. Replies and reposts get the same x0.75 tax even from followers, so they are not a reach play.',
    'The biggest positives are a copy-link share (+20) and a reply on your original from a mutual (+20). Likes (+0.5), profile visits (0) and time-on-post (~0) are almost decorative, so write to be forwarded and replied to, not liked.',
    'One predicted report is ~234 likes of damage (mute -58.8, not-interested -43.2, block -31.2). Avoiding negative feedback outweighs almost any engagement gain, so never bait reports/mutes or lean on spammy/NSFW tricks.',
    'X spreads similar posts apart (VMRanker diversity rerank) and decays your 2nd/3rd post in the same feed, so vary the angle AND the visual across posts, not just the opening word.',
    'Nothing older than 48h enters For You and your own posts never show in your own feed, so recycle by posting something new rather than expecting an old post to revive.',
  ];
  if (ctx.postedRecently) {
    notes.push('You posted recently: your 2nd post in the same reader\'s feed is already worth ~37.5% less (author-diversity decay, 2nd x0.625, 3rd x0.44). Let the scheduler space posts into separate audience windows.');
  }
  if (ctx.isNewAccount) {
    notes.push('Under ~1,000 followers/impressions, an original posted within 24h can get lifted toward position ~15-16 (not the top) — a temporary tailwind that fades as you grow. Post originals early; don\'t expect slot 1.');
  }
  if (ctx.hasVideo) {
    notes.push('Video only earns the "quality view" credit when it is at least 10 seconds long.');
  }
  return notes;
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
  // Safety: 100 = no predicted negative feedback; drops as predicted negative EV
  // (dominated by the −234 report / −58.8 mute weights) eats into a reference EV.
  const safety = clamp(round(100 - (down / REFERENCE_EV) * 100), 0, 100);
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
