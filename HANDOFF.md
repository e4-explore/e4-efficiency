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
  both modes via `AUTOPOST_DATA_DIR`. Keep the two copies in sync.

## Pipeline

Commit + merged-PR + recent-commit context → Gemini segments the push into
1-4 distinct changes (most pushes are one coherent change and collapse to
exactly one; a push bundling a few separate tweaks gets one item per change,
capped at `max-bundle-images`, default 4 — X's own per-post image limit), each
with its own one-line draft (what changed + why), candidate routes, and
changed-element hint (model-fallback chain) → per change: image (cover.png
[always singular] | local preview build | deployed site, deploy-gated) →
vision picks best screenshot → element close-up when the changed component
can be located → optional interactive browse (bounded vision loop drives the
page via clicks/hovers/selects to reach a compelling state, safety-gated
against mutating/financial/account/send actions; smaller step/time budget per
change when bundling more than one) → vision picks best of {full page,
close-up, interactive frames} → vision verification scoped to that change's
own files, with one widened route search on a miss (a change whose shots all
fail is dropped — its line still posts, no image, not fatal) → editor pass on
the assembled multi-line draft vs. rubric + history → post to X with up to 4
images attached → append `history.jsonl`, committed back as a real-account
identity.

## Released

- Tagged `v1.4.1`+ and moving `v1` (batching lands as the next tag after this
  handoff was last touched — check `git tag -l 'v1.*'` for the actual latest).
  SoccerProps + e4-components pin `@v1`.

## Known limits (v2 candidates)

Learns from its own output (rubric + history), not engagement (likes/impressions
— needs X analytics beyond the free tier). No approval queue, no chore
filtering, single voice, single X account per repo, no video posts. Commit
batching (multiple distinct changes → multiple images, one post) shipped —
see Pipeline above.

## Open follow-ups

- SoccerProps migration to the referenced action is done by the user separately
  (this session's GitHub scope can't reach that repo).
- If the action repo is private, the org Actions access setting must allow other
  org repos to use it (docs/setup.md §1A).
