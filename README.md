# project-update-auto-poster

A Claude Code skill that drops a "self-marketer" into any GitHub repo. Every
merge to `main` becomes a short, in-voice post on X with a screenshot of the
change — no human in the loop.

Built for builders who'd rather ship than tweet.

## What it does

When a commit lands on `main`:

1. A GitHub Actions workflow fires.
2. The workflow asks Gemini (free tier) to write a one-sentence post — what
   changed + why it matters — in the skill's hardcoded voice, using the merged
   PR's title/body and recent commit history for the "why", plus pick the paths
   on your deployed site most likely to show the change.
3. Playwright + Chromium screenshots those paths. It can also *drive* the page
   — clicking/hovering/selecting navigational and display controls to reach a
   more compelling state (open the right screen, switch to a branded theme,
   open a menu), capturing a frame after each step — then picks the best of the
   full page, an element close-up, and the interactive frames. (Interaction
   never triggers mutating/financial/account/send actions; on by default,
   steerable per repo with `interaction-hints`.)
4. A vision pass verifies the image actually shows the change; if it doesn't,
   the model maps the diff to the repo's route files to find where the change
   renders and retries there.
5. The image is uploaded to X and the post is published with media attached.

## Install

Two ways in — see [docs/setup.md](docs/setup.md) for the full walkthrough
(including X credentials).

### A. Reference the composite action (recommended)

The consumer repo keeps only a thin caller workflow that pins the shared action
by tag; fixes propagate on the next run with no re-vendoring:

```yaml
# .github/workflows/auto-post.yml
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
    # `[skip post]` in a commit message suppresses the post for that commit
    # only — e.g. the commit that installs this workflow. Omit to post normally.
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
          deploy-gate-health-url: https://your-app.example.com/api/health
          sha: ${{ github.event.inputs.sha }}
          before-sha: ${{ github.event.before }}
          dry-run: ${{ github.event.inputs.dry-run }}
```

Full input list: [`actions/auto-post/README.md`](actions/auto-post/README.md).

**Always pass `before-sha: ${{ github.event.before }}`.** GitHub's single-commit
diff for a merge commit is always computed against its *first* parent, so only
content unique to the *second* parent shows up. A `git pull`-created merge
commit (resolving a rejected push) typically puts your own unpublished work as
the first parent — since it's on the branch you had checked out — and the
freshly-fetched remote commit as the second, so the diff shows the remote's
content, not yours. (A normal feature-branch or PR merge, where `main` is
first parent and the feature branch is second, usually isn't affected the same
way.) `before-sha` removes the ambiguity entirely by diffing the whole push's
true net range instead of relying on parent order.

**Landing the workflow without it posting about its own install commit:** put
`[skip post]` in that commit's message (the `if:` guard above skips only that
commit; `[skip post]` also works as a permanent per-commit opt-out).

**Preview before going live:** trigger the workflow manually with
`dry-run: true` — it drafts the post and screenshots the site but does not
publish to X or write history; the draft + image show up in the run's job
summary. Great for a first-time install once secrets are set.

**Static sites (e.g. Storybook on Vercel):** there's no `/api/health`, so omit
`deploy-gate-health-url`. `homepage-url` is the base origin and `routes` are
paths appended to it — for a query-routed Storybook use
`homepage-url: https://your-app.vercel.app` with
`routes: '["/?path=/story/welcome--start"]'`.

### B. Vendored (self-contained)

```bash
git clone https://github.com/e4-explore/e4-efficiency.git ~/skills/auto-poster
cd <your-target-repo>
~/skills/auto-poster/install.sh .
```

Copies the workflow + `post.mjs` into `.github/`. No external action dependency.

## Voice

The voice is hardcoded inside `templates/post.mjs` — single voice for every
project the skill is installed in, by design. Edit the `VOICE` constant in
that file to change it for all future installs.

Current voice: one statement — the feature/change itself, then why it matters
("'Create App' button — makes it faster to spin up a new project"), never
narrated as "we did X" or "renamed/added/fixed X so Y". No hype words, no
exclamation marks, ≤1 emoji, under 280 chars (240 with the commit link
enabled).

## What's in v1

- ✅ Two delivery models: referenced composite action (pin `@v1`) or vendored
- ✅ Triggers on push to `main` via GitHub Actions
- ✅ Backfill mode: manually run against any specific commit SHA
- ✅ Auto-posts (no review step)
- ✅ Direct X API via OAuth 1.0a (supports media upload)
- ✅ Gemini free tier with a model-fallback chain (survives retired model ids)
- ✅ Three image sources (first match wins): static `cover.png` → local
  preview build of the pushed code → deployed homepage URL
- ✅ Optional deploy-gate: wait until the deploy serves the pushed commit
  before screenshotting (no stale-UI screenshots)
- ✅ Multi-route screenshots with Gemini vision picking the most engaging shot
- ✅ Element close-up: the diff is mapped to the changed component and the
  screenshot zooms into it (full-page shot as fallback)
- ✅ Interactive shots: a bounded, vision-driven loop drives the page (clicks,
  hovers, theme/tab toggles, opening menus) to reach a compelling state and
  captures the best frame — safety-gated against destructive/financial actions
- ✅ Vision verification: a shot that doesn't visibly show the change triggers
  a widened route search over the repo's page files before falling back
- ✅ PR title/body + recent commit subjects feed the draft, so the post can say
  *why* a change matters, not just what it did
- ✅ Editor pass: draft is critiqued against an engagement rubric and rewritten
- ✅ Post history memory committed back (as a real identity, so Vercel doesn't
  block it) and fed into the prompt so hooks vary over time
- ✅ Optional commit-link toggle
- ✅ Single hardcoded voice

## What's deliberately not in the thin slice

These are real features, just out of scope for v1. Don't add inline — open
an issue first.

- Approval / draft queue
- Commit batching ("merge 3 small fixes into one weekly post")
- Batch backfill (post a range of commits in one run)
- Engagement-based learning (likes/impressions feeding back into the prompt —
  requires X analytics beyond the free API tier)
- Screen recordings / video posts
- Filtering chore/deps/docs commits
- Multiple social platforms (Bluesky, Mastodon, LinkedIn)
- Multiple X accounts per repo
- Per-project voice overrides
- A/B testing post variants
- Reply threads for changes too big for a single post

## Why GitHub Actions, not a hosted webhook receiver?

Zero infrastructure to host. Secrets stay in the repo. Every install is
self-contained. When you want cross-repo features (a unified posting queue,
shared analytics), that's the moment to graduate to a hosted service — not
before.

## Cost

- Gemini (flash-latest / flash-lite): free tier covers ~1500 requests/day. One
  post per merge is comfortably within that.
- GitHub Actions: free tier covers 2000 minutes/month on public repos
  (unlimited), and each post-run takes ~1 minute.
- X API: free tier allows 500 posts/month per app, more than enough for
  per-merge posting on a single repo.
