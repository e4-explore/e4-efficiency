// X (Twitter) ranking weights and tunables.
//
// CLEAN-ROOM NOTE: none of X's published source is copied here. These are our
// own numbers, chosen to match the PUBLICLY DOCUMENTED STRUCTURE of X's ranking
// (the action set and their relative ordering), not copied from any params
// file. Facts (an action exists; replies outweigh likes ~27×) aren't
// copyrightable; this implementation is ours. The current xai-org/x-algorithm
// release is Apache-2.0 (permissive, no network-copyleft), but we stay
// clean-room regardless so the package can be licensed and priced as the
// product needs.
//
// CURRENT ALGORITHM (xai-org/x-algorithm, README updated 2026-08-13): ranking is
// a single Grok-family transformer ("Phoenix") whose multi-task heads predict
// P(action) per candidate; a Weighted Scorer combines them as
// Final Score = Σ wᵢ·P(actionᵢ) (weights in home-mixer/params/param.rs), sorted
// for the feed. The published action set is richer than a like/reply/repost
// summary — it separates:
//   • Engagement: favorite, reply, repost, QUOTE, share, share-via-DM,
//     share-via-copy-link (bookmark/save is a documented strong "lasting value"
//     signal).
//   • Clicks: post, PROFILE, link, PHOTO-EXPAND, VIDEO-OPEN, quoted-post.
//   • Attention: video quality view, dwell, dwell time, click dwell time,
//     active seconds — and "NOT DWELLED" as a negative.
//   • Author/negative: follow author; not-interested, mute, block, report.
// After the weighted sum, three post-ranker ADJUSTMENTS reshape the order (see
// SCORE_ADJUSTMENTS): author-diversity decay, an out-of-network discount, and a
// new-author boost. A separate VMRanker service then reorders for diversity
// (a DPP over embeddings), and — crucially — VISIBILITY FILTERING (labels,
// blocks, mutes, account status) decides whether a post can be shown AT ALL,
// independently of its rank.
//
// Two hard limits still bind us: the trained transformer weights aren't
// downloadable, and the Weighted Scorer's numeric weights are redacted, so no
// one outside X computes a real score. We encode the public DIRECTIONS as
// tunable weights, estimate each action's probability from the post (feature
// heuristics, better with an LLM), and sum. Treat the absolute number as a
// *relative* guide; the subscores, adjustments, and suggestions are the product.

// ---- Action weights (the model predicts P(action); score = Σ w·P) ----
// Our directional constants (the real values are redacted). Their ORDERING, not
// absolute magnitude, is what's defensible — and it's deliberately tunable.
export const ACTION_WEIGHTS = {
  // Positive engagement the ranker rewards, roughly weakest → strongest.
  like: 0.5, // "fav" — cheap, plentiful; the unit the others are scaled to.
  photoExpand: 0.6, // tap to expand an image — the visual earned a closer look.
  videoOpen: 0.9, // tap to open/expand a video — intent to actually watch.
  retweet: 1.0, // repost / amplification (no added commentary).
  quote: 1.6, // quote-post: repost PLUS a new authored post — amplification above a bare repost.
  share: 3.0, // intentional shares (esp. share-via-DM) signal high value, above a like.
  // Bookmark / "save for later" — a documented strong "lasting value" signal,
  // widely reported second only to replies. It says the post is worth returning
  // to, which is exactly what out-of-network reach rewards. Above share, below reply.
  bookmark: 4.0,
  follow: 5.0, // a follow straight from the feed is a strong quality signal.
  openAndDwell: 11.0, // reader opens and dwells (binary dwell + continuous dwell time / active seconds).
  profileClickAndEngage: 12.0, // reader clicks the author's profile AND engages there.
  reply: 13.5, // conversation ≈ 27× a like — one of the strongest positives.
  // The single strongest positive signal: the author replies back into a reply.
  // The model treats an exchange the author is part of as gold.
  replyEngagedByAuthor: 75.0,
  videoWatch50: 0.005, // video quality view (~50% / min duration). Tiny per-event weight.

  // Negative feedback the ranker punishes hard. A single predicted report /
  // block / mute / "not interested" roughly cancels the upside of a strong
  // post — why "safe but flat" often out-reaches "spicy but risky". The
  // published model also treats "not dwelled" (shown, ignored, scrolled past)
  // as a soft negative; we fold that dwell risk into openAndDwell rather than
  // double-count it here.
  negativeFeedback: -74.0,
};

// Which actions are upside vs downside — used to split the expected value so we
// can report "engagement potential" and "risk" separately.
export const POSITIVE_ACTIONS = [
  'like',
  'photoExpand',
  'videoOpen',
  'retweet',
  'quote',
  'share',
  'bookmark',
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

// ---- Post-ranker score adjustments (documented, applied AFTER Σ w·P) ----
// These reshape the feed order once every candidate has a base score. They
// depend on FEED/ACCOUNT context a single-post scorer can't see (who follows
// you, how many posts of yours are already in this reader's session, your
// account's impression history), so we do NOT fold them into the per-post
// number. They're encoded here as documented directions the pipeline uses to
// advise on posting strategy (cadence, spacing, growth expectations) — see
// postingStrategyNotes(). Values are directional, not X's real constants.
export const SCORE_ADJUSTMENTS = {
  // Author diversity: each post after an author's FIRST in a given reader's
  // session is multiplied by a decaying factor down to a floor. Practical
  // effect: firing several posts close together mostly competes with yourself.
  // Spacing posts out (the scheduler's audience-window queue already helps)
  // keeps each one landing as an author's "first" for more readers.
  authorDiversityDecay: 0.5, // rough per-additional-post decay.
  authorDiversityFloor: 0.25,

  // Out-of-network discount: posts shown to people who DON'T follow you are
  // multiplied by a sub-1.0 factor. For a self-marketing / builder account most
  // reach is out-of-network, so it eats this discount by default. What overcomes
  // it is high PER-READER signal — replies, bookmarks (saves), and dwell — not
  // raw likes. This is why "save-worthy / reply-worthy for a stranger" beats
  // "like-worthy for someone who already gets it".
  outOfNetworkDiscount: 0.75,

  // New-author boost: accounts below an impression threshold get lifted toward
  // target feed positions — a temporary tailwind for small/new accounts that
  // fades as you grow. Don't build a strategy that assumes it persists.
  newAuthorBoost: 1.25,

  // VMRanker diversity rerank (a DPP over post embeddings) runs after all of the
  // above and de-duplicates the final list. Near-identical posts (same angle,
  // same image) suppress each other, so genuine variety in text AND visuals
  // beats cosmetic wording changes.
  diversityRerank: true,
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
