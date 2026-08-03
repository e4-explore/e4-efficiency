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

X's ranking is now the Jan-2026 **Grok/Phoenix transformer** (`xai-org/x-algorithm`):
~19 action heads predict P(action) per candidate; a Weighted Scorer sums them
(`Final Score = Σ wᵢ·P(actionᵢ)`) to sort the feed — no public denominator, it's
a *relative* number. Two hard limits: the trained model weights aren't
downloadable, and the Weighted Scorer's numeric weights are **redacted**. So
nobody outside X can compute a real score.

What *is* public is the action set and the consistent directional analyses —
**reply ≈ 27× a like**, author back-and-forth strongest, shares/follows/dwell
above likes, report/block/mute heavily negative, external links limit reach,
originality favored. We encode those directions as tunable weights and estimate
each action's probability from the post. **Treat the number as a relative guide;
the subscores and (in Pro) the suggestions are the real product.**

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
