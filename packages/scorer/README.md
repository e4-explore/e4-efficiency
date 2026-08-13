# @e4/post-scorer (free core)

Score a social post the way the target platform's algorithm would **before you
publish**. Clean-room from documented signals. **X (Twitter) first**;
platform-agnostic surface so more slot in later.

This is the **free tier**: paste a draft, get a 0–100 score, five subscores, and
the **named issues** holding it back (which levers are weak). Deterministic,
offline, zero dependencies, no key. It's the diagnosis.

The **written fixes** for those issues and the **iterate-to-maximize
auto-optimizer** are the paid tier — [`@e4/post-scorer-pro`](../scorer-pro),
which builds on this package and requires a license key.

## Why the score means something (and its honest limits)

X's ranking is the **Grok/Phoenix transformer** (`xai-org/x-algorithm`, README
updated 2026-08-13): action heads predict P(action) per candidate; a Weighted
Scorer sums them (`Final Score = Σ wᵢ·P(actionᵢ)`) to sort the feed — no public
denominator, it's a *relative* number. The **actual production weights are now
published** in `home-mixer/params/param.rs` (Apache-2.0, synced 2026-08-12), so
we encode the real numbers, not guesses. The one thing still not downloadable is
the trained transformer itself, so we estimate each `P(action)` from the post
and apply the real weights.

The weights that matter (all from `param.rs`):

- **Copy-link share `+20`** and **a reply on your original from a mutual `+20`**
  (`reply 5` + `bidiFollowReplyBoost 15`) are the two biggest positives.
- **Quote / reply / share-via-DM `+5`**, **follow-from-post `+4`**, share-button
  `+2`, repost `+1`.
- A **like is only `+0.5`**, a post-click `+0.4`, a link-open `+0.2`.
- **Profile-click `0` and yes/no dwell `0`** — literally worth nothing. Continuous
  dwell time is `+0.004` (nearly nothing). Photo-expand / video-open /
  quality-view are `+0.05` each.
- **Negatives dwarf everything: report `−234`, mute `−58.8` (worse than block!),
  not-interested `−43.2`, block `−31.2`.** One predicted report ≈ 468 likes of
  damage, so avoiding negative feedback is the highest-leverage lever.

After the sum, real post-ranker **adjustments** reshape the order —
author-diversity decay (`0.5`, floor `0.25`), an **out-of-network discount**
(`×0.75`, which also taxes replies/reposts even for followers), a small-account
lift, and a **VMRanker** diversity rerank (`θ=0.65`) — and, separately,
**visibility filtering** ("Do Not Amplify", NSFW, spam labels) can drop a post
regardless of rank. These depend on feed/account context, so they're surfaced as
strategy notes (`postingStrategyNotes()`), not folded into the per-post number.
**Treat the number as a relative guide; the subscores and (in Pro) the
suggestions are the real product.**

## Run

Zero dependencies. Node ≥ 20.

```bash
node packages/scorer/bin/score.mjs "your draft here" --media image
echo "your draft" | node packages/scorer/bin/score.mjs --json
```

Example output: a score, subscore bars, and weak spots like
`reply-bait → hurts engagement [high]` — plus a prompt to unlock the fixes.

## Library API

```js
import { evaluatePost } from '@e4/post-scorer';

const r = await evaluatePost('rebuilt onboarding, first win in 30s now', { platform: 'x' });
// r.score            0–100
// r.subscores        { engagement, safety, reach, hook, clarity }
// r.issues[]         [{ lever, subscore, severity, impact }]  — named, no fix text
// r.fixesAvailable   count of paid fixes
```

`input` is a string or `{ text, hasMedia, mediaType, hasLinkInReply }`.

## The free/paid boundary

The line is **"does it need an LLM call?"** — the cheap, deterministic diagnosis
is free; the LLM-powered prescription and rewriting are paid. Concretely:

| | Tier |
|---|---|
| Score + subscores | free |
| Named issues (which levers are weak) | free |
| Written fixes for each issue | **pro** |
| LLM engagement prediction (sharper score) | **pro** |
| Auto-optimizer (iterate to a target) | **pro** |

## Layout

```
src/
  index.mjs                 evaluatePost (deterministic)
  platforms/x/
    weights.mjs             documented weights + tunables (cited, clean-room)
    features.mjs            deterministic feature extraction (pure)
    score.mjs               features + probabilities -> score + issues
    index.mjs               x.evaluate()
bin/score.mjs               free CLI
test/                       node:test suite
```

## Tests

```bash
cd packages/scorer && npm test
```
