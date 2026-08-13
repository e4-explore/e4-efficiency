# Scripted flows (Gemini-driven, click-following camera) — design

**Date:** 2026-08-08
**Status:** approved (owner delegated decisions)

## Goal

Let a repo define a **named product flow in natural language** ("type a sample
post, open the media tab, pick video, score it") and have the auto-poster
produce a polished screen recording of that flow — **Gemini executes each step**
(finds the element, performs the action) and the **click-following zoom camera**
punches in on every click and pans between them. This is the productized version
of the multi-click zoom-follow we validated by hand against
`post-scorer-web.pages.dev`.

## Why this shape

The autonomous recorder (`recordInteractionVideo`) lets Gemini pick ONE showcase
interaction and zooms once. That's right for "a merge changed a draggable list"
but wrong for "show the whole score-a-post flow": most of its clicks are
throwaway navigation, and it only zooms once. A **scripted** flow is
owner-directed and repeatable; Gemini's role narrows to "do THIS step", which is
far more reliable than "figure out what to showcase". Additive and fail-open: no
flow defined or matched → existing behavior is untouched.

## Learnings baked in (from the hand-built demo)

1. **Measure each target AFTER the camera transform is applied**, then click its
   on-screen box center. Clicking where the element visually sits avoids fragile
   coordinate mapping and survives DOM changes (the video radio only exists after
   the media tab is clicked).
2. **Pan camera model:** `transform-origin: 0 0` with `translate()+scale()` on
   `<body>`, so CSS smoothly interpolates a PAN between click targets. (The
   shipped single-punch camera moves `transform-origin`, which jumps when
   panning — keep that one for the autonomous path; the flow path gets the pan
   model.)
3. **No-gap clamp:** `t = clamp(center − restC·s, −(s−1)·dim, 0)` per axis — an
   edge target punches in softer rather than revealing empty space. Acceptable
   and expected.
4. **Type at 1×**, zoom on clicks; keyboard steps (Enter) need no target.
5. **Short settle** after each action, then punch in promptly (the timing fix).
6. **Cursor** lives on `<html>` (outside the transform), glides to the target and
   scales with the zoom.
7. **Safety:** every offered element is filtered through `UNSAFE_ACTION_NAME`, so
   a flow can never click a destructive/financial/send control even if its NL
   step says so.

## Components

### Pan camera (new, exported, unit-tested)
- `flowKeyframe(restCenter, scale, viewport)` → `{ s, tx, ty }` with the no-gap
  clamp. Pure.
- `FLOW_CAMERA_JS` runtime: `__flowPanTo(tx,ty,s,ms)` / `__flowReset(ms)` on
  `<body>` (origin 0,0), driving `__apZoomCursor` in step. Reuses the existing
  cursor sprite + `__apGlideCursor`.
- `panCameraTo(page, keyframe, {cursor, ms})` and `flowCameraReset(...)` helpers.

### `recordScriptedFlow(browser, baseUrl, flow, shared, tag, { resolveStep })`
- Dedicated `recordVideo` context; navigates to `flow.url` (default `/`).
- For each step (in order):
  1. screenshot + `snapshotForRecorder` (UNSAFE-filtered).
  2. `resolveStep({ stepText, screenshotPath, elements, history })` →
     `{ action, ref, value, done }`. **Default resolver is Gemini-backed** (same
     `gemini()` call + JSON contract as the vision loop). Tests inject a
     deterministic resolver.
  3. Perform with the click-following camera: `click`/`select`/toggle → zoom to
     target, act; `type` → focus + type at 1×; `press` (e.g. Enter) → keyboard,
     no target. Pan from the previous target to this one.
- After the steps, an optional **payoff punch-in** (a step may be tagged
  `capture:true`, else auto-zoom the largest changed region), hold, ease out.
- Trim `[captureStart, captureEnd]` and transcode via the existing `ffmpegToMp4`.
- **Fail-open:** any step/camera/ffmpeg failure → reset camera, return `null`;
  the caller falls back to `recordInteractionVideo`, then to a still. The run
  never breaks.

### `pickFlow(flows, change)`
Selects a flow for a `capture:"video"` change: match by `flow.match.navTarget`
(case-insensitive substring of the change's `nav_target`) or
`flow.match.paths` (globs against the change's files). A flow with no `match`
is eligible only when it's the sole flow. Returns the flow or `null`.

### Config (per repo, `.github/auto-post/config.json`)
```json
{
  "flows": [
    {
      "name": "score a post",
      "match": { "navTarget": "scorer", "paths": ["src/scorer/**"] },
      "url": "/",
      "steps": [
        "type a short, punchy sample X post into the draft field",
        "click the media tab",
        "choose the video option",
        "press enter to score it"
      ]
    }
  ]
}
```
Steps are natural-language strings. `zoom-camera:false` / `ZOOM_CAMERA=false`
makes flows record flat (no camera), same flag as the single-punch path.

### Integration
In the change loop, before `recordInteractionVideo`:
```js
if (INTERACTIVE_SHOTS && INTERACTION_VIDEOS && change.capture === 'video') {
  const flow = pickFlow(flows, change);
  if (flow) resolved = await recordScriptedFlow(...).catch(() => null);
  if (!resolved) resolved = await recordInteractionVideo(...); // existing fallback
}
```

## Gemini step resolver

Per step, Gemini receives the step text, the current screenshot, the tagged
elements, and the history so far, and returns exactly one action:
```
{ "action": "click"|"type"|"select"|"hover"|"drag"|"press"|null,
  "ref": string|null, "value": string|null, "key": string|null,
  "done": boolean, "reason": string }
```
Narrow, one-step prompt (vs. the open-ended "pick a showcase" loop), so it
reliably does what the owner scripted. Never submits forms except an explicit
`press` step; safety-gated by the offered-element filter.

## Testing

- **Unit:** `flowKeyframe` centering, edge clamp, no-gap invariant sweep
  (mirrors the existing `cameraKeyframe` tests).
- **Mechanics (offline, real site):** run `recordScriptedFlow` against
  `post-scorer-web.pages.dev` with a **deterministic injected resolver** (maps
  step text → element by keyword, exactly as the hand demo did). Assert: valid
  mp4 produced, state actually advanced (media→video selected, score rendered),
  and extracted frames show a zoom on each click. This exercises the whole path
  minus the Gemini call.
- **Gemini resolver:** structurally identical to the shipped vision loop, so it
  can't be unit-tested without a key; verified in a dry-run in production
  (consistent with the interactive-browse / video precedents). Recommend a
  `dry-run` on a repo with a `flows` entry before moving `v1`.

## Non-goals (v1)

- Branching/conditional steps, assertions, waits-for-text as first-class step
  types (a step can still say "wait for the score to appear" and the resolver
  can no-op). 
- Recording multiple flows per change (one matched flow per change).
- A visual flow builder. Flows are hand-written NL in config.
