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

Response `200`:
```json
{
  "score": 62,
  "subscores": { "engagement": 55, "safety": 90, "reach": 40, "hook": 70, "clarity": 80 },
  "issues": [ { "lever": "no-media", "subscore": "reach", "impact": 0.25, "severity": "high" } ],
  "fixesAvailable": 1,
  "tier": "free",
  "version": "0.1.0"
}
```
Errors: `400 BAD_REQUEST`, `405 METHOD_NOT_ALLOWED`, `413 PAYLOAD_TOO_LARGE`, `429 RATE_LIMITED` (with `Retry-After`).

## POST /api/v1/pro/*  (paid — not available yet)
Always `501 → { "error": "...", "code": "NOT_AVAILABLE" }`.
Reserved for the accounts/Stripe phase: will read `Authorization: Bearer <token>`
and return `UNAUTHENTICATED` / `UNLICENSED`. Do not ship pro code to any public surface.
