// X (Twitter) ranking weights and tunables.
//
// SOURCE: these are the ACTUAL published production weights from
// xai-org/x-algorithm `home-mixer/params/param.rs` (values synced 2026-08-12),
// released under Apache-2.0 (permissive — no copyleft). Numeric constants are
// facts and aren't copyrightable; encoding the real published numbers makes the
// score accurate rather than a directional guess. Earlier versions of this file
// used our own estimates because we believed the weights were redacted; the
// 2026-08 open-source release publishes them in full, so we now use them.
//
// HOW THE SCORE WORKS (xai-org/x-algorithm, README updated 2026-08-13): ranking
// is a single Grok-family transformer ("Phoenix") whose heads predict P(action)
// per candidate; a Weighted Scorer combines them as
// Final Score = Σ wᵢ·P(actionᵢ) and sorts the feed. Then three post-ranker
// ADJUSTMENTS reshape the order (SCORE_ADJUSTMENTS: author-diversity decay, an
// out-of-network discount, a new-author lift), a VMRanker service reorders for
// diversity (a DPP, θ=0.65), and — separately — VISIBILITY FILTERING (labels,
// blocks, mutes, "Do Not Amplify", NSFW, account status) can drop a post
// regardless of its score. Ranking sets order; visibility decides if it's shown.
//
// What is NOT downloadable: the trained transformer itself (a 2560-dim, 8-layer
// model over ~1,022 items of reader history). The weights below are the formula
// that sits ON TOP of that model's predicted probabilities — which is exactly
// the part we need to score a draft. We still can't run the transformer, so we
// ESTIMATE each P(action) from the post (feature heuristics, better with an
// LLM) and apply the real weights. Treat the absolute number as a *relative*
// guide; the subscores, adjustments, and suggestions are the product.
//
// The headline facts these weights encode (all verifiable in param.rs):
//   • Copy-link share (+20) and a reply on your ORIGINAL from a mutual
//     (+5 base +15 boost = +20) are the two biggest positives, by a mile.
//   • Quote / reply / share-via-DM (+5), follow-from-post (+4) are the next tier.
//   • A like is only +0.5, a post click +0.4, a link open +0.2.
//   • Profile-click and yes/no dwell are +0 — literally worth nothing. Time
//     spent (continuous dwell) is +0.004, nearly nothing.
//   • Negatives dwarf everything: report −234, mute −58.8 (worse than block!),
//     not-interested −43.2, block −31.2. One predicted report ≈ 468 likes of
//     damage, so avoiding negative-feedback risk is the highest-leverage lever.
export const ACTION_WEIGHTS = {
  // --- Positive actions (weakest → strongest), exact param.rs values ---
  dwell: 0.0, // binary "did they dwell": weight 0. Scrolling/pausing is NOT a vote.
  profileClick: 0.0, // clicking your profile: weight 0. Profile-visit farming does nothing.
  contDwellTime: 0.004, // continuous dwell time. Time-on-post barely moves the number.
  postUnexplored: 0.02, // small exploration/novelty credit for an unseen post.
  photoExpand: 0.05, // tap to enlarge an image.
  videoOpen: 0.05, // tap to open a video.
  vqv: 0.05, // "video quality view" — only credited when the video is ≥10s.
  quotedClick: 0.05, // click through a quoted post.
  openLink: 0.2, // open a link in the post.
  click: 0.4, // click into the post (open the detail view).
  like: 0.5, // "favorite" — cheap and plentiful; the unit others compare against.
  retweet: 1.0, // repost with no added commentary.
  share: 2.0, // the share button (share sheet).
  followAuthor: 4.0, // a follow straight from the post — a strong quality signal.
  reply: 5.0, // any reply.
  quote: 5.0, // quote-post (repost PLUS a new authored post).
  shareViaDm: 5.0, // sharing the post into a DM.
  // Extra weight ADDED to a reply when the reader mutually-follows the author AND
  // the post is an ORIGINAL (not a reply/repost). reply(5) + 15 boost = 20 total,
  // tied with copy-link as the single biggest positive. Originals only — your
  // replies don't get it. (X shipped a bigger 20-point boost in July 2026 and
  // cut it to 15 after complaints.)
  bidiFollowReplyBoost: 15.0,
  shareViaCopyLink: 20.0, // copying the link to share it — the single biggest positive.

  // --- Negative feedback (exact param.rs values). These are enormous. ---
  notDwelled: -0.02, // shown, then scrolled past without dwelling. Tiny.
  blockAuthor: -31.2, // reader blocks you.
  notInterested: -43.2, // reader hits "not interested" — hurts more than a block.
  muteAuthor: -58.8, // reader mutes you — hurts MORE than a block.
  report: -234.0, // reader reports the post — catastrophic, ≈ 468 likes of damage.
};

// Which actions are upside vs downside — used to split the expected value so we
// can report "engagement potential" and "risk" separately.
export const POSITIVE_ACTIONS = [
  'dwell',
  'profileClick',
  'contDwellTime',
  'postUnexplored',
  'photoExpand',
  'videoOpen',
  'vqv',
  'quotedClick',
  'openLink',
  'click',
  'like',
  'retweet',
  'share',
  'followAuthor',
  'reply',
  'quote',
  'shareViaDm',
  'bidiFollowReplyBoost',
  'shareViaCopyLink',
];
export const NEGATIVE_ACTIONS = [
  'notDwelled',
  'blockAuthor',
  'notInterested',
  'muteAuthor',
  'report',
];

