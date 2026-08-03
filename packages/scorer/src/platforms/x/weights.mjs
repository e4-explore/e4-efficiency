// X (Twitter) ranking weights and tunables.
//
// CLEAN-ROOM NOTE: none of X's AGPL-3.0 source is copied here. These are our
// own numbers, chosen to match the PUBLICLY DOCUMENTED STRUCTURE of X's ranking
// (the action set and their relative ordering), not copied from any params
// file. Facts (an action exists; replies outweigh likes ~27×) aren't
// copyrightable; this implementation is ours. That keeps the package free of
// the AGPL network-copyleft obligation so it can be licensed and priced however
// the product needs.
//
// CURRENT ALGORITHM (Jan 2026 rebuild, xai-org/x-algorithm): ranking is now a
// single Grok-family transformer ("Phoenix") with ~19 multi-task heads that
// predict P(action) per candidate; a Weighted Scorer combines them as
// Final Score = Σ wᵢ·P(actionᵢ), sorted for the feed (no public denominator —
// it's a relative ranking number). Two hard limits shape what we can do:
//   1. The trained transformer weights are NOT downloadable — the real model
//      can't be run on a post.
//   2. The Weighted Scorer's numeric weights are REDACTED in the open repo
//      (a private params module).
// So no one outside X can compute a real score. What IS public: the action set
// and consistent directional analyses — reply ≫ like (~27×), author
// back-and-forth strongest, shares/follows/dwell above likes, report/block/mute
// heavily negative, external links limit distribution, originality favored. We
// encode those directions as tunable weights, estimate each action's
// probability from the post (feature heuristics, better with an LLM), and sum.
// Treat the absolute number as a *relative* guide; the subscores and
// suggestions are the real product.

// ---- Action weights (the model predicts P(action); score = Σ w·P) ----
// Our directional constants (the real values are redacted). Their ORDERING, not
// absolute magnitude, is what's defensible — and it's deliberately tunable.
export const ACTION_WEIGHTS = {
  // Positive engagement the ranker rewards, roughly weakest → strongest.
  like: 0.5, // "fav" — cheap, plentiful; the unit the others are scaled to.
  retweet: 1.0, // repost / amplification.
  share: 3.0, // intentional shares (esp. share-via-DM) signal high value, above a like.
  follow: 5.0, // a follow straight from the feed is a strong quality signal.
  openAndDwell: 11.0, // reader opens and dwells (binary dwell + continuous time).
  profileClickAndEngage: 12.0, // reader clicks the author's profile AND engages there.
  reply: 13.5, // conversation ≈ 27× a like — one of the strongest positives.
  // The single strongest positive signal: the author replies back into a reply.
  // The model treats an exchange the author is part of as gold.
  replyEngagedByAuthor: 75.0,
  videoWatch50: 0.005, // video quality view (~50% / min duration). Tiny per-event weight.

  // Negative feedback the ranker punishes hard. A single predicted report /
  // block / mute / "not interested" roughly cancels the upside of a strong
  // post — why "safe but flat" often out-reaches "spicy but risky".
  negativeFeedback: -74.0,
};

// Which actions are upside vs downside — used to split the expected value so we
// can report "engagement potential" and "risk" separately.
export const POSITIVE_ACTIONS = [
  'like',
  'retweet',
  'share',
  'follow',
  'openAndDwell',
  'profileClickAndEngage',
  'reply',
  'replyEngagedByAuthor',
  'videoWatch50',
];
export const NEGATIVE_ACTIONS = ['negativeFeedback'];

// Reference expected-value used to normalize the raw Σ w·P into a 0–100 score.
// Calibrated so that a genuinely strong, low-risk post lands in the high 80s /
// low 90s rather than pinning at 100 (leaving headroom the optimizer can chase).
// Tunable; it only affects the absolute number, not the ranking of two posts.
export const REFERENCE_EV = 9.0;

// ---- Deterministic reach multipliers (documented heuristics, applied outside the ranker) ----
// These model candidate-sourcing / filtering / visibility-filter behavior the
// pipeline applies before or around the heavy ranker. Each is a multiplier on
// the normalized score. 1.0 = neutral. Tunable.
export const REACH = {
  // A bare external link in the post body historically suppresses reach — the
  // platform prefers keeping readers on-platform. The well-known workaround is
  // to move the link into a reply. We penalize a body link, not a reply link.
  bodyLinkPenalty: 0.85, // ×0.85 when the post body contains an external link.

  // Native media (image/video) lifts dwell and engagement.
  mediaBoost: 1.08, // ×1.08 when media is attached.
  videoBoost: 1.12, // ×1.12 for video specifically (higher dwell ceiling).

  // Hashtags past the first one or two read as spammy and get down-weighted.
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

// ---- Length model ----
// Documented sweet spot: long enough to say something, short enough to read at
// a glance. Very short (a few words) under-informs; near the 280 limit reads as
// crammed. This is a soft bell, not a hard rule.
export const LENGTH = {
  min: 40, // below this, penalize for being too thin.
  idealLow: 70,
  idealHigh: 200,
  max: 280, // X's classic limit for a single post.
};
