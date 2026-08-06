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
