# auto-post composite action

Reference this from any repo to auto-post a merge to X with a screenshot — or,
for an interaction/motion change (drag/reorder, expand, tab switch, hover
reveal), a short screen recording that drives the real interaction with a
synthetic cursor. It bundles the whole pipeline (`post.mjs`), so consumers keep
only a thin caller workflow instead of vendoring the script — pin a version tag
and updates propagate automatically.

## Usage

```yaml
name: Auto-post project update
on:
  push:
    branches: [main]
    paths-ignore: ['.github/auto-post/history.jsonl']
  workflow_dispatch:
    inputs:
      sha: { required: true, type: string }
      dry-run: { required: false, type: boolean, default: false }
permissions:
  contents: write
  pull-requests: read
concurrency:
  group: auto-post
  cancel-in-progress: false
jobs:
  post:
    # `[skip post]` in a commit message skips the post for that commit only.
    if: ${{ !contains(github.event.head_commit.message, '[skip post]') }}
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
          before-sha: ${{ github.event.before }}
          dry-run: ${{ github.event.inputs.dry-run }}
```

**Suppress a single commit's post** with `[skip post]` in its message — handy
for the commit that installs this workflow, so it doesn't post about itself.

**Preview without publishing:** run the workflow manually with `dry-run: true`.
The pipeline drafts + screenshots but skips the X publish and history write; the
draft and image are written to the run's job summary.

**Always pass `before-sha: ${{ github.event.before }}`.** GitHub's single-commit
diff for a merge commit is always computed against its *first* parent, so only
content unique to the *second* parent shows up. A `git pull`-created merge
commit (resolving a rejected push) typically puts your own unpublished work as
the first parent and the freshly-fetched remote commit as the second, so the
diff shows the remote's content, not yours. (A normal feature-branch or PR
merge, where `main` is first parent and the feature branch is second, usually
isn't affected the same way.) `before-sha` makes the action diff
`before...after` instead — the true net change of the whole push, regardless
of parent order.

## Inputs

