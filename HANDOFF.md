# Handoff — project-update-auto-poster

Status as of the v1 refactor. Copy below the line into a new session to continue.

---

I'm working on **project-update-auto-poster** in `e4-explore/e4-efficiency`
(branch `claude/project-update-auto-poster-d8ol8k`, or `main` if merged). It's a
"self-marketer": when code merges to `main`, GitHub Actions auto-generates a
short, in-voice X post about the change (with a screenshot) and publishes it. No
human in the loop. Read `SKILL.md`, `actions/auto-post/README.md`, and
`docs/setup.md` for full context.

## Layout (v1)

- **Referenced model (recommended):** `actions/auto-post/action.yml` — a
  composite action a consumer references as
  `e4-explore/e4-efficiency/actions/auto-post@v1` from a thin caller workflow.
  Bundles `actions/auto-post/post.mjs` + `package.json`. Secrets/config are
  action inputs. Deploy-gate + history commit-back are steps in the action.
- **Vendored model:** `templates/` + `install.sh` copy the same `post.mjs` and a
  self-contained workflow into a consumer's `.github/`. Deploy-gate / commit-link
  driven by repo variables.
- `post.mjs` is identical in `templates/` and `actions/auto-post/`; it runs in
  both modes via `AUTOPOST_DATA_DIR`. Keep the two copies in sync
  (`cp actions/auto-post/post.mjs templates/post.mjs` after any edit).
- **Post-scorer (two tiers, both in this repo):** a clean-room evaluator that
  scores a post the way X's Grok/Phoenix ranking model would. Split on the line
  "does it need an LLM call?" — free = deterministic diagnosis, paid = LLM +
  rewriting.
  - **`packages/scorer` (`@e4/post-scorer`) — FREE:** zero-dependency,
    deterministic. `evaluatePost` returns score + subscores + **named issues**
    (which levers are weak, no fix text). CLI `bin/score.mjs`, `node --test`.
  - **`packages/scorer-pro` (`@e4/post-scorer-pro`) — PAID:** builds on free via
    relative imports (`../../scorer/src/...`, so no npm install needed). Adds LLM
    engagement prediction, **written fixes** (`suggest.mjs` maps lever ids → text),
    and the **auto-optimizer** (`optimize.mjs`). Every entry point calls
    `assertLicensed` — offline ed25519 key check (`license.mjs` holds the PUBLIC
    key; `scripts/sign-license.mjs` signs server-side from `POST_SCORER_SIGNING_KEY`).
    Throws `code:'UNLICENSED'` without a valid key. **The embedded public key is a
    DEV key** — regenerate for production and re-sign the test's `DEV_LICENSE`.
  - **Wiring (post.mjs step 4b):** `loadScorerFree()` always runs and logs the
    score + weak spots; `loadScorerPro()` runs `optimizePost` only when
    `POST_SCORER_LICENSE_KEY` is set + the pro package resolves. Both loaders try
    referenced (`../../packages/...`) then vendored (`./scorer/`, `./scorer-pro/`)
    paths. Inputs: `optimize-post`/`optimize-target`/`optimize-iterations` +
    `post-scorer-license-key`. Additive + self-skipping; publish path unchanged.
    **Voice gate (2026-08-04):** the optimizer is grounded in the change context
    (commit/clauses/PR) so any take/question must be true to what shipped, and a
    deterministic `lintVoice()` gate rejects a higher-scoring rewrite that raises
    the mechanical voice-violation count (banned opener, reply-farm clickbait,
    emoji, em dash, …) vs the editor's draft — the scorer optimizes X-engagement
    and has no brand/voice term, so this stops it trading voice for reply-bait.
  - **Distribution:** referenced mode gets both packages from the tagged repo
    (move `v1` → consumers auto-update). Vendored mode: `install.sh` bundles the
    FREE core into `.github/auto-post/scorer/`; subscribers drop the PAID
    `scorer-pro/` in and set the license key to unlock auto-optimize.
  - **Analytics feedback loop (in progress, paid):** the "gets better the more
    it's used" flywheel. (1) post.mjs now records `predicted` {score,subscores}
    + `posted_at` into each history.jsonl row (the training signal). (2)
    `scorer-pro/src/metrics.mjs` + `bin/ingest-analytics.mjs` ingest an X Premium
    analytics CSV export, match rows to posts (by tweet_id, then text), compute
    the ACTUAL engagement score with the SAME weights the scorer predicts with
    (Σ w × rate-per-impression), and write `actual` back into history. Metrics
    source is the user's X **Premium CSV export** (their X API dev tier is Free =
    no analytics reads). NOTE: predicted (optimistic feature priors) and actual
    (real per-impression rates) are on different scales — ranking is preserved,
    the not-yet-built **calibrator** (`calibrate.mjs` → per-account
    `calibration.json` the scorer loads) closes the scale gap + tunes priors.
    Needs ~20+ measured posts before calibration is meaningful.

