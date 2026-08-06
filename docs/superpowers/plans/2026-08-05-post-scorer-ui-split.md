# Post-scorer UI/API Separation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the post-scorer web UI out of the private `e4-efficiency` repo into a new public `post-scorer-web` repo (a thin client with zero algorithm code), and add an `apps/api` Cloudflare Worker to `e4-efficiency` that runs the free scorer server-side behind `POST /api/v1/score`, with the paid tier stubbed at `POST /api/v1/pro/*`.

**Architecture:** The public UI contains no scoring code; it `fetch`es a versioned HTTPS API. The API is a zero-dependency Cloudflare Worker living in the private monorepo, importing `@e4/post-scorer` by relative path (bundled by wrangler). Paid code (`@e4/post-scorer-pro`) is never imported by anything public — the pro route is a 501 stub with the auth header seam reserved for the future accounts/Stripe phase.

**Tech Stack:** Node 24 (repo floor `>=20`), ESM only, Cloudflare Workers (`fetch` handler), Wrangler CLI (dev/deploy), Cloudflare Pages (static UI host), `node --test` for tests. Zero runtime dependencies.

## Global Constraints

- **Node:** `>=20` (repo `engines` floor); dev machine runs 24.
- **Modules:** ESM only (`"type": "module"`), `.mjs` for server code.
- **Runtime dependencies:** none. Hand-rolled Worker `fetch` handler and helpers. Wrangler is a **dev**-only tool.
- **Worker handler shape:** `export default { async fetch(request, env) }`, testable by calling `worker.fetch(new Request(...), env)` directly under `node --test`.
- **API version prefix:** every route is under `/api/v1/`.
- **Error body shape (every error):** `{ error: string, code: string }`.
- **Score request shape:** `{ text, hasMedia, mediaType, hasLinkInReply }` (mediaType ∈ `null | 'image' | 'video'`).
- **Score response shape:** `{ score, subscores:{engagement,safety,reach,hook,clarity}, issues, fixesAvailable, tier:'free', version }`.
- **Payload cap:** 8192 bytes on `/api/v1/score`.
- **Free scorer import path (from `apps/api/src/*.mjs`):** `../../../packages/scorer/src/index.mjs`.
- **Public repo must contain zero algorithm code:** no `packages/scorer` reference, no `evaluatePost` import. Enforced by a guard test.
- **Scorer `VERSION`:** currently `'0.1.0'` (do not hardcode elsewhere — import it).
- **Commit after every task.** Git user is already configured.

---

## File Structure

**In `e4-efficiency` (private):**
- Create `apps/api/src/http.mjs` — CORS/JSON/error response helpers.
- Create `apps/api/src/ratelimit.mjs` — fixed-window per-key limiter factory.
- Create `apps/api/src/score.mjs` — `/api/v1/score` handler (imports free scorer).
- Create `apps/api/src/index.mjs` — Worker entry + router.
- Create `apps/api/test/ratelimit.test.mjs`, `apps/api/test/api.test.mjs`.
- Create `apps/api/package.json`, `apps/api/wrangler.toml`, `apps/api/README.md`, `apps/api/API.md`.
- Delete `apps/web/index.html`, `apps/web/serve.mjs` (directory removed).

**In `post-scorer-web` (new public repo, sibling dir `/Users/ethangrove/post-scorer-web`):**
- Create `config.js` — `API_BASE` (dev/prod switch).
- Create `index.html` — ported thin-client UI.
- Create `test/guard.test.mjs` — asserts no algorithm code + API wiring.
- Create `package.json`, `README.md`, `API.md` (mirror), `.gitignore`.

---

## Task 1: API scaffold — helpers, router, health, CORS

**Files:**
- Create: `apps/api/src/http.mjs`
- Create: `apps/api/src/index.mjs`
- Create: `apps/api/package.json`
- Create: `apps/api/wrangler.toml`
- Test: `apps/api/test/api.test.mjs`

**Interfaces:**
- Produces: `allowedOrigins(env) -> string[]`, `corsHeaders(origin, env) -> object`, `json(body, {status,origin,env,headers}) -> Response`, `error(code, message, {status,origin,env,headers}) -> Response` from `http.mjs`. Default export Worker `{ fetch(request, env) }` from `index.mjs`.
- Consumes: nothing yet (scorer wired in Task 2).

- [ ] **Step 1: Create `apps/api/package.json`**

