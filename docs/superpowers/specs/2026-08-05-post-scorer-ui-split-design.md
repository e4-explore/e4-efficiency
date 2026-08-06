# Post-scorer UI/API separation — design

**Date:** 2026-08-05
**Status:** Approved pending user review

## Goal

Split the post-scorer web UI out of the private `e4-efficiency` repo into a
public repo with a shareable URL, while keeping ALL scoring code (free and
paid) server-side in private infrastructure. Users must not be able to reach
paid tooling without paying; the public repo must contain zero algorithm code.

## Decisions made

| Decision | Choice |
| --- | --- |
| Where the free scorer runs | Server-side, behind the API (not in the browser) |
| Where the API lives | `apps/api` inside `e4-efficiency` (private monorepo) |
| Paid tier this phase | Stubbed: `/api/v1/pro/*` returns 501; UI CTA is an explainer |
| Public repo name | `post-scorer-web` |
| API host | Cloudflare Worker (free tier; upgrade = Workers Paid, same code) |
| UI host | Cloudflare Pages (static) |

Future (explicitly out of scope now, but seams reserved): user accounts,
Stripe purchase, login, license redemption, live pro endpoints.

## Architecture

```
post-scorer-web (PUBLIC repo)          e4-efficiency (PRIVATE repo)
┌──────────────────────────┐           ┌────────────────────────────────┐
│ index.html (thin client) │  HTTPS    │ apps/api  (Cloudflare Worker)  │
│ config.js (API_BASE)     │ ────────► │   POST /api/v1/score  ── free  │
│ zero scorer code         │           │   POST /api/v1/pro/*  ── 501   │
└──────────────────────────┘           │   GET  /api/v1/health          │
     Cloudflare Pages                  │        │ imports (relative)    │
                                       │        ▼                       │
                                       │ packages/scorer      (free)    │
                                       │ packages/scorer-pro  (paid)    │
                                       └────────────────────────────────┘
                                            deployed via wrangler
```

The public repo "references" efficiency purely over HTTPS. No code
dependency, no submodule, no shared package.

## Components

### `apps/api` (new, in e4-efficiency)

Cloudflare Worker (`fetch` handler style), zero npm dependencies. Imports
`evaluatePost` from `../../packages/scorer/src/index.mjs` (relative, same as
scorer-pro does today).

Routes (all under `/api/v1/`):

- **`POST /api/v1/score`** — free tier, live.
  - Request: `{ text, hasMedia, mediaType, hasLinkInReply, platform }` —
    the same shape the UI's `evalNow()` builds today.
  - Response: `{ score, subscores, issues, version }` where `version` is the
    scorer's `VERSION` (correlate scores with algorithm revisions later).
- **`POST /api/v1/pro/*`** — paid tier, stubbed.
  - Always `501` with `{ error: string, code: 'NOT_AVAILABLE' }`.
  - Contract reserved now: pro routes read `Authorization: Bearer <token>`.
    Future codes: `UNAUTHENTICATED`, `UNLICENSED`. When accounts + Stripe
    land, the account system issues tokens; no contract change.
- **`GET /api/v1/health`** — `{ ok: true, version }`.

Cross-cutting:

- **CORS** — allowlist from `ALLOWED_ORIGINS` env (comma-separated). Handles
  preflight `OPTIONS`. Non-allowed origins get no CORS headers.
- **Rate limiting** — simple fixed-window per-IP counter in the Worker
  (per-isolate, best-effort) using `CF-Connecting-IP` (Cloudflare sets this;
  it is trustworthy on the platform — no X-Forwarded-For parsing needed).
  Backstop: one Cloudflare WAF rate-limiting rule (free tier includes one)
  on `/api/v1/score`.
- **Payload cap** — reject bodies over 8 KB (posts are tiny) with 413.
- **Errors** — consistent `{ error, code }` shape; JSON parse guard → 400.
- **Config** — `ALLOWED_ORIGINS` now. Signing/LLM secrets only when pro goes
  live (via `wrangler secret`).

Deploy: `wrangler.toml` in `apps/api/`, deployed with `wrangler deploy` from
the private repo. Code never leaves private infra.

### `post-scorer-web` (new public repo)

- `index.html` — today's UI with the inline module changed: the
  `import { evaluatePost } ...` line is removed; `evalNow()` becomes an async
  `fetch(API_BASE + '/api/v1/score', { method: 'POST', ... })`. All
  rendering, animation, keyboard, and step logic unchanged. Adds minimal
  fetch-failure handling (network error → terminal-styled error line).
- `config.js` — exports `API_BASE` (localhost for dev, workers.dev/custom
  domain for prod). The only per-environment knob.
- `API.md` — mirror of the contract (see below).
- `README.md` — what it is, link to hosted URL, local dev instructions.
- The `unlock →` CTA becomes an explainer ("accounts + purchase coming"),
  no network call, no alert().

Hosting: Cloudflare Pages, static, no build step.

### `API.md` — shared contract doc

There is intentionally no shared code between the repos, so the contract is
documented: canonical copy at `apps/api/API.md` in efficiency, mirrored in
`post-scorer-web`. Documents each route's request/response shapes, error
codes, and the reserved auth header. Update both on any change. (A typed
client can replace this in a later phase if drift becomes a problem.)

### Removals from e4-efficiency

- `apps/web/` (index.html + serve.mjs) is deleted. Its purpose — serving the
  repo root so the browser could import the free scorer — no longer exists.
  The UI's canonical home is `post-scorer-web`; the API replaces the server.

## Data flow

1. User types draft → picks media → Enter.
2. UI `POST ${API_BASE}/api/v1/score` with the draft payload.
3. Worker validates (origin, size, rate) → `evaluatePost` → JSON back.
4. UI renders the TUI readout exactly as today (boot lines, big digits,
   bars, weak spots).
5. Pro CTA → static explainer. No pro network path this phase.

## Security posture

- `packages/scorer-pro` is imported only by the (future) authenticated pro
  route. It is never bundled into anything public. The 501 stub imports
  nothing.
- Free scorer runs server-side too — the public repo contains no algorithm
  code at all. (Honest caveat, accepted at design time: the free scorer's
  source is already distributed to auto-post subscribers via `install.sh`
  vendoring, so server-siding it is about a consistent boundary and
  future-proofing, not secrecy of the free algorithm.)
- Free endpoint hardened: CORS allowlist, per-IP rate limit + WAF backstop,
  8 KB payload cap.
- All future secrets (license signing, LLM keys, Stripe) live only as
  Worker secrets in the private deploy.

## Error handling

- UI: fetch failure / non-2xx → terminal-styled error line ("scoring
  service unreachable — retry"), no crash, input preserved.
- API: malformed JSON → 400; oversize → 413; rate-limited → 429 with
  `Retry-After`; unknown route → 404; pro → 501. All `{ error, code }`.

## Testing

- `apps/api`: `node --test` unit tests against the `fetch` handler directly
  (Workers handlers are plain functions — testable without wrangler):
  score returns expected shape for a known draft; pro returns 501 +
  `NOT_AVAILABLE`; CORS allow/deny; payload cap; rate limit window.
- `packages/scorer`: existing tests unchanged.
- `post-scorer-web`: manual smoke against local `wrangler dev` (UI is
  presentational; its logic didn't change).

## Out of scope (future phases)

Accounts, Stripe checkout, login/session, license redemption UX, live
`/api/v1/pro/*` implementation (LLM prediction, written fixes,
auto-optimizer over HTTP), typed API client, calibration endpoints.
