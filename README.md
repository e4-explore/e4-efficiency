# project-update-auto-poster

A Claude Code skill that drops a "self-marketer" into any GitHub repo. Every
merge to `main` becomes a short, in-voice post on X with a screenshot of the
change — no human in the loop.

Built for builders who'd rather ship than tweet.

## What it does

When a commit lands on `main`:

1. A GitHub Actions workflow fires.
2. The workflow asks Gemini 2.5 Flash (free tier) to write a 1–2 sentence post
   in the skill's hardcoded voice, plus pick the path on your deployed site
   that best showcases the change.
3. Playwright + Chromium screenshots that path.
4. The screenshot is uploaded to X and the post is published with media attached.

## Install

If you're inside Claude Code, just ask:

> Install the project-update-auto-poster in this repo.

The skill runs `install.sh` against the current repo. To install manually:

```bash
git clone https://github.com/e4-explore/e4-efficiency.git ~/skills/auto-poster
cd <your-target-repo>
~/skills/auto-poster/install.sh .
```

This drops two files into your repo:

```
.github/workflows/auto-post.yml
.github/auto-post/post.mjs
.github/auto-post/package.json
```

Then follow the post-install steps the script prints (set 5 secrets, set the
repo's homepage URL, commit, push).

See [docs/setup.md](docs/setup.md) for a step-by-step walkthrough, including
how to obtain X developer credentials.

## Voice

The voice is hardcoded inside `templates/post.mjs` — single voice for every
project the skill is installed in, by design. Edit the `VOICE` constant in
that file to change it for all future installs.

Current voice: concise builder tone, 1–2 sentences, past tense, no hype words,
no exclamation marks, ≤1 emoji, under 240 chars.

## What's in the thin slice

- ✅ Triggers on push to `main` via GitHub Actions
- ✅ Backfill mode: manually run against any specific commit SHA
- ✅ Auto-posts (no review step)
- ✅ Direct X API via OAuth 1.0a (supports media upload)
- ✅ Gemini 2.5 Flash for text generation (free tier)
- ✅ Screenshots a chosen subpath of the repo's homepage URL, OR uses a static
  `.github/auto-post/cover.png` if committed (for repos without a deployed UI)
- ✅ Single hardcoded voice

## What's deliberately not in the thin slice

These are real features, just out of scope for v1. Don't add inline — open
an issue first.

- Approval / draft queue
- Commit batching ("merge 3 small fixes into one weekly post")
- Batch backfill (post a range of commits in one run)
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

- Gemini 2.5 Flash: free tier covers ~1500 requests/day. One post per merge is
  comfortably within that.
- GitHub Actions: free tier covers 2000 minutes/month on public repos
  (unlimited), and each post-run takes ~1 minute.
- X API: free tier allows 500 posts/month per app, more than enough for
  per-merge posting on a single repo.
