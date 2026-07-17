# Setup walkthrough

Step-by-step for setting up the auto-poster in a new repo. There are two
delivery models — pick one:

- **A. Referenced composite action (recommended)** — a thin caller workflow
  pins the shared action; fixes propagate automatically. Jump to
  [§1A](#1a-reference-the-composite-action-recommended).
- **B. Vendored** — copy the script into the repo; self-contained. Jump to
  [§1B](#1b-vendored-install).

Steps 2–4 (credentials, secrets) are identical for both.

## 1A. Reference the composite action (recommended)

Add `.github/workflows/auto-post.yml` to the target repo:

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
  pull-requests: read
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

**Org access (private action repo).** If `e4-explore/e4-efficiency` is private,
other org repos can't reference its action until you allow it: in that repo,
**Settings → Actions → General → Access** → select **"Accessible from
repositories in the 'e4-explore' organization."** If the repo is public, skip
this.

**Pin a version.** `@v1` tracks the latest v1.x. Pin `@v1.0.0` for an immutable
version. See [§5](#5-pick-an-image-source) for image sources and
[§6](#6-deploy-gate-optional) for the deploy-gate.

Then continue at [§2](#2-get-a-gemini-api-key-free).

## 1B. Vendored install

From this skill's directory:

```bash
./install.sh /path/to/your/repo
```

This creates files under `.github/` in the target repo. `post.mjs` is fair
game for per-repo tweaks if you ever need to diverge from the shared behavior.
Deploy-gate and commit-link are driven by repo **variables**
(`DEPLOY_GATE_HEALTH_URL`, `INCLUDE_COMMIT_LINK`) in this model.

## 2. Get a Gemini API key (free)

1. Visit https://aistudio.google.com/apikey
2. Sign in with a Google account.
3. Click "Create API key" → pick or create a project.
4. Copy the key.

Free tier as of 2026: ~1500 requests/day on `gemini-2.5-flash`, which is
plenty for per-merge posting.

## 3. Get X (Twitter) credentials

You need **OAuth 1.0a user-context** credentials (not just a bearer token —
media upload requires user context).

1. Sign up at https://developer.x.com/.
2. Create a Project, then an App inside it.
3. In your App → **User authentication settings**: enable OAuth 1.0a,
   set permissions to **Read and write** (or higher), set a callback URL
   (any valid HTTPS URL — it's required but not actually used here).
4. In your App → **Keys and tokens**:
   - Copy **API Key** and **API Key Secret** under "Consumer Keys".
   - Generate and copy **Access Token** and **Access Token Secret** under
     "Authentication Tokens". Confirm the permissions next to them say
     "Read and Write".
5. If you change permissions later, you must regenerate the access tokens
   — old tokens keep the old permission scope.

Free tier as of 2026: 500 posts/month per app on the X API free tier.

## 4. Set the repo secrets

In the target repo on GitHub: **Settings → Secrets and variables → Actions
→ New repository secret**. Add all five:

| Secret name             | Value                                 |
|-------------------------|---------------------------------------|
| `GEMINI_API_KEY`        | from step 2                           |
| `X_API_KEY`             | Consumer "API Key"                    |
| `X_API_SECRET`          | Consumer "API Key Secret"             |
| `X_ACCESS_TOKEN`        | Authentication "Access Token"         |
| `X_ACCESS_TOKEN_SECRET` | Authentication "Access Token Secret"  |

## 5. Pick an image source

Three options, checked in this priority order — the first one configured wins.
In the **referenced** model, `routes` and the deployed URL come from the action
inputs (`routes`, `homepage-url`); in the **vendored** model they come from
`config.json` and the repo's Website field. `cover.png` and `config.json`
preview live in `.github/auto-post/` in the consumer repo either way.

### Option A — Static cover image

Drop a PNG at:

```
.github/auto-post/cover.png
```

Recommended size: 1280×800. Used verbatim on every post; screenshot logic is
skipped entirely. Best for libraries, CLIs, or anything without a UI.

### Option B — Local preview build (screenshots always match the commit)

Rename `.github/auto-post/config.example.json` to `config.json` and fill in
how to build and serve your app:

```json
{
  "preview": {
    "command": "npm ci && npm run build && npx serve -l 4173 dist",
    "port": 4173,
    "readyPath": "/",
    "timeoutSeconds": 180
  },
  "routes": ["/", "/props", "/leaderboard"]
}
```

CI runs `command` from the repo root, waits for `port` to answer on
`readyPath`, then screenshots up to 3 candidate routes Gemini proposes from
the diff (the optional `routes` list tells it which pages exist). Gemini's
vision then looks at the actual screenshots and picks the most engaging one —
preferring real content over empty states or generic landing pages.

No deployed URL needed, and the screenshot reflects the exact pushed code
rather than whatever happens to be deployed.

### Option C — Screenshot the deployed site

- **Referenced model:** set the `homepage-url` input on the action.
- **Vendored model:** GitHub **Settings → top of General → Website** → paste the
  deployed URL (the workflow reads it via the API).

Same multi-route + vision-pick flow as Option B, but against the live site. If
your deploy lags the merge, the screenshot may show the old UI — use the
deploy-gate (§6) to prevent that, or prefer Option B.

## 6. Deploy-gate (optional)

When you screenshot the **deployed** site, a lagging deploy can serve the old UI
at screenshot time. The deploy-gate polls a health endpoint (on push only, never
for backfills) until it reports the pushed commit SHA, then proceeds — or fails
rather than posting something stale.

**Enable it:**

- **Referenced model:** set `deploy-gate-health-url` (and optionally
  `deploy-gate-sha-json-path`, default `.commit`, and
  `deploy-gate-timeout-seconds`, default 720).
- **Vendored model:** set repo **variables** `DEPLOY_GATE_HEALTH_URL` (and
  optionally `DEPLOY_GATE_SHA_JSON_PATH`, `DEPLOY_GATE_TIMEOUT_SECONDS`).

**Consumer side — expose the deployed commit SHA.** The health endpoint must
return the commit currently live. On Vercel, `VERCEL_GIT_COMMIT_SHA` is provided
automatically:

```ts
// app/api/health/route.ts  (Next.js App Router)
import { NextResponse } from 'next/server';
export function GET() {
  return NextResponse.json({ commit: process.env.VERCEL_GIT_COMMIT_SHA ?? null });
}
```

The gate reads `.commit` from that JSON by default; point
`deploy-gate-sha-json-path` elsewhere if your route nests it differently.

## 7. How posts improve over time

Two mechanisms are built in:

- **Editor pass** — every draft is critiqued against an engagement rubric
  (lead with the payoff, concrete over abstract, one idea per post) and
  rewritten before posting. The rubric lives in `post.mjs` as `RUBRIC`.
- **Post history memory** — each published post is appended to
  `.github/auto-post/history.jsonl`, which the workflow commits back to
  `main` (with a guard so it doesn't retrigger itself). The editor sees the
  last 10 posts and avoids repeating their hooks and structure.

To steer the style, edit `RUBRIC` or `VOICE` in `post.mjs` — or delete lines
from `history.jsonl` if you want it to forget something.

## 8. Commit and push

```bash
git add .github
git commit -m "Add project-update-auto-poster workflow"
git push
```

That push itself triggers the first run. Watch the Actions tab; if it
succeeds, you'll see a tweet on your X account within ~1 minute.

## 9. (Optional) Backfill posts for merges that already landed

The workflow also supports manual runs, so you can post about a commit that
was merged before you set up the auto-poster.

1. In the target repo on GitHub, go to the **Actions** tab.
2. Pick **Auto-post project update** in the left sidebar.
3. Click **Run workflow** (top right).
4. Paste the commit SHA into the `sha` input and click Run.

The workflow uses that SHA for the Gemini context, but otherwise behaves like a
push-triggered run (same voice, same image logic). The deploy-gate is skipped
for backfills — the already-landed commit won't match the current production
SHA, so it screenshots production as-is.

Repeat once per commit you want backfilled. There's no batch mode yet.

## Troubleshooting

**Missing HOMEPAGE_URL error** — configure an image source: `cover.png`
(option A), a `config.json` preview (option B), or the deployed URL (option C —
the `homepage-url` input in the referenced model, or the Website field in the
vendored model).

**`e4-efficiency/actions/auto-post` not found / "repository not found"** — the
action repo is private and the consumer org can't use it. In `e4-efficiency`,
**Settings → Actions → General → Access** → allow the org (see §1A).

**Deploy-gate times out ("Deploy of ... not detected")** — the health endpoint
never reported the pushed SHA in time. Check it returns `{ "commit": "<sha>" }`
matching `deploy-gate-sha-json-path`, that the deploy actually finished, and
raise the timeout for slow builds.

**"Preview server never became ready"** — the `preview.command` failed or the
app listens on a different port than `preview.port`. Check the Action logs
for the build output; bump `timeoutSeconds` for slow builds.

**History commit deploys as "Blocked" (Vercel)** — the commit identity isn't a
trusted deployer. The defaults use the triggering actor's github-noreply email;
override `history-commit-name`/`history-commit-email` (referenced) if you need a
specific account.

**Wrong screenshot picked** — add or reorder `routes` so Gemini knows the pages
that exist, or tighten the pick prompt in `post.mjs`.

**Gemini 429 errors** — you've hit the free-tier limit for the day; try again
tomorrow, or upgrade the key. (Model 404s are handled automatically by the
fallback chain; pin one with the `gemini-model` input if needed.)

**X 401 / 403 on `media/upload`** — almost always permissions. Regenerate
your access tokens after switching the app to Read+Write.

**Screenshot is blank / wrong** — Gemini may have picked a bad path. Check
the Action logs for the chosen path; if it's consistently off for your
project, tweak the prompt in `post.mjs`.

**Action fires but doesn't post** — make sure the merged commit is to `main`,
not `master` or another branch. Edit the workflow's `on.push.branches` if
your default branch is named differently.
