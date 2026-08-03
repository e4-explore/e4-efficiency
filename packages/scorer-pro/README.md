# @e4/post-scorer-pro (paid tier)

The paid layer on top of the free [`@e4/post-scorer`](../scorer). It adds the
value that costs money to run and is hard to copy, and it **requires a valid
license key**.

- **Written fixes** — turns the free tier's named issues into specific, actionable
  guidance (the "how" the free tier withholds).
- **LLM engagement prediction** — blends a model's semantic judgment (hook,
  originality, reply-worthiness, risk) with the deterministic feature priors for
  a sharper score.
- **Auto-optimizer** — iterates the post, rewriting toward a target score without
  leaving the voice/brand constraints you pass in.

Bring your own LLM key (Gemini/Claude/Grok) — you pay for your own tokens; the
license pays for the calibrated optimizer IP and its ongoing updates.

## Licensing

Enforcement is an **offline-verifiable ed25519 license key** — no phone-home, no
runtime dependency on our servers. Every paid entry point calls `assertLicensed`
and throws `code: 'UNLICENSED'` without a valid key.

- Verify: the public key is embedded in [`src/license.mjs`](src/license.mjs).
- Sign (server-side, on subscribe): [`scripts/sign-license.mjs`](scripts/sign-license.mjs),
  reading the private key from `POST_SCORER_SIGNING_KEY`. Keep the private key in
  a secret store; ship only the public half.

```bash
# server-side, when a customer subscribes:
POST_SCORER_SIGNING_KEY="$(cat private.pem)" \
  node scripts/sign-license.mjs --sub cust_123 --plan pro --days 365
```

The offline model is bypassable by a determined user patching the check out. The
moat isn't cryptographic — it's the private optimizer code plus the continuously
recalibrated weights/prompts that ship on the moving `v1` tag; a bypassed
snapshot goes stale.

## API

```js
import { evaluatePro, optimizePost } from '@e4/post-scorer-pro';

const r = await evaluatePro('draft', { llm, licenseKey });
// r.score, r.subscores, r.suggestions[] (written), r.critique

const best = await optimizePost('draft', {
  llm, licenseKey, constraints: VOICE_RULES, targetScore: 85, maxIterations: 3,
});
// best.best.text, best.best.evaluation, best.iterations[] (full trace)
```

`llm` is an adapter `async (prompt) => parsedJsonObject`; `licenseKey` defaults to
`POST_SCORER_LICENSE_KEY`. Adapters for Gemini/Claude/Grok are in
[`src/provider.mjs`](src/provider.mjs).

## CLI

```bash
POST_SCORER_LICENSE_KEY=... GEMINI_API_KEY=... \
  node packages/scorer-pro/bin/score-pro.mjs "draft" --media image --optimize
```

## Tests

```bash
cd packages/scorer-pro && npm test
```
