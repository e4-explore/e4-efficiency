# Consumer notes — field learnings from a real install

Notes from installing the referenced composite action (`@v1`) into a
Storybook-on-Vercel side project. Complements [setup.md](setup.md); this file is
the "what actually tripped me up" companion. Several items here are now fixed in
the templates/action — kept for context.

## The one thing that isn't hands-off: secrets

`install.sh` (vendored) and the referenced action both leave the five secrets to
the human. That's the only step blocking a true one-shot install. To close it,
provision them with `gh` from a git-ignored file instead of the GitHub UI:

```bash
# .env.autopost is git-ignored; never pass secret values on argv or in a prompt.
gh auth status >/dev/null || { echo "run: gh auth login"; exit 1; }
set -a; . ./.env.autopost; set +a
for k in GEMINI_API_KEY X_API_KEY X_API_SECRET X_ACCESS_TOKEN X_ACCESS_TOKEN_SECRET; do
  printf '%s' "${!k}" | gh secret set "$k" --app actions && echo "set $k"
done
```

Consider folding this into `install.sh` (guarded by `command -v gh`) so the
vendored path is one command end-to-end.

### Finding the right values on X's Developer Console

The X Developer Console shows **two separate credential sets** on the same
"Keys & Tokens" page for an app, and it's easy to grab the wrong one:

| Repo secret | Console field | Where |
|---|---|---|
| `X_API_KEY` | **OAuth 1.0 → Consumer Key** | top of the "OAuth 1.0 Keys" box |
| `X_API_SECRET` | **OAuth 1.0 → Consumer Secret** | paired with Consumer Key, under the same "Show" |
| `X_ACCESS_TOKEN` | **OAuth 1.0 → Access Token** | click "Generate" if it isn't already |
| `X_ACCESS_TOKEN_SECRET` | **OAuth 1.0 → Access Token Secret** | generated at the same moment as the Access Token, shown once |
| `GEMINI_API_KEY` | not on this page — [aistudio.google.com/apikey](https://aistudio.google.com/apikey) | separate service entirely |

**Ignore the "OAuth 2.0 Keys" box** (Client ID / Client Secret) — `post.mjs`
authenticates via `twitter-api-v2` using OAuth 1.0a only, so the OAuth 2.0
values are a red herring here and won't work if pasted in by mistake.

Gotchas when generating the Access Token:
- If the "Access Token" row still shows **"Generate"** (not "Regenerate"), no
  token exists yet for this app — any value already sitting in the
  `X_ACCESS_TOKEN*` repo secrets predates it and should be treated as stale.
- The token is shown **exactly once**. Copy both the Access Token and Access
  Token Secret into the repo secrets immediately — there's no way to view
  them again after navigating away; you'd have to regenerate.
- The token binds to whichever X account is logged into that browser session
  at generate-time (shown as "For @handle" next to the button) — log into the
  account you actually want posting *before* clicking Generate, not after.
- The app must have **Read and write** permissions, or the tweet publish
  step (and the media upload before it) will fail with a 403.

## Don't post about the install commit

Adding the workflow is itself a push to `main`, so without a guard the poster's
first act is tweeting about installing the poster. The templates now ship a job
guard:

```yaml
if: ${{ !contains(github.event.head_commit.message, '[skip post]') }}
```

Put `[skip post]` in the install commit (and any future commit you don't want
tweeted). Prefer this over `[skip ci]`, which also skips release/other workflows.

## Preview before it's tied to real merges

Use `dry-run: true` via `workflow_dispatch` for the first run: it drafts + shoots
the screenshot but doesn't publish to X, and writes the draft + image to the job
summary. Verify voice and that the screenshot actually shows your UI, then let
real merges take over.

## Static sites (Storybook on Vercel)

- No `/api/health` endpoint → **omit `deploy-gate-health-url`.** Trade-off: right
  after a deploy the screenshot could catch stale UI. If that bites, add a real
  readiness URL or a fixed settle delay.
- Storybook is **query-routed**, not path-routed. `homepage-url` is the base
  origin and `routes` are appended paths:
  ```yaml
  homepage-url: https://your-app.vercel.app
  routes: '["/?path=/story/welcome--start"]'
  ```

## Private cross-repo action access

If `e4-efficiency` is private and the consumer repo is different, the `uses:`
step 404s at runtime unless the action repo allows it: **e4-efficiency → Settings
→ Actions → Access → "Accessible from repositories owned by e4-explore."**

## `@v1` = auto-update (by design)

Pinning the moving `@v1` tag is what makes upstream fixes propagate with zero
consumer changes — the whole point. The cost is trust: you run whatever `v1`
currently points at. Anyone who wants reproducibility over auto-update can pin a
SHA instead.

## Public repos, secrets, and blast radius

Making a consumer repo public does NOT expose Actions secrets — they're
encrypted, never in the source, and masked (`***`) in logs. Fork PRs get no
secrets, and this workflow only triggers on `push` to main and
`workflow_dispatch` (collaborators only), so outsiders can't run it at all.
What public DOES change:

- **Actions logs become world-readable.** If a secret ever dodges masking
  (base64, concatenation, a debug echo), it's public. Never print secrets.
- **Never add `pull_request_target` or check out + execute untrusted PR code**
  in a workflow on a public repo while secrets are in scope — that's the
  classic exfiltration vector. This workflow deliberately has neither.

Because one X/Gemini credential set is typically shared across every install,
a leak in ANY repo burns them ALL — and the X tokens can post as you. So:

- Scope org secrets to **Selected** private repos, not "all repositories",
  if any repo in the org is public.
- Give a public repo its own X app/token (and ideally its own Gemini key) so
  a leak is contained to that one project.
- On suspected exposure: rotate everywhere (X developer portal → regenerate;
  Google AI Studio → new key).

## Trunk-based repos with a release bot

If the consumer auto-releases on merge to `main`, `git pull --rebase` before
pushing the install commit or the push is rejected by the bot's version bump.

---

## One-shot install prompt (paste into Claude Code in a future repo)

> Provide secret values out-of-band (git-ignored `./.env.autopost` or exported
> env vars), NOT inline — keeps them out of chat history.

```
Install the e4-efficiency auto-poster into this repo, set up for all future merges.

1. Add .github/workflows/auto-post.yml using
   e4-explore/e4-efficiency/actions/auto-post@v1, copying the README's §A caller
   example verbatim — including the `[skip post]` job guard and the
   workflow_dispatch dry-run input.
2. homepage-url = <MY_DEPLOYED_URL>; routes = <JSON array>. This is a
   <Storybook | app> site, so use <query-param | path> routing and
   <omit | set> deploy-gate-health-url.
3. Set the five repo secrets with `gh secret set`, reading values from
   ./.env.autopost or the environment. Never echo them. If gh is missing/unauthed,
   stop and give me the exact commands.
4. Commit with `[skip post]` in the message, `git pull --rebase`, push to main.
5. If e4-efficiency is private, remind me to enable its org Actions access for
   this repo.
6. Trigger a workflow_dispatch run with dry-run=true against HEAD and report the
   drafted text + job-summary image so I can eyeball it before it goes live.
```