## Pipeline

Commit + merged-PR + recent-commit context → Gemini segments the push into
1-4 distinct changes (most pushes are one coherent change and collapse to
exactly one; a push bundling a few separate tweaks gets one item per change,
capped at `max-bundle-images`, default 4 — X's own per-post image limit), each
with its own one-line draft (what changed + why), candidate routes,
changed-element hint, and a `capture` flag (`image` | `video`) (model-fallback
chain) → per change, EITHER:
  • image (cover.png [always singular] | local preview build | deployed site,
    deploy-gated) → vision picks best screenshot → element close-up when the
    changed component can be located (padded crop, nav-guarded so the hint
    matches the canvas instance not the sidebar) → optional interactive browse:
    FIRST a DETERMINISTIC `navigateToTarget()` (project-agnostic, no vision) drives
    to the per-change nav_target — search-jump (type the name into a search/filter
    box, click the best-matching result) then nav-drill (click the matching nav
    item, expanding collapsed groups until it appears), confirmed by a generic
    arrival check (selected/aria-current item or a matching heading); THEN the
    bounded vision loop refines the state/framing via clicks/hovers/selects/TYPE
    (told NOT to settle for a landing/overview page); safety-gated against mutating/financial/account/send
    actions; smaller step/time budget per change when bundling more than one) →
    vision picks best of {full page, close-up, interactive frames} → vision
    verification scoped to that change's own files, with one widened route search
    on a miss, and — if still unconfirmed — the change goes TEXT-ONLY rather than
    posting a confirmed-wrong image (e.g. a generic landing page); OR
  • video (change flagged `capture:"video"` — an interaction/motion a still
    can't convey): a dedicated recording context + bounded vision loop navigates
    to the screen and drives the ONE showcase interaction (drag/reorder, expand,
    tab switch, hover reveal) with a synthetic cursor (Playwright video doesn't
    capture the OS cursor), trimmed to the interaction window and transcoded to
    an X-friendly mp4 via ffmpeg; falls back to the still pipeline on no ffmpeg /
    nav miss / unverified final frame / any error.
A change whose capture all fails is dropped (its line still posts, no media, not
fatal) → editor pass on the assembled multi-line draft vs. rubric + history →
post to X with EITHER up to 4 images OR a single video (X allows either, never a
mix — a video wins and other media is dropped, text lines kept; `pickPostMedia`
enforces this) → append `history.jsonl`, committed back as a real-account
identity.

## Released

- Tagged `v1.4.1`+ and moving `v1` (batching lands as the next tag after this
  handoff was last touched — check `git tag -l 'v1.*'` for the actual latest).
  SoccerProps + e4-components pin `@v1`.

## Known limits (v2 candidates)

Learns from its own output (rubric + history), not engagement (likes/impressions
— needs X analytics beyond the free tier). No approval queue, no chore
filtering, single voice, single X account per repo. Commit batching (multiple
distinct changes → multiple images, one post) and interaction video posts
(drag/reorder/expand/tab/hover captured as an mp4 with a synthetic cursor)
shipped — see Pipeline above. Video is on by default (`interaction-videos`
input / `INTERACTION_VIDEOS` var to disable); it needs ffmpeg on PATH (present
on GitHub-hosted runners) and falls back to a still otherwise. Spotlight/zoom
production polish on the recorded clip is a possible follow-up (v1 is
cursor-only).

## Open follow-ups

- SoccerProps migration to the referenced action is done by the user separately
  (this session's GitHub scope can't reach that repo).
- If the action repo is private, the org Actions access setting must allow other
  org repos to use it (docs/setup.md §1A).
