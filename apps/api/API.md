# Post-scorer API — contract (v1)

Base URL: the deployed Worker (e.g. `https://post-scorer-api.<account>.workers.dev`).
All routes are under `/api/v1/`. All error responses are `{ "error": string, "code": string }`.
CORS is restricted to the origins in the Worker's `ALLOWED_ORIGINS` var.

## GET /api/v1/health
`200 → { "ok": true, "version": "0.1.0" }`

## POST /api/v1/score  (free)
Request:
```json
{ "text": "your draft", "hasMedia": false, "mediaType": null, "hasLinkInReply": false }
```
- `text` (string, required, trimmed, non-empty)
- `hasMedia` (bool), `mediaType` (`null` | `"image"` | `"video"`), `hasLinkInReply` (bool)
- Body capped at 8192 bytes.

The grade is identical on every plan: an LLM-informed score run server-side with
the operator's `GEMINI_API_KEY`. Without that secret it degrades to the
deterministic heuristic grade (`predictionSource: "features"`, `critique: null`).

Response `200`:
```json
{
  "score": 62,
  "subscores": { "engagement": 55, "safety": 90, "reach": 40, "hook": 70, "clarity": 80 },
  "issues": [ { "lever": "no-media", "subscore": "reach", "impact": 0.25, "severity": "high" } ],
  "critique": "one-line semantic read, or null on the deterministic path",
  "fixesAvailable": 1,
  "tier": "free",
  "predictionSource": "hybrid",
  "version": "0.1.0"
}
```
Errors: `400 BAD_REQUEST`, `405 METHOD_NOT_ALLOWED`, `413 PAYLOAD_TOO_LARGE`, `429 RATE_LIMITED` (with `Retry-After`).

## POST /api/v1/pro/*  (paid — the tools that CHANGE the post)
The grade is free (above); what's gated here is turning it into written fixes and
auto-rewriting. Auth: `Authorization: Bearer <license-key>` — Ed25519, verified
offline via WebCrypto. Missing → `401 UNAUTHENTICATED`; invalid → `401 UNLICENSED`.
Rate-limited like `/score`. Uses the operator's `GEMINI_API_KEY`; without it,
`/fixes` still returns deterministic guidance and `/optimize` reports `no-llm`.
Do not ship pro algorithm code to any public surface — these run server-side only.

- **POST /api/v1/pro/fixes** → `{ score, subscores, issues, critique, suggestions[], tier, predictionSource }`
- **POST /api/v1/pro/optimize** → `{ best: { text, evaluation }, iterations[], improved, reason, targetReached, tier }`
  - optional body knobs: `targetScore` (1–100, default 85), `maxIterations` (1–5, default 3), `constraints` (string).

(When accounts + Stripe land, mint the bearer license on subscribe — nothing in
these routes changes.)
