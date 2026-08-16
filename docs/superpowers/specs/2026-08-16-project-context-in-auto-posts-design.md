# Project context in every auto post

**Date:** 2026-08-16
**Status:** Approved (design), pending implementation plan

## Problem

Auto-poster posts read as vague. A reader who lands on a post like "Added a
liquid glass theme" has no way to tell what the product even is, so the update
lands without meaning.

Root cause: the drafting pipeline only ever sees change-local context — the
commit message, the diff, the PR title/body, and recent commit subjects. It has
no stable statement of *what the project is*. The segmentation prompt's `PROJECT`
block (`actions/auto-post/post.mjs`, ~line 2048) is just `Repo: owner/name` plus
route hints. Nothing orients a first-time reader.

## Goal

Every post orients a reader who has never heard of the project, in the existing
casual one-statement voice, with no boilerplate. Achieve this by giving the
drafting, editor, and optimizer models a stable "what this project is" fact to
write around — not by prepending a fixed anchor line.

## Non-goals

- No fixed anchor/prefix/tagline line on posts (fights the voice rules: casual,
  one statement, no boilerplate, tight character budget).
- No fetching of external marketing/site copy.
- No per-post product tagline generation.
- No change to the validated screenshot / interaction-video / X-publish paths.

## Decisions

Both delegated to the implementer by the owner ("do what you think is best"):

1. **Context source:** owner-authored one-liner with an auto-derived fallback.
   Owners who care get exact control; every existing install improves with zero
   config.
2. **How it surfaces:** ground the copy (feed context into the prompts). No
   template. A fixed "In [Product], …" anchor was rejected.

## Design

### 1. Resolver: `resolveProjectContext({ config, repo, ghHeaders })`

Returns a short project-description string (target ≤ ~300 chars). First
non-empty wins:

1. **Owner-authored**
   - `PROJECT_CONTEXT` env var (from a new `project-context` action input), then
   - `config.json` `"projectContext"`.
   - Used verbatim (trimmed, truncated to the cap).
2. **Auto-derived fallback** — only when no owner field is set. Each piece is
   best-effort inside its own try/catch and contributes what it can:
   - `GET /repos/{repo}` → `description` + `homepage`.
   - `GET /repos/{repo}/readme` (base64 body) → strip badges, headings, HTML
     comments, and shields/links; take the first real prose paragraph.
   - Compose the available pieces into one blurb (repo description first, then
     the README intro; include homepage if present).
3. **Degrade** to today's behavior (repo name only → empty context) if
   everything fails.

The resolver **never throws**. Network failures, missing README, empty
description all fall through to the next source or to empty.

**Purity for testing:** the README-markdown→intro extraction and the
compose/truncate step are extracted as **pure exported functions** (e.g.
`readmeIntro(markdown)` and `composeProjectContext({ description, readmeIntro,
homepage })`), unit-tested offline with no network or Gemini. This mirrors the
existing offline suite (currently 48 checks across pure/mechanics/closeup/nav/
navtarget). The resolver itself (which does the fetches) is thin glue around
these pure helpers.

### 2. Injection points (three)

Orientation must survive the whole pipeline, so the resolved context is threaded
into all three text stages:

1. **Segmentation prompt** — `PROJECT` block (~line 2048). Add a
   `What this project is:` line carrying the resolved context, plus one
   instruction: write so a first-time reader can tell what the project is and
   why this change matters; let it inform phrasing; do **not** paste the
   description in or prefix every post with "In X…".
2. **Editor constraints** — `constraints` string (~line 2292). Include the
   context so the editor keeps (or adds, on a too-bare draft) enough
   orientation.
3. **Optimizer change context** — `changeContext` (~line 2287). Include the
   context so the score-optimizer cannot strip orientation while chasing the
   engagement score.

### 3. Voice rule

Add one light line to `buildVoice` (~line 88): assume the reader has never heard
of this project — give just enough to place it, in the same one casual sentence,
with no "In [Product]" preamble. Deliberately light so it never forces a
template.

### 4. Surface wiring

- `action.yml`: new optional `project-context` input; pass it through as the
  `PROJECT_CONTEXT` env var in the run step.
- `README.md`: document the input and the `config.json` `projectContext` field,
  and note the auto-derived fallback.
- `templates/config.example.json`: add a `projectContext` example.
- `templates/auto-post.yml`: expose the input in the vendored workflow.
- Keep `actions/auto-post/post.mjs` and `templates/post.mjs` byte-identical.

## Data flow

```
main()
  ├─ fetch commit / diff / PR / recent commits           (unchanged)
  ├─ projectContext = resolveProjectContext(...)          (NEW, best-effort)
  ├─ segmentation prompt  ← PROJECT block + projectContext (NEW line)
  ├─ per change: editor constraints ← projectContext       (NEW)
  └─ optimizer changeContext ← projectContext              (NEW)
```

## Error handling

- Every fetch in the resolver is wrapped; any failure drops that source.
- Empty/whitespace context is treated as "no context" — the prompts omit the
  `What this project is:` line entirely rather than emitting an empty one.
- The rest of the pipeline is untouched, so a resolver returning empty reproduces
  today's exact behavior.

## Testing

- New offline unit tests for `readmeIntro` (badge/heading/HTML stripping, first
  real paragraph, empty/garbage input) and `composeProjectContext` (source
  priority, truncation, missing pieces), added to the existing offline test
  runner. No live network or Gemini key required.
- Owner-field-vs-fallback precedence is covered by testing the pure
  compose/priority logic; the fetching glue is thin and exercised in a live
  dry-run.
- Recommend a `dry-run` on a real repo (e.g. e4-components) to eyeball drafted
  copy before moving the `v1` tag, consistent with prior risky-change precedent.
  This change is lower-risk (prompt grounding, no new autonomous browsing), so
  the move-v1 decision is deferred to the owner.

## Risk

Low. Additive and self-degrading: no new autonomous browsing, no change to the
validated capture/publish paths, and only one extra pair of best-effort GitHub
reads when the owner field is unset.
