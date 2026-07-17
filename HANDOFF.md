# Handoff prompt — project-update-auto-poster

Copy everything below the line into a new session to continue.

---

I'm continuing work on a Claude Code skill called **project-update-auto-poster**.
It's a "self-marketer" for builders: when code merges to `main`, a GitHub
Actions workflow auto-generates a short, in-voice post about the change (with a
screenshot) and publishes it to X. No human in the loop.

## Where the code lives

- Repo: `e4-explore/e4-efficiency`
- Branch: `claude/project-update-auto-poster-d8ol8k` (do all work here; create it
  from origin if the fresh container doesn't have it)
- This session's GitHub access may be scoped to specific repos — check what you
  can reach before assuming you can touch SoccerProps directly.

## What's already built (on that branch)

```
SKILL.md                 ← skill definition + when-to-invoke
README.md                ← overview, feature list, roadmap
install.sh               ← copies templates/ into any target repo's .github/
docs/setup.md            ← full end-user setup walkthrough
templates/
  auto-post.yml          ← GitHub Actions workflow
  post.mjs               ← the whole pipeline (Gemini + Playwright + X API)
  package.json           ← pins playwright + twitter-api-v2
  config.example.json    ← optional per-repo preview-build config
.github/                 ← the skill dogfooded into THIS repo (same files)
```

Pipeline in `post.mjs`:
1. Pull commit context from the GitHub API.
2. Gemini 2.5 Flash (free tier) drafts post text + proposes up to 3 routes to
   screenshot.
3. Image source, first match wins:
   a. `.github/auto-post/cover.png` — static image, used verbatim
   b. `config.json` `preview` — build & serve the pushed code in CI, screenshot
      candidate routes locally (image always matches the commit)
   c. repo homepage URL — screenshot the deployed site
   When multiple routes are shot, Gemini vision compares the actual images and
   picks the most engaging one.
4. Editor pass: Gemini critiques the draft against an engagement RUBRIC + the
   last 10 posts from history, then rewrites it.
5. Post to X (OAuth 1.0a, media upload). Append to
   `.github/auto-post/history.jsonl`, which the workflow commits back so future
   runs vary their hooks/structure.

Voice is hardcoded (VOICE const in post.mjs): concise builder tone, 1–2
sentences, past tense, no hype words, no exclamation marks, ≤1 emoji, <240 chars.

Triggers: push to `main`, plus manual `workflow_dispatch` with a `sha` input for
backfilling merges that already landed.

## Known limits (deliberate v2 candidates)

- Learns from its OWN output (rubric + history), NOT from engagement
  (likes/impressions) — that needs X analytics beyond the free API tier.
- No approval/draft queue, no commit batching, no chore/docs filtering, single
  hardcoded voice, single X account per repo, no video/screen-recording posts.

## The actual goal right now

Get the auto-poster live on my **SoccerProps** project and post about updates
I've already pushed there.

State of that effort:
- ✅ All five GitHub secrets are already set in SoccerProps:
  `GEMINI_API_KEY`, `X_API_KEY`, `X_API_SECRET`, `X_ACCESS_TOKEN`,
  `X_ACCESS_TOKEN_SECRET` (X app is OAuth 1.0a, Read+Write).
- ⬜ Install the skill files into SoccerProps (`install.sh`).
- ⬜ Configure an image source — likely Option B (local preview build) since it
  always matches the commit. Need SoccerProps' real build/serve command, port,
  and key routes.
- ⬜ Commit + push `.github/` to SoccerProps `main` (that push triggers the first
  post).
- ⬜ Backfill recent merges: SoccerProps → Actions → "Auto-post project update"
  → Run workflow → paste each commit SHA.

Please help me finish the SoccerProps rollout. Start by confirming what repo
access you have and asking me for SoccerProps' build command / port / routes if
you can't infer them.