// Reference expected-value used to normalize the raw Σ w·P into a 0–100 score.
// Recalibrated for the real weight scale (per-impression probabilities are
// small, so realized EV is small) so a genuinely strong, low-risk post lands in
// the high 80s / low 90s rather than pinning at 100. Tunable; it only affects
// the absolute number, not the ranking of two posts.
export const REFERENCE_EV = 0.24;

// A representative negative weight used to scale the "safety" subscore (how much
// predicted negative feedback is eating the post). Mute is the median-ish of the
// big four and a good yardstick.
export const SAFETY_REFERENCE = Math.abs(ACTION_WEIGHTS.muteAuthor);

// ---- Deterministic reach heuristics (OUR layer, applied outside the ranker) ----
// param.rs has no body-link or hashtag penalty — those live in candidate
// sourcing / visibility filtering / long-standing community observation, not the
// scorer. We keep them as a small, clearly-separate heuristic multiplier on the
// normalized score. 1.0 = neutral. Tunable.
export const REACH = {
  // A bare external link can dampen out-of-network distribution (the platform
  // favors on-platform dwell, and link-heavy posts skew toward the harsher
  // out-of-network visibility filters). Mild, and not in param.rs — a heuristic.
  bodyLinkPenalty: 0.9, // ×0.9 when the post body contains an external link.

  // Native media lifts the chance of the clicks/dwell the model rewards.
  mediaBoost: 1.08, // ×1.08 when media is attached.
  videoBoost: 1.12, // ×1.12 for video specifically (higher dwell/watch ceiling).

  // Hashtags past the first read as spammy; the model reads meaning, not tags.
  hashtagPenaltyPer: 0.96, // multiplied once per hashtag beyond the first.
  hashtagFreeAllowance: 1, // first N hashtags are free.

  // Cramming many @mentions looks like reply-spam / reach-hacking.
  mentionPenaltyPer: 0.97, // per @mention beyond the allowance.
  mentionFreeAllowance: 2,

  // ALL-CAPS SHOUTING and !!!/??? runs are low-quality signals.
  shoutPenalty: 0.94,

  // Emoji in moderation is fine; a wall of emoji is a spam signal.
  emojiSpamPenalty: 0.95, // applied when emoji count exceeds emojiSpamThreshold.
  emojiSpamThreshold: 4,

  // Floor so no single content choice can zero out the score entirely.
  floor: 0.6,
};

// ---- Post-ranker score adjustments (exact param.rs values, applied AFTER Σ w·P) ----
// These reshape the feed order once every candidate has a base score. They
// depend on FEED/ACCOUNT context a single-post scorer can't see (who follows
// you, how many of your posts are already in this reader's session, your
// account's impression history), so we do NOT fold them into the per-post
// number — they're surfaced as posting-strategy guidance (postingStrategyNotes).
export const SCORE_ADJUSTMENTS = {
  // Author diversity: each post after an author's FIRST in a given reader's
  // session is multiplied by decay^(n-1) toward a floor. With decay 0.5 / floor
  // 0.25 the 2nd post lands at ~0.625, the 3rd at ~0.44, never below 0.25.
  // Firing several posts close together mostly competes with yourself, so space
  // them out (the scheduler's audience-window queue already helps).
  authorDiversityDecay: 0.5,
  authorDiversityFloor: 0.25,

  // Out-of-network discount: a post shown to someone who does NOT follow you is
  // ×0.75. The SAME 0.75 tax also hits replies and reposts even for followers —
  // originals from people who follow you keep full weight. For a builder account
  // most reach is out-of-network, so originals that a STRANGER will reply to,
  // quote, or copy-link are what overcome the tax.
  outOfNetworkDiscount: 0.75, // OonWeightFactor
  topicOutOfNetworkDiscount: 0.5, // TopicOonWeightFactor — harsher, topic-sourced OON

  // VMRanker diversity rerank: a DPP (θ=0.65, max selected rank 150) spreads
  // similar posts apart after scoring. You can lose a few positions just for
  // looking like the post above you, so vary angle AND visual across posts.
  vmRankerDppTheta: 0.65,
  dppMaxSelectedRank: 150,

  // New/small-account lift: an original from an account under ~1,000 followers
  // and ~1,000 impressions, posted under 24h ago, can be lifted toward position
  // ~15–16 (not the top) — a temporary tailwind that fades as you grow.
  smallAccountBoostTargetPosition: 15,

  // Freshness: nothing older than this gets into For You. There is no "best of
  // last week" — recycle by posting something new, old posts don't come back.
  maxPostAgeHours: 48,

  // Video must be at least this long to earn the "quality view" (vqv) credit.
  videoQualityViewMinSeconds: 10,
};

// ---- Retrieval / candidate sourcing (exact param.rs limits) ----
// For You is rebuilt on every open; ~35 posts make the final feed. Candidates
// come from three doors, then Grok scores them all together (the only thing that
// remembers which door is the ×0.75 out-of-network tax). Your own posts never
// appear in your own For You.
export const RETRIEVAL = {
  thunderMaxResults: 1200, // in-network: recent posts from accounts you follow.
  phoenixMaxResults: 1000, // out-of-network: Grok finds "nearby" posts.
  tweetMixerMaxResults: 800, // out-of-network: SimClusters (2020 interest clusters, still on).
  phoenixMoeMaxResults: 200,
  approxFeedSize: 35,
};

// ---- Length model ----
// Long enough to say something, short enough to read at a glance. Very short
// under-informs; near the 280 limit reads as crammed. A soft bell, not a rule.
export const LENGTH = {
  min: 40, // below this, penalize for being too thin.
  idealLow: 70,
  idealHigh: 200,
  max: 280, // X's classic limit for a single post.
};