| Input | Required | Default | Notes |
|-------|----------|---------|-------|
| `gemini-api-key` | yes | — | Free tier is fine. |
| `x-api-key` / `x-api-secret` | yes | — | OAuth 1.0a consumer keys. |
| `x-access-token` / `x-access-token-secret` | yes | — | Read+Write. |
| `homepage-url` | no | `''` | Deployed site to screenshot. Required unless the consumer commits `cover.png` or a `config.json` preview. |
| `routes` | no | `''` | JSON array of route paths to hint the screenshotter. |
| `project-context` | no | `''` | One or two sentences on what this project is, so posts orient a first-time reader instead of reading vague. When unset, it's auto-derived from the repo description + README intro. Grounds the copy; never pasted verbatim into a post. |
| `interactive-shots` | no | `'true'` | Let the screenshotter click/hover/select navigational + display controls to drive the page to a more compelling state before shooting. Never triggers mutating/financial/account/send actions. `'false'` = shoot routes as-loaded. |
| `interaction-hints` | no | `''` | Free-text steering for interactive shots, e.g. `"Prefer a branded theme and composed example screens over atomic component stories."` |
| `interaction-videos` | no | `'true'` | A change the model flags as an interaction/motion (drag/reorder, expand/collapse, tab switch, hover reveal, animation) is captured as a short screen recording (mp4) with a synthetic cursor instead of a still. Needs ffmpeg (present on GitHub-hosted runners) + `interactive-shots`; falls back to a still on any trouble. `'false'` = always stills. |
| `zoom-camera` | no | `'true'` | Cinematic camera for interaction recordings: after the showcase interaction lands, the view ease-zooms into the result, holds, then eases back out (FocuSee/Screen Studio look). Rendered live in the page (CSS transform), so it's pixel-sharp with no post-processing. Purely presentational — any trouble degrades to a flat clip. `'false'` = flat recordings. |
| `max-bundle-images` | no | `'4'` | A push can bundle several distinct changes (e.g. a few small fixes made alongside one main feature); this caps how many get their own image/line in the post, 1-4. Hard-capped at 4 (X's own max images per post). Most pushes are one coherent change and get exactly 1 either way. |
| `include-commit-link` | no | `'false'` | Append the commit URL to the post. |
| `gemini-model` | no | `''` | Pin a model id; else the fallback chain is used. |
| `deploy-gate-health-url` | no | `''` | Poll (push-only) until it reports the pushed SHA before screenshotting. |
| `deploy-gate-sha-json-path` | no | `'.commit'` | jq path to the SHA in the health response. |
| `deploy-gate-timeout-seconds` | no | `'720'` | Deploy-gate timeout. |
| `history-commit-name` | no | `${{ github.actor }}` | git identity for the history commit. |
| `history-commit-email` | no | `${{ github.actor_id }}+${{ github.actor }}@users.noreply.github.com` | Maps to a real, trusted deployer (matters for Vercel). |
| `github-token` | no | `${{ github.token }}` | Reads commit context, pushes history. |
| `sha` | no | `''` | Backfill a specific commit. Empty on push = the pushed commit. |
| `before-sha` | no | `''` | Branch tip before this push (`${{ github.event.before }}`). Diffs `before...after` for the true net change instead of the single pushed commit's diff — fixes merge commits. Empty falls back to the single-commit diff. |
| `dry-run` | no | `'false'` | Draft + screenshot only; skip the X publish and history write. Output goes to the job summary. |

## Consumer-side config (optional, committed in the consumer repo)

- `.github/auto-post/cover.png` — static image, used verbatim (highest priority).
- `.github/auto-post/config.json` — `{ "preview": {...}, "routes": [...], "projectContext": "…", "includeCommitLink": bool }`.
  A `preview` build/serve makes screenshots match the exact commit (no deployed
  URL needed). `projectContext` is what the project is, so posts orient a
  first-time reader (auto-derived from the repo description + README when
  omitted). `routes`/`projectContext`/`includeCommitLink` here are overridden by
  the action inputs when those are set.
- `.github/auto-post/history.jsonl` — written by the action and committed back;
  the caller's `paths-ignore` keeps that commit from retriggering the workflow.

### Scripted flows (optional)

`config.json` may include a `flows` array — owner-defined **product flows in
natural language**. When a merge's change is an interaction (`capture: "video"`)
and matches a flow, the poster records that whole flow instead of guessing one
interaction: **Gemini performs each step** (finds the control, does the action)
and a **click-following camera** zooms on every click and pans to the next,
then punches in on the result.

```json
{
  "flows": [
    {
      "name": "score a post",
      "match": { "navTarget": "scorer", "paths": ["src/scorer/**"] },
      "url": "/",
      "steps": [
        "type a short, punchy sample X post into the draft field",
        "click the media tab",
        "choose the video option",
        "press enter to score it"
      ],
      "payoff": "the score result"
    }
  ]
}
```

- `match` — a flow fires for a video change whose detected component/screen
  contains `navTarget` (case-insensitive substring) **or** whose changed files
  match any `paths` glob. A flow with no `match` runs only when it's the sole
  flow defined.
- `steps` — natural-language instructions, one action each (`type`, click,
  `select`, `hover`, `press enter`). Safety-gated: a step can never trigger a
  destructive/financial/send control.
- `url` — start path (default `/`). `payoff` — optional text describing the
  result to punch in on at the end.
- Fail-open: no flow, no match, or any trouble → the autonomous recorder (then a
  still). `zoom-camera: false` records flows flat.

## Deploy-gate

If `deploy-gate-health-url` is set, the action waits (on push only) until that
endpoint reports the pushed commit SHA, so it never screenshots a stale deploy.
The consumer must expose the deployed commit from a lightweight route. On
Vercel:

```ts
// app/api/health/route.ts
import { NextResponse } from 'next/server';
export function GET() {
  return NextResponse.json({ commit: process.env.VERCEL_GIT_COMMIT_SHA ?? null });
}
```

Then set `deploy-gate-sha-json-path: '.commit'` (the default).
