# Zoom camera for interaction videos — design

**Date:** 2026-08-07
**Status:** approved (owner delegated decisions)

## Goal

Give the auto-poster's interaction recordings a "FocuSee-style" cinematic
camera: ease-zoom in on the showcase interaction (click, drag, hover reveal),
hold, then ease back out — so short clips read like a produced screen recording
instead of a flat capture. Built clean-room: we replicate the *behavior* of
tools like FocuSee/Screen Studio, no code from any proprietary app.

## Why this design

FocuSee has to infer camera targets by hooking OS mouse events and
post-processing the video. We are in a strictly better position: the recorder
in `actions/auto-post/post.mjs` *drives* the interaction itself with a
synthetic cursor, so every click point, drag path, and timestamp is known
programmatically. That lets the camera be live and deterministic instead of
inferred.

## Approach (chosen): live in-page CSS camera

During recording, apply an eased `transform: translate(dx,dy) scale(s)` to
`document.body` of the top frame, with `transform-origin` at the showcase
point. Playwright's recorder captures the page as painted, so the zoom lands
in the clip with **no post-processing** and stays **pixel-sharp** (Chromium
re-rasterizes at the new scale — better than FocuSee's raster upscale of a
fixed recording).

Alternatives rejected:

- **Post-process with ffmpeg `zoompan`** from a logged cursor/click timeline:
  zooming a 1280×800 recording 2× is a raster upscale (soft), the expression
  generation is complex, and it adds CI cost. Live CSS zoom is sharper and
  simpler.
- **Record at 2× device pixels + post-process crop:** best theoretical
  quality, but Playwright screencast capture at device resolution is
  unreliable and CPU-heavy on runners.

## Key mechanics

- **Cursor overlay stays screen-anchored.** The synthetic cursor is appended
  to `document.documentElement`; the camera transform goes on `document.body`,
  so the cursor is outside the zoomed subtree and its viewport coordinates
  stay valid. The camera additionally scales the cursor sprite in step with
  the zoom so it grows with the content (like a real recording zoomed in
  post).
- **Zoom only on the showcase (`is_capture`) step.** Navigation steps stay at
  1×, so the vision loop's screenshots and element coordinates remain
  consistent, and the trim discards them anyway.
- **Coordinate mapping is explicit.** While zoomed, actions are dispatched as
  raw mouse events at coordinates mapped through the camera transform
  (`p' = O + (p−O)·s + (dx,dy)` from the rest-state bounding box). Hit-testing
  follows the painted layout, so this is correct for main-frame *and* iframe
  (Storybook) content — the case where locator-based clicks under an ancestor
  transform can mis-hit.
- **Camera is static during the interaction.** Panning mid-drag would move
  elements under pre-computed mouse coordinates. For drags, the zoom level is
  chosen so both the grab and drop points fit in frame (`fit both + padding`,
  clamped to [1.15, 2.0]); clicks/hovers punch in around the target
  (clamped ≤ 2.0). Partial re-centering toward viewport center is clamped by
  `(s−1)·distance(origin, edge)` per side so no out-of-content gap is ever
  revealed.
- **`select`/`type` showcase steps zoom after the action** (they need real
  element APIs, which we don't mix with the transform), holding on the field
  and its result.
- **Timeline:** zoom-in ~750 ms ease-out → interaction → hold ~1.1 s →
  zoom-out ~850 ms → `captureEnd`. The existing trim (+0.8 s tail) keeps the
  full ease-out.

## Pure helpers (unit-testable)

- `cameraKeyframe(focus, scale, viewport)` → `{scale, ox, oy, dx, dy}` with
  the edge clamps above.
- `cameraMapPoint(p, keyframe)` → screen position of a rest-state point under
  that camera.

## Failure handling

Additive and safe, matching the branch's ethos: any camera failure resets the
transform and falls back to the existing un-zoomed action path; any recording
failure still falls back to a still image. Nothing in the validated
screenshot/posting pipeline changes.

## Config

- New composite-action input `zoom-camera` (default `"true"`), env
  `ZOOM_CAMERA`, per-repo config key `zoomCamera`. Off → recordings behave
  exactly as before.

## Testing

- Unit assertions on `cameraKeyframe` / `cameraMapPoint` (centered focus →
  no translate; edge focus → clamped; focus maps to focus + translate).
- Local integration: record a drag on a demo page through the real helpers,
  transcode with `ffmpegToMp4`, extract frames, visually verify zoom-in /
  correct drop / zoom-out.