```json
{
  "name": "@e4/post-scorer-api",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "HTTP API for the post-scorer: free /api/v1/score runs @e4/post-scorer server-side; pro tier stubbed. Cloudflare Worker.",
  "scripts": {
    "test": "node --test",
    "dev": "wrangler dev",
    "deploy": "wrangler deploy"
  },
  "engines": { "node": ">=20" }
}
```

- [ ] **Step 2: Create `apps/api/wrangler.toml`**

```toml
name = "post-scorer-api"
main = "src/index.mjs"
compatibility_date = "2026-08-05"

# Public UI origins allowed to call the API (CORS allowlist), comma-separated.
# Dev: the Pages dev server on :8788. Prod value is filled in at deploy time
# (Task 8) once the Pages domain is known.
[vars]
ALLOWED_ORIGINS = "http://localhost:8788"
```

- [ ] **Step 3: Write the failing test** — `apps/api/test/api.test.mjs`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.mjs';

const ORIGIN = 'https://scorer.example';
const env = { ALLOWED_ORIGINS: ORIGIN };

export function req(path, { method = 'GET', body, origin = ORIGIN, headers = {} } = {}) {
  const h = { origin, ...headers };
  let payload;
  if (body !== undefined) {
    payload = typeof body === 'string' ? body : JSON.stringify(body);
    h['content-type'] = 'application/json';
    h['content-length'] = String(payload.length);
  }
  return new Request(`https://api.local${path}`, { method, headers: h, body: payload });
}

test('GET /api/v1/health returns ok + version, with CORS for an allowed origin', async () => {
  const res = await worker.fetch(req('/api/v1/health'), env);
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.ok, true);
  assert.equal(typeof j.version, 'string');
  assert.equal(res.headers.get('access-control-allow-origin'), ORIGIN);
});

test('OPTIONS preflight returns 204 with CORS for an allowed origin', async () => {
  const res = await worker.fetch(req('/api/v1/score', { method: 'OPTIONS' }), env);
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-methods'), 'GET, POST, OPTIONS');
});

test('disallowed origin gets no CORS header', async () => {
  const res = await worker.fetch(req('/api/v1/health', { origin: 'https://evil.example' }), env);
  assert.equal(res.headers.get('access-control-allow-origin'), null);
});

