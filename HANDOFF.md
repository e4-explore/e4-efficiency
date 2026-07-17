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

Commit context → Gemini draft + candidate routes (model-fallback chain) → image
(cover.png | local preview build | deployed site, deploy-gated) → vision picks
best screenshot → editor pass vs. rubric + history → post to X → append
`history.jsonl`, committed back as a real-account identity.

## Released

- Tagged `v1.0.0` and moving `v1`. SoccerProps pins `@v1`.

## Known limits (v2 candidates)

Learns from its own output (rubric + history), not engagement (likes/impressions
— needs X analytics beyond the free tier). No approval queue, no commit batching,
no chore filtering, single voice, single X account per repo, no video posts.

## Open follow-ups

- SoccerProps migration to the referenced action is done by the user separately
  (this session's GitHub scope can't reach that repo).
- If the action repo is private, the org Actions access setting must allow other
  org repos to use it (docs/setup.md §1A).
