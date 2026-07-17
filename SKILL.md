---
name: project-update-auto-poster
description: |
  Set up auto-posting in a GitHub repo so every merge to main automatically
  publishes a short, in-voice project update to X (Twitter) with a screenshot of
  the change. Use this skill when the user says things like: "set up auto-posting
  for this repo", "install the project update auto-poster", "auto-tweet my commits",
  "make this project self-marketing", or asks Claude to add automated X posts on
  every release/merge.
---

# project-update-auto-poster

A skill for builders who want their work to show up on social without lifting a
finger. When merged to `main`, a GitHub Actions run:

1. Pulls the merge commit and file diff.
2. Asks Gemini (free tier, with a model-fallback chain so a retired model id
   can't kill a run) to draft a post in a fixed builder voice and propose up to
   3 routes likely to showcase the change visually.
3. Gets an image (first available source wins):
   - a committed static `cover.png`, used verbatim; or
   - a **local preview build** — CI builds and serves the pushed code, then
     screenshots the candidate routes (image always matches the commit); or
   - the deployed site (optionally **deploy-gated**: wait until the deploy
     serves the pushed commit before screenshotting, so you never capture the
     old UI).
   When multiple routes are shot, Gemini vision picks the most engaging one.
4. Runs an editor pass: Gemini critiques the draft against an engagement rubric
   and the repo's recent post history (so hooks vary), then rewrites it.
5. Uploads the image to X and posts the tweet with media attached.
6. Appends the post to `.github/auto-post/history.jsonl` and commits it back
   (as a real account identity, so deploy platforms like Vercel don't block it),
   so every future run learns from what was already posted.

No human approval step — it ships every merge. Voice is baked into the pipeline
so it stays consistent across every project.

## When to invoke

Invoke this skill when the user wants to set up the auto-poster in a repo —
either the current working repo or one they name. Typical asks:

- "Set up auto-posting from this repo to X"
- "Add the project-update-auto-poster to my-cool-project"

## Two ways to install

### A. Referenced composite action (recommended)

The consumer repo keeps only a thin **caller workflow** that references the
shared action by version tag. Fixes to the skill propagate to every consumer on
the next run — no re-vendoring.

1. **Confirm the target repo** and set the five secrets (below).

2. **Add the caller workflow** at `.github/workflows/auto-post.yml` in the target
   repo:

   ```yaml
   name: Auto-post project update
   on:
     push:
       branches: [main]
       paths-ignore: ['.github/auto-post/history.jsonl']
     workflow_dispatch:
       inputs:
         sha: { required: true, type: string }
   permissions:
     contents: write
   concurrency:
     group: auto-post
     cancel-in-progress: false
   jobs:
     post:
       runs-on: ubuntu-latest
       timeout-minutes: 25
       steps:
         - uses: actions/checkout@v4
           with: { fetch-depth: 0 }
         - uses: e4-explore/e4-efficiency/actions/auto-post@v1
           with:
             gemini-api-key: ${{ secrets.GEMINI_API_KEY }}
             x-api-key: ${{ secrets.X_API_KEY }}
             x-api-secret: ${{ secrets.X_API_SECRET }}
             x-access-token: ${{ secrets.X_ACCESS_TOKEN }}
             x-access-token-secret: ${{ secrets.X_ACCESS_TOKEN_SECRET }}
             homepage-url: https://your-app.example.com
             routes: '["/", "/features"]'
             include-commit-link: 'false'
             deploy-gate-health-url: https://your-app.example.com/api/health
             sha: ${{ github.event.inputs.sha }}
   ```

3. **If the action repo (`e4-explore/e4-efficiency`) is private**, allow other org
   repos to use it: in that repo, **Settings → Actions → General → Access →
   "Accessible from repositories in the 'e4-explore' organization"**. (If the
   action repo is public, no setting is needed.)

4. **Deploy-gate (optional):** if you pass `deploy-gate-health-url`, the consumer
   must expose the deployed commit SHA from a lightweight route so the gate can
   tell when the push is live. On Vercel:

   ```ts
   // app/api/health/route.ts
   import { NextResponse } from 'next/server';
   export function GET() {
     return NextResponse.json({ commit: process.env.VERCEL_GIT_COMMIT_SHA ?? null });
   }
   ```

   The gate reads it via `deploy-gate-sha-json-path` (default `.commit`).

See `actions/auto-post/README.md` for the full input reference.

### B. Vendored (install.sh)

Self-contained: copies the workflow + script into the target repo (no external
action dependency). Good when the consumer can't use the org action.

1. **Run the installer** from this skill's directory:
   ```bash
   bash install.sh <path-to-target-repo>
   ```
   Copies `templates/auto-post.yml` → `.github/workflows/auto-post.yml` and
   `post.mjs` / `package.json` / `config.example.json` → `.github/auto-post/`.

2. Set the five secrets (below), pick an image source (cover.png, a
   `config.json` preview, or the repo's Website URL), and optionally set repo
   variables `DEPLOY_GATE_HEALTH_URL` and `INCLUDE_COMMIT_LINK`.

3. Commit and push. The next merge to `main` triggers the first post.

## Secrets (both models)

In the target repo: **Settings → Secrets and variables → Actions → Secrets**:

- `GEMINI_API_KEY` — free key from https://aistudio.google.com/apikey
- `X_API_KEY`, `X_API_SECRET` — X app "Consumer Keys"
- `X_ACCESS_TOKEN`, `X_ACCESS_TOKEN_SECRET` — X app "Authentication Tokens",
  **Read+Write** (OAuth 1.0a user-context; bearer tokens can't upload media)

## Backfilling merges that already landed

Actions tab → **Auto-post project update** → **Run workflow** → paste the commit
SHA. The deploy-gate is skipped for backfills (the old commit's deploy is gone),
so it screenshots production as-is.

## Voice

Hardcoded in `post.mjs` (`buildVoice` + `RUBRIC`). Concise builder tone, 1–2
sentences, past tense, no hype words, no exclamation marks, ≤1 emoji, under 280
chars (240 if the commit link is enabled). Edit those to retune; the referenced
action picks up the change on the next tag.

## Files in this skill

```
SKILL.md                    ← this file
README.md                   ← human-facing overview + roadmap
install.sh                  ← vendored installer (model B)
actions/auto-post/
  action.yml                ← composite action (model A)
  post.mjs                  ← bundled pipeline (same file as templates/)
  package.json
  README.md                 ← input reference
templates/
  auto-post.yml             ← vendored caller (model B) → .github/workflows/
  post.mjs                  ← → .github/auto-post/
  package.json
  config.example.json
docs/
  setup.md                  ← detailed setup walkthrough
```

## How "learning" works (and its current limits)

1. **Editor pass** — every draft is critiqued and rewritten against the `RUBRIC`.
2. **Post history memory** — published posts are appended to `history.jsonl` and
   committed back; the editor sees the last 10 and avoids repeating hooks.

What it does NOT do yet: learn from engagement (likes/impressions). That needs X
analytics beyond the free API tier — v2 candidate.

## Not in the thin slice (deliberately)

- No approval / drafts queue — auto-posts every merge.
- No commit-batching — one post per push to `main`.
- No filter for chore/docs/dep-bump commits.
- No engagement-based learning.
- Single X account per repo. Single hardcoded voice.

Each is a deliberate v2 candidate. Don't add them inline; ask the user first.