test('unknown route returns 404 with error shape', async () => {
  const res = await worker.fetch(req('/nope'), env);
  assert.equal(res.status, 404);
  assert.equal((await res.json()).code, 'NOT_FOUND');
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `cd apps/api && node --test test/api.test.mjs`
Expected: FAIL — cannot import `../src/index.mjs` (does not exist yet).

- [ ] **Step 5: Create `apps/api/src/http.mjs`**

```js
// Shared HTTP helpers for the post-scorer Worker API. Zero dependencies.

const CORS_METHODS = 'GET, POST, OPTIONS';
const CORS_HEADERS = 'content-type, authorization';

// Parse the comma-separated ALLOWED_ORIGINS env var into a trimmed list.
export function allowedOrigins(env) {
  return String(env?.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// CORS headers for a response, given the request Origin. Returns {} when the
// origin isn't allowlisted — the browser then blocks the cross-origin read.
export function corsHeaders(origin, env) {
  const list = allowedOrigins(env);
  if (!origin || !list.includes(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': CORS_METHODS,
    'Access-Control-Allow-Headers': CORS_HEADERS,
    Vary: 'Origin',
  };
}

// JSON response with CORS applied.
export function json(body, { status = 200, origin, env, headers = {} } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...corsHeaders(origin, env),
      ...headers,
    },
  });
}

// Consistent error body: { error, code }.
export function error(code, message, opts) {
  return json({ error: message, code }, opts);
}
```

- [ ] **Step 6: Create `apps/api/src/index.mjs`** (health + CORS + 404 only; score/pro added in later tasks)

```js
// Cloudflare Worker entry for the post-scorer API. Routes everything under
// /api/v1/. Zero dependencies; the free scorer is bundled by wrangler.
import { json, error, corsHeaders } from './http.mjs';
import { VERSION } from '../../../packages/scorer/src/index.mjs';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('origin');
    const { pathname } = url;

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin, env) });
    }

    if (pathname === '/api/v1/health' && request.method === 'GET') {
      return json({ ok: true, version: VERSION }, { origin, env });
    }

    return error('NOT_FOUND', 'Unknown route.', { status: 404, origin, env });
  },
};
```

- [ ] **Step 7: Run test to verify it passes**

Run: `cd apps/api && node --test test/api.test.mjs`
Expected: PASS (4 tests).

- [ ] **Step 8: Commit**

```bash
git add apps/api/package.json apps/api/wrangler.toml apps/api/src/http.mjs apps/api/src/index.mjs apps/api/test/api.test.mjs
git commit -m "feat(api): scaffold post-scorer Worker with health + CORS"
```

---

## Task 2: Free `/api/v1/score` endpoint

**Files:**
- Create: `apps/api/src/score.mjs`
- Modify: `apps/api/src/index.mjs` (route `/api/v1/score` to the handler)
- Test: `apps/api/test/api.test.mjs` (append cases)

**Interfaces:**
- Consumes: `json`, `error` from `http.mjs`; `evaluatePost`, `VERSION` from the free scorer.
- Produces: `handleScore(request, env, origin) -> Promise<Response>` from `score.mjs`.

- [ ] **Step 1: Append failing tests** to `apps/api/test/api.test.mjs`

```js
test('POST /api/v1/score returns the score shape for a real draft', async () => {
  const res = await worker.fetch(
    req('/api/v1/score', { method: 'POST', body: { text: 'what would you build first?', hasMedia: false, mediaType: null, hasLinkInReply: false } }),
    env,
  );
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(typeof j.score, 'number');
  for (const k of ['engagement', 'safety', 'reach', 'hook', 'clarity']) assert.equal(typeof j.subscores[k], 'number');
  assert.ok(Array.isArray(j.issues));
  assert.equal(j.tier, 'free');
  assert.equal(typeof j.version, 'string');
  assert.equal(res.headers.get('access-control-allow-origin'), ORIGIN);
});

test('score rejects empty text with 400', async () => {
  const res = await worker.fetch(req('/api/v1/score', { method: 'POST', body: { text: '  ' } }), env);
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, 'BAD_REQUEST');
});

test('score rejects invalid JSON with 400', async () => {
  const res = await worker.fetch(req('/api/v1/score', { method: 'POST', body: '{not json' }), env);
  assert.equal(res.status, 400);
});

test('score rejects invalid mediaType with 400', async () => {
  const res = await worker.fetch(req('/api/v1/score', { method: 'POST', body: { text: 'hi', mediaType: 'gif' } }), env);
  assert.equal(res.status, 400);
});

test('score rejects an oversize body with 413', async () => {
  const res = await worker.fetch(req('/api/v1/score', { method: 'POST', body: { text: 'x'.repeat(9000) } }), env);
  assert.equal(res.status, 413);
});

test('score rejects GET with 405', async () => {
  const res = await worker.fetch(req('/api/v1/score', { method: 'GET' }), env);
  assert.equal(res.status, 405);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && node --test test/api.test.mjs`
Expected: FAIL — score route returns 404 (not yet implemented).

- [ ] **Step 3: Create `apps/api/src/score.mjs`**

```js
// POST /api/v1/score — free tier. Validates input, runs the deterministic free
// scorer server-side, returns score + subscores + named issues. No paid code.
import { evaluatePost, VERSION } from '../../../packages/scorer/src/index.mjs';
import { json, error } from './http.mjs';

const MEDIA_TYPES = new Set([null, 'image', 'video']);
const MAX_BODY = 8192; // bytes; X posts are tiny.

export async function handleScore(request, env, origin) {
  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > MAX_BODY) return error('PAYLOAD_TOO_LARGE', 'Body too large.', { status: 413, origin, env });

  const raw = await request.text();
  if (raw.length > MAX_BODY) return error('PAYLOAD_TOO_LARGE', 'Body too large.', { status: 413, origin, env });

  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return error('BAD_REQUEST', 'Invalid JSON.', { status: 400, origin, env });
  }

  const text = typeof body?.text === 'string' ? body.text.trim() : '';
  if (!text) return error('BAD_REQUEST', 'Field "text" is required.', { status: 400, origin, env });

  const mediaType = body?.mediaType ?? null;
  if (!MEDIA_TYPES.has(mediaType)) return error('BAD_REQUEST', 'Invalid "mediaType".', { status: 400, origin, env });

  const r = await evaluatePost(
    { text, hasMedia: Boolean(body?.hasMedia), mediaType, hasLinkInReply: Boolean(body?.hasLinkInReply) },
    { platform: 'x' },
  );

  return json(
    { score: r.score, subscores: r.subscores, issues: r.issues, fixesAvailable: r.fixesAvailable, tier: 'free', version: VERSION },
    { origin, env },
  );
}
```

- [ ] **Step 4: Wire the route** — in `apps/api/src/index.mjs`, add the import and the route block above the final 404 return.

Add import near the top:

```js
import { handleScore } from './score.mjs';
```

Insert before `return error('NOT_FOUND', ...)`:

```js
    if (pathname === '/api/v1/score') {
      if (request.method !== 'POST') return error('METHOD_NOT_ALLOWED', 'Use POST.', { status: 405, origin, env });
      return handleScore(request, env, origin);
    }
```

- [ ] **Step 5: Run to verify passing**

Run: `cd apps/api && node --test test/api.test.mjs`
Expected: PASS (all Task 1 + Task 2 cases).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/score.mjs apps/api/src/index.mjs apps/api/test/api.test.mjs
git commit -m "feat(api): free /api/v1/score runs @e4/post-scorer server-side"
```

---

## Task 3: Per-IP rate limiting on `/api/v1/score`

**Files:**
- Create: `apps/api/src/ratelimit.mjs`
- Modify: `apps/api/src/index.mjs` (guard the score route)
- Test: `apps/api/test/ratelimit.test.mjs`

**Interfaces:**
- Produces: `createRateLimiter({ windowMs, max, now? }) -> { check(key) -> { allowed:boolean, retryAfter:number } }`.
- Consumes: nothing new.

- [ ] **Step 1: Write the failing test** — `apps/api/test/ratelimit.test.mjs`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRateLimiter } from '../src/ratelimit.mjs';

test('allows up to max in a window, then blocks with a retryAfter', () => {
  let t = 0;
  const rl = createRateLimiter({ windowMs: 1000, max: 2, now: () => t });
  assert.equal(rl.check('a').allowed, true);
  assert.equal(rl.check('a').allowed, true);
  const blocked = rl.check('a');
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfter >= 1);
});

test('resets after the window elapses', () => {
  let t = 0;
  const rl = createRateLimiter({ windowMs: 1000, max: 1, now: () => t });
  assert.equal(rl.check('a').allowed, true);
  assert.equal(rl.check('a').allowed, false);
  t = 1000;
  assert.equal(rl.check('a').allowed, true);
});

test('tracks keys independently', () => {
  let t = 0;
  const rl = createRateLimiter({ windowMs: 1000, max: 1, now: () => t });
  assert.equal(rl.check('a').allowed, true);
  assert.equal(rl.check('b').allowed, true);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && node --test test/ratelimit.test.mjs`
Expected: FAIL — `../src/ratelimit.mjs` does not exist.

- [ ] **Step 3: Create `apps/api/src/ratelimit.mjs`**

```js
// Fixed-window, in-memory per-key rate limiter. Best-effort: a Worker isolate is
// ephemeral and requests fan out across many isolates, so this trims abusive
// bursts within one isolate. The durable backstop is a Cloudflare WAF rate rule
// (see README). Pure factory so tests get isolated instances.
export function createRateLimiter({ windowMs, max, now = () => Date.now() }) {
  const hits = new Map(); // key -> { count, resetAt }
  return {
    check(key) {
      const t = now();
      const rec = hits.get(key);
      if (!rec || t >= rec.resetAt) {
        hits.set(key, { count: 1, resetAt: t + windowMs });
        return { allowed: true, retryAfter: 0 };
      }
      if (rec.count < max) {
        rec.count += 1;
        return { allowed: true, retryAfter: 0 };
      }
      return { allowed: false, retryAfter: Math.ceil((rec.resetAt - t) / 1000) };
    },
  };
}
```

- [ ] **Step 4: Run to verify passing**

Run: `cd apps/api && node --test test/ratelimit.test.mjs`
Expected: PASS (3 tests).

- [ ] **Step 5: Wire the limiter into `apps/api/src/index.mjs`**

Add import at the top:

```js
import { createRateLimiter } from './ratelimit.mjs';
```

Add a module-level instance below the imports (30 requests/min/IP):

```js
const limiter = createRateLimiter({ windowMs: 60_000, max: 30 });
```

Replace the score route block from Task 2 with the rate-limited version:

```js
    if (pathname === '/api/v1/score') {
      if (request.method !== 'POST') return error('METHOD_NOT_ALLOWED', 'Use POST.', { status: 405, origin, env });
      const ip = request.headers.get('cf-connecting-ip') || 'unknown';
      const rl = limiter.check(ip);
      if (!rl.allowed) {
        return error('RATE_LIMITED', 'Too many requests.', { status: 429, origin, env, headers: { 'Retry-After': String(rl.retryAfter) } });
      }
      return handleScore(request, env, origin);
    }
```

- [ ] **Step 6: Run the full API suite to confirm nothing regressed**

Run: `cd apps/api && node --test`
Expected: PASS. (The `api.test.mjs` score cases send fewer than 30 POSTs from the default `'unknown'` IP, so they stay under the limit.)

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/ratelimit.mjs apps/api/src/index.mjs apps/api/test/ratelimit.test.mjs
git commit -m "feat(api): per-IP fixed-window rate limit on /api/v1/score"
```

---

## Task 4: Pro tier stub `/api/v1/pro/*`

**Files:**
- Modify: `apps/api/src/index.mjs` (add pro route above the 404)
- Test: `apps/api/test/api.test.mjs` (append)

**Interfaces:**
- Consumes: `error` from `http.mjs`.
- Produces: nothing new. Reserves the auth seam: pro routes are POST-only and will later read `Authorization: Bearer <token>`.

- [ ] **Step 1: Append failing test** to `apps/api/test/api.test.mjs`

```js
test('pro route returns 501 NOT_AVAILABLE', async () => {
  const res = await worker.fetch(req('/api/v1/pro/optimize', { method: 'POST', body: { text: 'hi' } }), env);
  assert.equal(res.status, 501);
  assert.equal((await res.json()).code, 'NOT_AVAILABLE');
});

test('pro route rejects GET with 405', async () => {
  const res = await worker.fetch(req('/api/v1/pro/optimize', { method: 'GET' }), env);
  assert.equal(res.status, 405);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && node --test test/api.test.mjs`
Expected: FAIL — pro route currently falls through to 404.

- [ ] **Step 3: Add the pro route** in `apps/api/src/index.mjs`, immediately before the final `return error('NOT_FOUND', ...)`:

```js
    if (pathname.startsWith('/api/v1/pro/')) {
      // Paid tier — not available this phase. Auth seam reserved: when accounts +
      // Stripe land, these routes read `Authorization: Bearer <token>` and return
      // UNAUTHENTICATED / UNLICENSED, then import @e4/post-scorer-pro server-side.
      if (request.method !== 'POST') return error('METHOD_NOT_ALLOWED', 'Use POST.', { status: 405, origin, env });
      return error('NOT_AVAILABLE', 'The pro tier is not available yet.', { status: 501, origin, env });
    }
```

- [ ] **Step 4: Run to verify passing**

Run: `cd apps/api && node --test`
Expected: PASS (all API + ratelimit tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/index.mjs apps/api/test/api.test.mjs
git commit -m "feat(api): stub /api/v1/pro/* as 501 with reserved auth seam"
```

---

## Task 5: API contract doc, README, and remove `apps/web`

**Files:**
- Create: `apps/api/API.md`
- Create: `apps/api/README.md`
- Delete: `apps/web/index.html`, `apps/web/serve.mjs`

**Interfaces:** none (docs + cleanup). `API.md` is the canonical contract; Task 6 mirrors it into the public repo.

- [ ] **Step 1: Create `apps/api/API.md`**

````markdown
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
````

- [ ] **Step 2: Create `apps/api/README.md`**

````markdown
# @e4/post-scorer-api

Cloudflare Worker that serves the post-scorer over HTTP. Free `/api/v1/score`
runs `@e4/post-scorer` (imported by relative path, bundled by wrangler) server-side.
The pro tier is stubbed (`501`) until the accounts/Stripe phase. The public
`post-scorer-web` UI is the only intended caller.

## Contract
See [API.md](./API.md). Keep it in sync with the mirror in `post-scorer-web`.

## Local dev
```bash
npm install --save-dev wrangler   # first time only
npm run dev                       # wrangler dev on http://localhost:8787
```
Test the free endpoint:
```bash
curl -s -X POST http://localhost:8787/api/v1/score \
  -H 'content-type: application/json' -H 'origin: http://localhost:8788' \
  -d '{"text":"what would you build first?"}'
```

## Tests
```bash
node --test
```

## Deploy
See the repo-level deploy runbook (plan Task 8). In short:
`npx wrangler login` → `npm run deploy` → set `ALLOWED_ORIGINS` to the Pages
domain → add one Cloudflare WAF rate-limiting rule on `/api/v1/score` as the
durable backstop to the in-isolate limiter.
````

- [ ] **Step 3: Remove `apps/web`**

Run:
```bash
git rm apps/web/index.html apps/web/serve.mjs
```
Expected: both files staged for deletion. (Its only job was serving the repo root so the browser could import the free scorer — obsolete now that scoring is server-side.)

- [ ] **Step 4: Verify nothing else references `apps/web`**

Run: `grep -rn "apps/web" --include='*.md' --include='*.mjs' --include='*.yml' . || echo "no refs"`
Expected: `no refs` (or only this plan/spec). If a real reference remains (e.g. in `HANDOFF.md`), update that line to point at `apps/api` instead.

- [ ] **Step 5: Commit**

```bash
git add apps/api/API.md apps/api/README.md
git commit -m "docs(api): contract + README; remove obsolete apps/web static UI"
```

---

## Task 6: Scaffold the public `post-scorer-web` repo

**Files (new repo at `/Users/ethangrove/post-scorer-web`):**
- Create: `config.js`, `package.json`, `.gitignore`, `README.md`, `API.md`
- Test: `test/guard.test.mjs`

**Interfaces:**
- Produces: `API_BASE` (string) exported from `config.js`.

> All steps in Tasks 6–7 run inside `/Users/ethangrove/post-scorer-web`, a **separate git repo** from `e4-efficiency`.

- [ ] **Step 1: Initialize the repo**

```bash
mkdir -p /Users/ethangrove/post-scorer-web && cd /Users/ethangrove/post-scorer-web && git init
```

- [ ] **Step 2: Create `config.js`**

```js
// The only per-environment knob. On localhost the UI talks to `wrangler dev`
// (:8787); everywhere else it talks to the deployed Worker. `globalThis.location`
// is undefined under Node (tests), so API_BASE falls back to the prod URL there.
const PROD_API_BASE = 'https://post-scorer-api.REPLACE_ME.workers.dev'; // set in Task 8
const host = globalThis.location?.hostname;
export const API_BASE =
  host === 'localhost' || host === '127.0.0.1' ? 'http://localhost:8787' : PROD_API_BASE;
```

- [ ] **Step 3: Create `package.json`**

```json
{
  "name": "post-scorer-web",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "Public thin-client UI for the post-scorer. Calls the hosted API; contains no scoring algorithm.",
  "scripts": {
    "test": "node --test",
    "dev": "wrangler pages dev ."
  }
}
```

- [ ] **Step 4: Create `.gitignore`**

```gitignore
node_modules/
package-lock.json
.DS_Store
.wrangler/
```

- [ ] **Step 5: Copy the contract mirror**

```bash
cp /Users/ethangrove/e4-efficiency/apps/api/API.md /Users/ethangrove/post-scorer-web/API.md
```

- [ ] **Step 6: Create `README.md`**

````markdown
# post-scorer-web

Public thin-client UI for the **post-scorer** — a terminal-styled tool that
scores an X (Twitter) draft before you post it. This repo is **presentation
only**: it sends your draft to the hosted API and renders the result. There is
**no scoring algorithm in this repo**.

- Live: _(Cloudflare Pages URL — filled in at deploy)_
- API contract: [API.md](./API.md)

## Local dev
Run the API in the sibling `e4-efficiency` repo (`apps/api`, `npm run dev`, :8787),
then here:
```bash
npx wrangler pages dev .   # serves on http://localhost:8788
```
The UI auto-detects localhost and points at `http://localhost:8787`.

## Tests
```bash
node --test
```
Includes a guard test asserting no scorer algorithm code ever lands here.
````

- [ ] **Step 7: Write the guard test** — `test/guard.test.mjs`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('config.js exposes a string API_BASE', async () => {
  const cfg = await import('../config.js');
  assert.equal(typeof cfg.API_BASE, 'string');
  assert.ok(cfg.API_BASE.length > 0);
});
```

- [ ] **Step 8: Run to verify passing**

Run: `cd /Users/ethangrove/post-scorer-web && node --test`
Expected: PASS (1 test). (`index.html` guard assertions are added in Task 7 once the file exists.)

- [ ] **Step 9: Commit**

```bash
cd /Users/ethangrove/post-scorer-web
git add -A
git commit -m "chore: scaffold public post-scorer-web thin client"
```

---

## Task 7: Port `index.html` to a thin client

**Files (in `post-scorer-web`):**
- Create: `index.html` (ported from `e4-efficiency/apps/web/index.html`)
- Modify: `test/guard.test.mjs` (add algorithm-leak assertions)

**Interfaces:**
- Consumes: `API_BASE` from `config.js`; the API's `POST /api/v1/score`.

- [ ] **Step 1: Copy the original UI as the starting point**

Task 5 removed `apps/web` on this feature branch, but `main` still has it, so
pull the original from there (stable regardless of how many commits have landed):

```bash
git -C /Users/ethangrove/e4-efficiency show main:apps/web/index.html > /Users/ethangrove/post-scorer-web/index.html
```
(If the efficiency work was done on a differently-named base branch, substitute
that branch for `main`.)

- [ ] **Step 2: Swap the scorer import for the config import**

In `index.html`, replace:
```js
  import { evaluatePost } from '/packages/scorer/src/index.mjs';
```
with:
```js
  import { API_BASE } from './config.js';
```

- [ ] **Step 3: Rewrite `evalNow()` to call the API**

Replace the whole `evalNow` function with:
```js
  async function evalNow() {
    const text = draft.value.trim();
    if (!text) return null;
    const m = media();
    const res = await fetch(API_BASE + '/api/v1/score', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, hasMedia: m !== 'none', mediaType: m === 'none' ? null : m, hasLinkInReply: $('#linkReply').checked }),
    });
    if (!res.ok) throw new Error('score request failed: ' + res.status);
    return res.json();
  }
```

- [ ] **Step 4: Add fetch-failure handling in `runScore()`**

Replace the `runScore` function with:
```js
  let running = false;
  async function runScore() {
    if (running) return;
    const sec = $('#readoutSection');
    let r;
    try {
      r = await evalNow();
    } catch {
      running = false;
      sec.hidden = false;
      $('#boot').innerHTML = '';
      $('#result').innerHTML = '<div class="tline done c-red">scoring service unreachable — press enter to retry</div>';
      return;
    }
    if (!r) { sec.hidden = true; $('#result').innerHTML = ''; $('#boot').innerHTML = ''; return; }
    running = true;
    sec.hidden = false;
    $('#result').innerHTML = '';
    await boot();
    await paint(r, true);
    running = false;
  }
```
(Note: the original `let running = false;` line above `runScore` is now part of this block — remove the old standalone declaration so `running` isn't declared twice.)

- [ ] **Step 5: Guard the three live-repaint call sites against rejected fetches**

There are three places that call `evalNow().then((r) => r && paint(r, false))` — inside `selectMediaCursor`, the `#linkReply` change handler, and the `#media` click handler. Append `.catch(() => {})` to each so a failed network call can't throw unhandled:
```js
    if (shown() && !running) evalNow().then((r) => r && paint(r, false)).catch(() => {});
```

- [ ] **Step 6: Turn the pro CTA into an explainer (no alert)**

Replace the `#result` click handler:
```js
  $('#result').addEventListener('click', (e) => { if (e.target && e.target.id === 'proLink') { e.preventDefault(); alert('pro unlock: set POST_SCORER_LICENSE_KEY. hosted unlock flow lands here next.'); } });
```
with:
```js
  $('#result').addEventListener('click', (e) => {
    if (e.target && e.target.id === 'proLink') {
      e.preventDefault();
      if (!document.getElementById('proNote')) {
        e.target.insertAdjacentHTML('afterend', '<div id="proNote" class="tline done dim" style="margin-top:6px">pro — llm-scored hook, written fixes &amp; auto-optimize — is coming. accounts &amp; purchase land next.</div>');
      }
      e.target.style.pointerEvents = 'none';
    }
  });
```

- [ ] **Step 7: Add the algorithm-leak assertions** to `test/guard.test.mjs`

```js
test('index.html ships no scorer algorithm code and calls the API', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  assert.ok(!html.includes('packages/scorer'), 'must not reference the scorer package');
  assert.ok(!/import\s*\{[^}]*evaluatePost/.test(html), 'must not import evaluatePost');
  assert.ok(html.includes('/api/v1/score'), 'should POST to the score API');
  assert.ok(html.includes("from './config.js'"), 'should import API_BASE from config');
});
```

- [ ] **Step 8: Run to verify passing**

Run: `cd /Users/ethangrove/post-scorer-web && node --test`
Expected: PASS (config test + guard test).

- [ ] **Step 9: Manual smoke test (both servers)**

In `e4-efficiency/apps/api`: `npm run dev` (:8787). In `post-scorer-web`: `npx wrangler pages dev .` (:8788). Open `http://localhost:8788`, type a draft, press Enter twice. Expected: boot lines, big score digits, subscore bars, weak spots render — same as before, now sourced from the API. Confirm the `unlock →` link reveals the explainer and does not `alert`.

- [ ] **Step 10: Commit**

```bash
cd /Users/ethangrove/post-scorer-web
git add -A
git commit -m "feat: port UI to thin client calling /api/v1/score"
```

---

## Task 8: Deployment runbook (user-run — requires Cloudflare + GitHub accounts)

> These steps are **side-effectful and outward-facing** (create a public repo, deploy to the internet) and need the user's Cloudflare and GitHub credentials. The implementing agent should **not** run them automatically — present them for the user to execute, then help verify. No code changes here beyond filling in real URLs.

- [ ] **Step 1: Deploy the API**

```bash
cd /Users/ethangrove/e4-efficiency/apps/api
npm install --save-dev wrangler   # if not already
npx wrangler login
npm run deploy
```
Record the printed Worker URL (e.g. `https://post-scorer-api.<account>.workers.dev`).

- [ ] **Step 2: Add the durable rate-limit backstop**

In the Cloudflare dashboard → the Worker's zone/route → Security → WAF → Rate limiting rules: add one rule matching path `/api/v1/score`, e.g. 60 requests/minute per IP → Block. (Free plan includes one rate-limiting rule; this backstops the best-effort in-isolate limiter.)

- [ ] **Step 3: Create the public GitHub repo and push**

```bash
cd /Users/ethangrove/post-scorer-web
gh repo create post-scorer-web --public --source=. --remote=origin --push
```

- [ ] **Step 4: Deploy the UI to Cloudflare Pages**

```bash
npx wrangler pages deploy . --project-name post-scorer-web
```
Record the Pages URL (e.g. `https://post-scorer-web.pages.dev`).

- [ ] **Step 5: Connect the two — set the real URLs and redeploy**

1. In `post-scorer-web/config.js`, set `PROD_API_BASE` to the Worker URL from Step 1. Commit + push, then re-run Step 4.
2. In `e4-efficiency/apps/api/wrangler.toml`, set `ALLOWED_ORIGINS` to include the Pages URL from Step 4 (comma-separate localhost + prod). Commit, then re-run Step 1's `npm run deploy`.

- [ ] **Step 6: Verify end-to-end**

Open the Pages URL, score a draft. In the browser devtools Network tab, confirm the `POST /api/v1/score` request succeeds (200) and the readout renders. Confirm a request with a spoofed/other `Origin` is blocked by CORS (no `access-control-allow-origin`). Confirm `curl` to `/api/v1/pro/optimize` returns 501.

---

## Self-Review

**Spec coverage:**
- Two repos, HTTPS-only reference → Tasks 1–8. ✓
- Free scorer server-side, `/api/v1/score` → Task 2. ✓
- API in `apps/api` inside efficiency, relative import → Tasks 1–2. ✓
- Pro stubbed 501 with reserved `Authorization` seam → Task 4. ✓
- Versioned `/api/v1/` path + `version` in responses → Tasks 1–2, `API.md`. ✓
- CORS allowlist, per-IP rate limit + WAF backstop, 8 KB cap → Tasks 1, 2, 3, 8. ✓
- Public repo zero algorithm code (guard test) → Tasks 6–7. ✓
- `config.js` API_BASE dev/prod switch → Task 6. ✓
- Unlock CTA → explainer, no network → Task 7. ✓
- Delete `apps/web` → Task 5. ✓
- `API.md` canonical + mirror → Tasks 5–6. ✓
- Cloudflare Worker + Pages hosting, free-tier → Task 8. ✓
- Tests via `node --test` → every implementation task. ✓
- Out of scope (accounts/Stripe/live pro) → not built; seam reserved only. ✓

**Placeholder scan:** `REPLACE_ME` in `config.js` and `<account>` in docs are real deploy-time values set in Task 8, not plan gaps. No TODO/TBD steps. All code steps show full code.

**Type consistency:** `evalNow()` returns `Promise<result|null>` (Task 7) matching all callers. `handleScore(request, env, origin)` signature consistent (Tasks 2–3). `createRateLimiter(...).check(key) -> {allowed, retryAfter}` consistent (Tasks 3). Response shape `{score,subscores,issues,fixesAvailable,tier,version}` consistent across Task 2, `API.md`, and the UI's consumers (`r.score`, `r.subscores[name]`, `r.issues`). Error `{error,code}` consistent everywhere.
