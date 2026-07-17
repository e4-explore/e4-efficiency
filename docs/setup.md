# Setup walkthrough

Step-by-step for installing the auto-poster in a new repo from scratch.

## 1. Install the files

From this skill's directory:

```bash
./install.sh /path/to/your/repo
```

This creates three files under `.github/` in the target repo. Don't edit
`auto-post.yml` unless you know what you're doing — but `post.mjs` is fair
game for per-repo tweaks (voice, screenshot logic, etc.) if you ever need to
diverge from the global behavior.

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

You have two options. Pick one.

### Option A — Live screenshot of your deployed site (default)

GitHub: **Settings → top of General → Website**. Paste the deployed URL of
your project (e.g. `https://your-project.vercel.app`). The workflow reads
this field via the GitHub API and uses it as the base for screenshots
(Gemini picks the path per commit).

### Option B — Static cover image (for repos with no deployed UI)

If your project is a library, skill, CLI, or anything else without a URL
worth screenshotting, drop a PNG at:

```
.github/auto-post/cover.png
```

Recommended size: 1280×800. When this file exists, the workflow uses it
verbatim and skips the screenshot step. The homepage URL is then optional.

## 6. Commit and push

```bash
git add .github
git commit -m "Add project-update-auto-poster workflow"
git push
```

That push itself triggers the first run. Watch the Actions tab; if it
succeeds, you'll see a tweet on your X account within ~1 minute.

## 7. (Optional) Backfill posts for merges that already landed

The workflow also supports manual runs, so you can post about a commit that
was merged before you installed the auto-poster.

1. In the target repo on GitHub, go to the **Actions** tab.
2. Pick **Auto-post project update** in the left sidebar.
3. Click **Run workflow** (top right).
4. Paste the commit SHA into the `sha` input and click Run.

The workflow uses that SHA for the Gemini context and the commit link, but
otherwise behaves identically to a push-triggered run (same voice, same
image logic — screenshot or cover.png).

Repeat once per commit you want backfilled. There's no batch mode yet.

## Troubleshooting

**Missing HOMEPAGE_URL error** — set the Website field (option A) OR commit
a `.github/auto-post/cover.png` (option B).

**Gemini 429 errors** — you've hit the free-tier limit for the day; try again
tomorrow, or upgrade the key.

**X 401 / 403 on `media/upload`** — almost always permissions. Regenerate
your access tokens after switching the app to Read+Write.

**Screenshot is blank / wrong** — Gemini may have picked a bad path. Check
the Action logs for the chosen path; if it's consistently off for your
project, tweak the prompt in `post.mjs`.

**Action fires but doesn't post** — make sure the merged commit is to `main`,
not `master` or another branch. Edit the workflow's `on.push.branches` if
your default branch is named differently.
