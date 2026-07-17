---
name: project-update-auto-poster
description: |
  Install an "auto-poster" into a GitHub repo so every merge to main automatically
  publishes a short, in-voice project update to X (Twitter) with a screenshot of
  the change. Use this skill when the user says things like: "set up auto-posting
  for this repo", "install the project update auto-poster", "auto-tweet my commits",
  "make this project self-marketing", or asks Claude to add automated X posts on
  every release/merge.
---

# project-update-auto-poster

A skill for builders who want their work to show up on social without lifting a
finger. When merged to `main`, a GitHub Actions workflow:

1. Pulls the merge commit, PR title/body, and file diff.
2. Asks Gemini 2.5 Flash (free tier) to:
   - Write a 1–2 sentence post in a fixed builder voice.
   - Pick the path on the deployed site that best showcases the change.
3. Screenshots that path with Playwright + Chromium.
4. Uploads the screenshot to X and posts the tweet with media attached.

No human approval step — it ships every merge. Voice is baked into this skill's
prompt so it stays consistent across every project the skill is installed in.

## When to invoke

Invoke this skill when the user wants to install the auto-poster in a repo —
either the current working repo or one they name. Typical asks:

- "Install the auto-poster in this repo"
- "Set up auto-posting from this repo to X"
- "Add the project-update-auto-poster to my-cool-project"

If the user is asking how to *change* an already-installed instance (different
voice, screenshot logic, etc.), edit the files this skill scaffolds —
`.github/workflows/auto-post.yml` and `.github/auto-post/post.mjs` — directly.

## How to install (steps Claude should run)

1. **Confirm the target repo.** Default to the user's current working directory
   if it's a git repo; otherwise ask which repo to install into.

2. **Run the installer.** From this skill's directory:
   ```bash
   bash install.sh <path-to-target-repo>
   ```
   This copies:
   - `templates/auto-post.yml` → `<target>/.github/workflows/auto-post.yml`
   - `templates/post.mjs` → `<target>/.github/auto-post/post.mjs`
   - `templates/package.json` → `<target>/.github/auto-post/package.json`

3. **Tell the user what secrets to set** in the target repo's GitHub Settings →
   Secrets and variables → Actions → Secrets:
   - `GEMINI_API_KEY` — free key from https://aistudio.google.com/apikey
   - `X_API_KEY`, `X_API_SECRET` — from the X developer portal (your app's
     "Consumer Keys")
   - `X_ACCESS_TOKEN`, `X_ACCESS_TOKEN_SECRET` — from the X developer portal
     (your app's "Authentication Tokens", with Read+Write permissions)

   Note: X requires OAuth 1.0a user-context credentials to upload media and
   post on a user's behalf. Bearer tokens alone will not work.

4. **Pick the image source:**
   - **Live screenshot (default):** ask the user to set the repo's Homepage URL
     (Settings → top of General, "Website" field) to the deployed site. The
     workflow reads this field via the GitHub API; no extra config.
   - **Static cover (no deployed UI):** for repos without a screenshot-able URL
     (skills, libs, CLIs), ask the user to commit a 1280×800 PNG at
     `.github/auto-post/cover.png`. When present, the workflow uses it
     verbatim and skips the screenshot step entirely. Homepage URL not needed.

5. **Commit and push** the new files. The next merge to `main` triggers
   the first auto-post.

6. **Backfill previous merges (optional)**. To post about a commit that
   already landed on `main`:
   - Go to the target repo's Actions tab.
   - Click "Auto-post project update" → "Run workflow".
   - Enter the commit SHA in the `sha` field and run.

   Same pipeline; just aimed at a specific SHA instead of the latest push.

## Voice

The voice is hardcoded in `templates/post.mjs`. To change it for all installs
going forward, edit the prompt in that file, then re-run `install.sh` against
each target repo (or have those repos pull the latest version of the script).

Current voice:
- Concise, builder tone — like a Show HN comment
- 1–2 short sentences, past tense, plain language
- No hype words ("amazing", "exciting", "game-changer", "thrilled")
- No exclamation marks
- At most one fitting emoji, optional
- No hashtags unless they genuinely add reach
- Under 240 characters (leaves room for the auto-appended commit link)

## Files in this skill

```
SKILL.md            ← this file
README.md           ← human-facing overview + roadmap
install.sh          ← copies templates into a target repo
templates/
  auto-post.yml     ← target: .github/workflows/auto-post.yml
  post.mjs          ← target: .github/auto-post/post.mjs
  package.json      ← target: .github/auto-post/package.json
docs/
  setup.md          ← detailed setup walkthrough for end users
```

## Not in the thin slice (deliberately)

- No approval / drafts queue — auto-posts every merge.
- No commit-batching — one post per push to `main`, even if several commits
  land together.
- No filter for chore/docs/dep-bump commits.
- Single X account per repo.
- Single hardcoded voice.

Each of these is a deliberate v2 candidate. Don't add them inline; ask the
user first.
