// Auto-posts a project update to X when a merge lands on `main`.
// Part of the `project-update-auto-poster` skill / composite action.
//
// This ONE file runs in two modes:
//   • Vendored:   copied into a consumer's .github/auto-post/ and run with
//                 cwd = .github/auto-post (the classic install.sh layout).
//                 Config comes from config.json / cover.png in that dir.
//   • Referenced: bundled inside the composite action at actions/auto-post/,
//                 run with cwd = consumer repo root and AUTOPOST_DATA_DIR set
//                 to .github/auto-post. Config (routes, homepage, commit-link)
//                 arrives via env from the action's inputs.
//
// Pipeline:
//   1. Pull commit context from the GitHub API.
//   2. Gemini drafts post text + candidate routes to screenshot.
//   3. Image source (first match wins):
//        a. cover.png       — static image, used verbatim
//        b. config.preview  — build & serve the pushed code locally, shoot it
//        c. homepage URL    — screenshot the deployed site
//      When several routes are shot, Gemini vision picks the most engaging.
//   4. Editor pass: Gemini critiques the draft against an engagement rubric
//      + recent post history, then rewrites it.
//   5. Post to X with media. Append to history.jsonl (the workflow commits it
//      back so future runs learn from past posts).
//
// Edit VOICE to retune tone; edit RUBRIC to retune the editor.
//
// NOTE: the deploy-gate (wait for the pushed commit to be live before
// screenshotting the deployed site) is NOT here — it's a step in the workflow
// / composite action, so it can gate before this script runs and stay
// push-only. See auto-post.yml / actions/auto-post/action.yml.

import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// ---------------------------------------------------------------- constants

// Model IDs change and get retired (a pinned "gemini-2.5-flash" started
// 404ing for new API keys). Prefer the rolling "-latest" alias, then fall
// back through cheaper variants so a single retired ID can't kill a run.
// Override with the GEMINI_MODEL env var to pin a specific model.
const GEMINI_MODELS = [
  ...(process.env.GEMINI_MODEL ? [process.env.GEMINI_MODEL] : []),
  'gemini-flash-latest',
  'gemini-flash-lite-latest',
  'gemini-2.5-flash-lite',
];

const RUBRIC = `
Engagement rubric (what makes a post worth reading):
- One sentence, one idea: the change plus the reason it matters, joined naturally.
- The "why" is product value ("we're including MLS bets now"), never a restatement of the change ("to reflect broader coverage").
- Concrete beats abstract: name the thing ("live odds now refresh every 30s"), never "improved performance".
- Sound like a teammate mentioning what they shipped, not a changelog or a brand account.
- Vary structure against recent posts — if the last post opened with the feature name, don't do it again.
`.trim();

function buildVoice(includeCommitLink) {
  const limitLine = includeCommitLink
    ? '- Under 240 characters total (room is reserved for an auto-appended commit link).'
    : '- Under 280 characters total.';
  return `
Voice rules (follow strictly):
- Exactly one casual sentence: what changed + why, e.g. "Updated the bet record header since we're including MLS bets now".
- Builder tone — a teammate mentioning what they shipped, not an announcement.
- Past tense. Plain language. Never the changelog pattern "X now does Y to reflect Z".
- No hype words: never "amazing", "exciting", "game-changer", "thrilled", "stoked", "huge", "massive".
- No exclamation marks.
- At most one fitting emoji (optional, skip if unsure).
- No hashtags unless they genuinely add reach.
${limitLine}
- Speak about the project in the third person or the work in the first-person plural ("we"), never "I".
- If the change is purely internal/no user impact, say so plainly — don't pretend it's a feature.
`.trim();
}

// ---------------------------------------------------------------- pure helpers (exported for tests)

// Returns the substring spanning the first balanced top-level {...} object,
// scanning past string contents (respecting escapes) so braces inside
// string values don't throw off the depth count.
export function extractJsonObject(text) {
  const start = text.indexOf('{');
  if (start === -1) throw new Error('No JSON object found.');
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  throw new Error('Unbalanced JSON object.');
}

function envBool(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return v === 'true' || v === '1' || v === 'yes';
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- gemini (exported for smoke tests)

// Default is generous because gemini-flash-latest is a "thinking" model whose
// reasoning tokens count against maxOutputTokens — too small a limit and the
// budget is spent thinking, truncating the actual JSON. The payloads here are
// only a few hundred tokens, so the headroom is effectively free.
export async function gemini(parts, { maxOutputTokens = 8192 } = {}) {
  const key = process.env.GEMINI_API_KEY;
  const payload = JSON.stringify({
    contents: [{ role: 'user', parts }],
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.7,
      maxOutputTokens,
    },
  });

  let res;
  let lastErr = '';
  for (const model of GEMINI_MODELS) {
    res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload },
    );
    if (res.ok) break;
    lastErr = `${res.status} ${await res.text()}`;
    // 404/400 mean this model id is unavailable to this key — try the next one.
    // Anything else (quota, auth, 5xx) is not fixed by switching models: stop.
    if (res.status !== 404 && res.status !== 400) break;
    console.warn(`Model ${model} unavailable (${res.status}); trying next.`);
  }
  if (!res.ok) throw new Error(`Gemini call failed: ${lastErr}`);
  const body = await res.json();
  const text = body?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error(`Gemini returned no text. Body: ${JSON.stringify(body).slice(0, 500)}`);
  try {
    return JSON.parse(text);
  } catch (e) {
    // Even with responseMimeType 'application/json', thinking models
    // occasionally trail a complete object with stray characters (e.g. a
    // duplicated closing brace). Extract just the first balanced {...} and
    // retry before giving up.
    try {
      return JSON.parse(extractJsonObject(text));
    } catch {
      throw new Error(`Failed to parse Gemini JSON: ${e.message}. Raw: ${text.slice(0, 500)}`);
    }
  }
}

// ---------------------------------------------------------------- runtime helpers

function loadHistory(historyPath, limit = 10) {
  if (!existsSync(historyPath)) return [];
  return readFileSync(historyPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean)
    .slice(-limit);
}

async function waitForServer(url, timeoutSeconds) {
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await sleep(2000);
  }
  throw new Error(`Preview server never became ready at ${url} within ${timeoutSeconds}s`);
}

// ---------------------------------------------------------------- screenshot helpers

async function shootRoutes(ctx, baseUrl, paths, tag) {
  const shots = [];
  for (const [i, path] of paths.entries()) {
    const url = new URL(path, baseUrl).toString();
    const file = join(tmpdir(), `auto-post-shot-${tag}-${i}.png`);
    console.log(`Screenshotting candidate ${tag}/${i}: ${url}`);
    try {
      const page = await ctx.newPage();
      await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 }).catch(async (err) => {
        console.warn(`networkidle timed out (${err.message}); falling back to load.`);
        await page.goto(url, { waitUntil: 'load', timeout: 30_000 });
      });
      await page.screenshot({ path: file, fullPage: false });
      await page.close();
      shots.push({ path, url, file });
    } catch (err) {
      console.warn(`Candidate ${tag}/${i} (${url}) failed: ${err.message} — skipping.`);
    }
  }
  return shots;
}

// Vision pass: Gemini looks at the actual images and picks the best one.
async function pickBestShot(shots, postText, commitMessage) {
  if (shots.length === 1) return shots[0];
  const pick = await gemini([
    {
      text: `You are choosing the single most engaging screenshot to attach to this social post:

POST DRAFT: ${postText}
COMMIT MESSAGE: ${commitMessage}

Below are ${shots.length} screenshots, in order (index 0 first): ${shots.map((s, i) => `[${i}] ${s.path}`).join(', ')}.
Pick the one that best SHOWS the change described — prefer visible content over empty states, error pages, or generic landing pages.

Return ONLY JSON: { "best_index": number, "reason": string }`,
    },
    ...shots.map((s) => ({
      inline_data: { mime_type: 'image/png', data: readFileSync(s.file).toString('base64') },
    })),
  ], { maxOutputTokens: 8192 });

  const idx = Number.isInteger(pick.best_index) && pick.best_index >= 0 && pick.best_index < shots.length
    ? pick.best_index : 0;
  console.log(`Vision pick: [${idx}] ${shots[idx].path} — ${pick.reason ?? 'no reason given'}`);
  return shots[idx];
}

// Screenshots just the changed component instead of the whole page. Finds the
// element from the model's hint (visible text or CSS selector), climbs to a
// container big enough to read as a crop, and shoots that element. Returns
// null when the element can't be found or the container is basically the
// whole page — the caller falls back to the full-page shot.
async function shootElementCloseUp(ctx, url, hint, tag) {
  if (!hint || (!hint.text && !hint.selector)) return null;
  const page = await ctx.newPage();
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 }).catch(async () => {
      await page.goto(url, { waitUntil: 'load', timeout: 30_000 });
    });
    let target = null;
    if (hint.selector) {
      try {
        const loc = page.locator(hint.selector).first();
        if (await loc.count() && await loc.isVisible().catch(() => false)) target = loc;
      } catch { /* model-supplied selector may be invalid syntax */ }
    }
    if (!target && hint.text) {
      const loc = page.getByText(hint.text, { exact: false }).first();
      if (await loc.count() && await loc.isVisible().catch(() => false)) target = loc;
    }
    if (!target) {
      console.warn(`Close-up: element not found for hint ${JSON.stringify(hint)}.`);
      return null;
    }

    // The hint often matches a small label; climb to a crop-worthy container.
    const handle = await target.evaluateHandle((el) => {
      let n = el;
      while (n.parentElement) {
        const r = n.getBoundingClientRect();
        if (r.width >= 280 && r.height >= 64) break;
        n = n.parentElement;
      }
      return n;
    });
    const rect = await handle.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { w: r.width, h: r.height, vw: window.innerWidth, vh: window.innerHeight };
    });
    if (rect.w * rect.h > rect.vw * rect.vh * 0.85) {
      console.warn('Close-up: container covers almost the whole page; using the full-page shot instead.');
      return null;
    }
    const file = join(tmpdir(), `auto-post-closeup-${tag}.png`);
    await handle.asElement().screenshot({ path: file });
    console.log(`Close-up captured (${Math.round(rect.w)}x${Math.round(rect.h)}) on ${url}.`);
    return file;
  } catch (err) {
    console.warn(`Close-up failed: ${err.message} — falling back to the full-page shot.`);
    return null;
  } finally {
    await page.close().catch(() => {});
  }
}

// Vision check: does the chosen image actually show the change? Prevents
// posting a screenshot of the wrong page when the changed component doesn't
// render on any of the tried routes.
async function shotShowsChange(file, postText, commitMessage) {
  try {
    const res = await gemini([
      {
        text: `POST DRAFT: ${postText}
COMMIT MESSAGE: ${commitMessage}

Does the attached screenshot visibly show the change this post talks about? Be strict: generic pages, empty states, error pages, or pages unrelated to the change are a "no".

Return ONLY JSON: { "shows_change": boolean, "reason": string }`,
      },
      { inline_data: { mime_type: 'image/png', data: readFileSync(file).toString('base64') } },
    ]);
    console.log(`Shot verification: ${res.shows_change} — ${res.reason ?? ''}`);
    return res.shows_change === true;
  } catch (err) {
    console.warn(`Shot verification errored (${err.message}); assuming the shot is fine.`);
    return true;
  }
}

// Best-effort list of files that define routes/pages in the consumer repo, so
// the model can find where a changed component actually renders when the
// first screenshot round misses.
function listRouteFiles(repoRoot, max = 200) {
  const SKIP = new Set(['node_modules', '.git', '.next', '.nuxt', '.svelte-kit', 'dist', 'build', 'out', 'coverage', '.vercel', '.github']);
  const EXTS = /\.(jsx?|tsx?|vue|svelte|astro|html)$/;
  const ROUTEY = /(^|\/)(pages|app|routes|views|screens)(\/|$)/;
  const hits = [];
  const walk = (dir, depth) => {
    if (hits.length >= max || depth > 7) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (hits.length >= max) return;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP.has(e.name) && !e.name.startsWith('.')) walk(full, depth + 1);
      } else if (EXTS.test(e.name)) {
        const rel = relative(repoRoot, full);
        if (ROUTEY.test(rel)) hits.push(rel);
      }
    }
  };
  walk(repoRoot, 0);
  return hits;
}

// ---------------------------------------------------------------- main

async function main() {
  const {
    GITHUB_TOKEN,
    GITHUB_REPOSITORY,
    GITHUB_SHA,
    GITHUB_SERVER_URL,
    HOMEPAGE_URL,
    GEMINI_API_KEY,
    X_API_KEY,
    X_API_SECRET,
    X_ACCESS_TOKEN,
    X_ACCESS_TOKEN_SECRET,
  } = process.env;

  // Where config.json / cover.png / history.jsonl live (all in the CONSUMER
  // repo). Vendored mode: cwd is already .github/auto-post → '.'. Referenced
  // mode: the action sets AUTOPOST_DATA_DIR and runs from the repo root.
  const DATA_DIR = process.env.AUTOPOST_DATA_DIR || '.';
  const REPO_ROOT = process.env.AUTOPOST_DATA_DIR ? process.cwd() : resolve('../..');
  const CONFIG_PATH = join(DATA_DIR, 'config.json');
  const COVER_PATH = resolve(DATA_DIR, 'cover.png');
  const HISTORY_PATH = join(DATA_DIR, 'history.jsonl');

  let config = {};
  if (existsSync(CONFIG_PATH)) config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));

  // --- resolve config: env (action inputs) overrides config.json ---

  const includeCommitLink = envBool('INCLUDE_COMMIT_LINK', config.includeCommitLink ?? false);
  // Dry run: run the whole pipeline but skip the actual X publish + history write.
  const DRY_RUN = envBool('DRY_RUN', false);

  let routes = Array.isArray(config.routes) ? config.routes : undefined;
  if (process.env.ROUTES && process.env.ROUTES.trim()) {
    try {
      const parsed = JSON.parse(process.env.ROUTES);
      if (Array.isArray(parsed)) routes = parsed;
    } catch {
      console.warn('ROUTES env is not valid JSON; ignoring.');
    }
  }

  // cover.png overrides everything (static image mode).
  const USE_COVER = existsSync(COVER_PATH);
  const PREVIEW = !USE_COVER && config.preview ? config.preview : null;

  const baseRequired = {
    GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_SHA,
    GEMINI_API_KEY, X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_TOKEN_SECRET,
  };
  // Homepage URL only required when it's the image source.
  const required = (USE_COVER || PREVIEW) ? baseRequired : { ...baseRequired, HOMEPAGE_URL };
  for (const [k, v] of Object.entries(required)) {
    if (!v) throw new Error(`Missing required env var: ${k}`);
  }

  const imageMode = USE_COVER ? 'static cover' : PREVIEW ? 'local preview build' : 'deployed homepage';
  console.log(`Image mode: ${imageMode}; commit link ${includeCommitLink ? 'on' : 'off'}.`);

  const VOICE = buildVoice(includeCommitLink);

  // ---- 1. commit context ----

  const ghHeaders = { Authorization: `Bearer ${GITHUB_TOKEN}`, 'User-Agent': 'auto-post' };

  const commitRes = await fetch(
    `https://api.github.com/repos/${GITHUB_REPOSITORY}/commits/${GITHUB_SHA}`,
    { headers: ghHeaders },
  );
  if (!commitRes.ok) throw new Error(`GitHub commit fetch failed: ${commitRes.status} ${await commitRes.text()}`);
  const commit = await commitRes.json();

  const commitMessage = commit.commit?.message ?? '';
  const author = commit.author?.login ?? commit.commit?.author?.name ?? 'unknown';
  const files = (commit.files ?? []).slice(0, 25).map((f) => ({
    filename: f.filename,
    status: f.status,
    additions: f.additions,
    deletions: f.deletions,
    patch: typeof f.patch === 'string' ? f.patch.slice(0, 1500) : undefined,
  }));

  // The "why" of a change usually lives in the PR, not the merge commit.
  // Best-effort: pushes that didn't come through a PR just skip this.
  let pr = null;
  try {
    const prRes = await fetch(
      `https://api.github.com/repos/${GITHUB_REPOSITORY}/commits/${GITHUB_SHA}/pulls`,
      { headers: ghHeaders },
    );
    if (prRes.ok) {
      const prs = await prRes.json();
      if (Array.isArray(prs) && prs.length) {
        pr = { title: prs[0].title ?? '', body: (prs[0].body ?? '').slice(0, 1200) };
      }
    }
  } catch (err) {
    console.warn(`PR context fetch failed: ${err.message}`);
  }

  // Recent commit subjects give the arc of work this change belongs to.
  let recentSubjects = [];
  try {
    const listRes = await fetch(
      `https://api.github.com/repos/${GITHUB_REPOSITORY}/commits?sha=${GITHUB_SHA}&per_page=11`,
      { headers: ghHeaders },
    );
    if (listRes.ok) {
      recentSubjects = (await listRes.json())
        .slice(1) // drop the commit being posted about
        .map((c) => (c.commit?.message ?? '').split('\n')[0])
        .filter(Boolean)
        .reverse(); // oldest → newest
    }
  } catch (err) {
    console.warn(`Recent-commits fetch failed: ${err.message}`);
  }

  const prBlock = pr
    ? `\nPULL REQUEST (usually says why the change was made)\n- Title: ${pr.title}\n- Body (truncated): ${pr.body || '(empty)'}\n`
    : '';
  const recentBlock = recentSubjects.length
    ? `\nRECENT COMMITS, oldest first (the arc of work — mine these for why this change matters):\n${recentSubjects.map((s) => `- ${s}`).join('\n')}\n`
    : '';

  const history = loadHistory(HISTORY_PATH);

  // ---- 2. draft + candidate routes ----

  const routesHint = Array.isArray(routes) && routes.length
    ? `\n- Known routes in this app: ${JSON.stringify(routes)}`
    : '';
  const wantRoutes = !USE_COVER;

  const draftPlan = await gemini([{
    text: `${VOICE}

You are writing one short social post about the change below.

PROJECT
- Repo: ${GITHUB_REPOSITORY}${routesHint}
${USE_COVER ? '- Image: a static cover image already chosen by the project owner will be attached.' : '- Screenshots of the app will be taken; you choose which routes to try.'}

COMMIT
- Message: ${commitMessage}
- Author: ${author}
- Files changed (truncated):
${JSON.stringify(files, null, 2)}
${prBlock}${recentBlock}
TASK
Return ONLY a JSON object matching this exact schema (no prose):
{
  "post_text": string${wantRoutes ? `,
  "candidate_paths": string[],  // 1 to 3 URL paths most likely to visually showcase this change,
                                // ordered best-guess first. Use "/" if unsure.
                                // Examples: ["/", "/pricing", "/props/today"]
  "element_hint": {             // the single UI element the change is visible in (for a zoomed-in shot)
    "text": string | null,      // short distinguishing text rendered inside it, exactly as a user sees it
    "selector": string | null   // a CSS selector for it if the diff makes one obvious, else null
  } | null                      // null when no single element visibly changed` : ''}
}`,
  }]);

  let postText = (draftPlan.post_text ?? '').trim();
  if (!postText) throw new Error('Gemini returned empty post_text.');

  // ---- 3. image ----

  let imagePath;
  let imageNote; // human-readable description of the image for logs/summary/editor
  let previewProc = null;

  try {
    if (USE_COVER) {
      imagePath = COVER_PATH;
      imageNote = 'static cover image';
    } else {
      const { chromium } = await import('playwright');

      // Resolve the base URL: local preview server or deployed homepage.
      let baseUrl;
      if (PREVIEW) {
        const port = PREVIEW.port;
        if (!PREVIEW.command || !port) throw new Error('config.json preview needs both "command" and "port".');
        console.log(`Starting preview server: ${PREVIEW.command}`);
        previewProc = spawn(PREVIEW.command, {
          shell: true,
          cwd: REPO_ROOT,
          stdio: 'inherit',
          detached: true,
        });
        baseUrl = `http://127.0.0.1:${port}`;
        await waitForServer(new URL(PREVIEW.readyPath || '/', baseUrl).toString(), PREVIEW.timeoutSeconds || 180);
        console.log('Preview server is up.');
      } else {
        // Deployed-site mode. The deploy-gate (waiting for this commit to be
        // live) already ran as a workflow/action step before this script.
        baseUrl = HOMEPAGE_URL;
      }

      const candidates = (Array.isArray(draftPlan.candidate_paths) && draftPlan.candidate_paths.length
        ? draftPlan.candidate_paths : ['/'])
        .slice(0, 3)
        .map((p) => (typeof p === 'string' && p.trim() ? p.trim() : '/'));
      const elementHint = (draftPlan.element_hint && typeof draftPlan.element_hint === 'object')
        ? draftPlan.element_hint : null;

      // Screenshot candidate routes, pick the best full-page shot, then try to
      // zoom into the changed component. Temp files go to os.tmpdir() so we
      // never pollute the consumer's working tree (referenced mode runs from
      // the repo root).
      const browser = await chromium.launch();
      try {
        const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });

        const shots = await shootRoutes(ctx, baseUrl, candidates, 'r1');
        if (!shots.length) throw new Error('Every candidate screenshot failed.');
        const chosen = await pickBestShot(shots, postText, commitMessage);
        const fallback = { file: chosen.file, note: `screenshot of ${chosen.url}` };

        const closeup = await shootElementCloseUp(ctx, chosen.url, elementHint, 'r1');
        imagePath = closeup ?? fallback.file;
        imageNote = closeup ? `close-up of the changed component on ${chosen.url}` : fallback.note;

        // Verify the image shows the change. If it doesn't, widen the search
        // once: let the model map the diff to the repo's route/page files to
        // find where the changed UI actually renders. Final fallback is the
        // best full-page shot from the first round (previous behavior).
        if (!(await shotShowsChange(imagePath, postText, commitMessage))) {
          let recovered = false;
          const routeFiles = listRouteFiles(REPO_ROOT);
          if (routeFiles.length) {
            try {
              const tried = new Set(candidates);
              const widened = await gemini([{
                text: `A screenshot for this social post missed the change. Find where the changed UI actually renders.

POST DRAFT: ${postText}
COMMIT MESSAGE: ${commitMessage}
FILES CHANGED: ${JSON.stringify(files.map((f) => f.filename))}
ALREADY TRIED URL PATHS (do not repeat): ${JSON.stringify([...tried])}
ROUTE/PAGE FILES IN THE REPO:
${routeFiles.join('\n')}

Map the changed files to the routes that render them.
Return ONLY JSON:
{
  "candidate_paths": string[],  // 1 to 3 new URL paths where the change is most likely visible, best first
  "element_hint": { "text": string | null, "selector": string | null } | null
}`,
              }]);

              const newPaths = (Array.isArray(widened.candidate_paths) ? widened.candidate_paths : [])
                .filter((p) => typeof p === 'string' && p.trim() && !tried.has(p.trim()))
                .map((p) => p.trim())
                .slice(0, 3);
              if (newPaths.length) {
                const shots2 = await shootRoutes(ctx, baseUrl, newPaths, 'r2');
                if (shots2.length) {
                  const chosen2 = await pickBestShot(shots2, postText, commitMessage);
                  const hint2 = (widened.element_hint && typeof widened.element_hint === 'object')
                    ? widened.element_hint : elementHint;
                  const closeup2 = await shootElementCloseUp(ctx, chosen2.url, hint2, 'r2');
                  const file2 = closeup2 ?? chosen2.file;
                  if (await shotShowsChange(file2, postText, commitMessage)) {
                    imagePath = file2;
                    imageNote = closeup2
                      ? `close-up of the changed component on ${chosen2.url}`
                      : `screenshot of ${chosen2.url}`;
                    recovered = true;
                  }
                }
              }
            } catch (err) {
              console.warn(`Widened route search failed: ${err.message}`);
            }
          }
          if (!recovered) {
            console.warn('Change not visibly confirmed on any route; using the best full-page shot.');
            imagePath = fallback.file;
            imageNote = fallback.note;
          }
        }
      } finally {
        await browser.close();
      }
    }

    // ---- 4. editor pass ----

    const historyBlock = history.length
      ? `\nRECENT POSTS (do not repeat their hooks, structure, or phrasing):\n${history.map((h) => `- ${h.text}`).join('\n')}\n`
      : '';

    const edited = await gemini([{
      text: `${VOICE}

${RUBRIC}

You are the editor. Improve the draft below so it scores as high as possible on the rubric while staying strictly inside the voice rules. If the draft is already strong, tighten it; do not pad it.
${historyBlock}${prBlock}
DRAFT: ${postText}
COMMIT MESSAGE: ${commitMessage}
ATTACHED IMAGE: ${imageNote}

Return ONLY JSON: { "post_text": string, "critique": string }`,
    }], { maxOutputTokens: 8192 });

    const finalDraft = (edited.post_text ?? '').trim();
    if (finalDraft) {
      console.log(`Editor critique: ${edited.critique ?? '(none)'}`);
      postText = finalDraft;
    } else {
      console.warn('Editor pass returned empty text; keeping original draft.');
    }

    // ---- 5. post + record ----

    const TWEET_LIMIT = 280;
    let finalText;
    if (includeCommitLink) {
      const commitUrl = `${GITHUB_SERVER_URL || 'https://github.com'}/${GITHUB_REPOSITORY}/commit/${GITHUB_SHA}`;
      const withLink = `${postText} ${commitUrl}`;
      finalText = withLink.length <= TWEET_LIMIT ? withLink : postText.slice(0, TWEET_LIMIT);
    } else {
      finalText = postText.length <= TWEET_LIMIT ? postText : postText.slice(0, TWEET_LIMIT);
    }
    console.log('Final post:', finalText);

    if (DRY_RUN) {
      // Preview mode: everything ran except the publish. Nothing is written to
      // history (so no commit-back), and the draft + image are surfaced in the
      // job summary for review.
      console.log(`DRY RUN — not publishing to X. Would post with image: ${imageNote}`);
      const summary = process.env.GITHUB_STEP_SUMMARY;
      if (summary) {
        writeFileSync(
          summary,
          [
            '### Auto-post dry run (nothing published)',
            '',
            `**Would tweet:** ${finalText}`,
            `**Image:** ${imageNote}`,
            '',
          ].join('\n'),
          { flag: 'a' },
        );
      }
    } else {
      const { TwitterApi } = await import('twitter-api-v2');
      const twitter = new TwitterApi({
        appKey: X_API_KEY,
        appSecret: X_API_SECRET,
        accessToken: X_ACCESS_TOKEN,
        accessSecret: X_ACCESS_TOKEN_SECRET,
      });

      const mediaId = await twitter.v1.uploadMedia(imagePath, { mimeType: 'image/png' });
      const tweet = await twitter.v2.tweet({ text: finalText, media: { media_ids: [mediaId] } });
      console.log('Posted tweet id:', tweet.data.id);

      // Record for future runs (the workflow commits this file back to the repo).
      // Ensure the data dir exists — a referenced-model consumer may configure
      // everything via inputs and have no .github/auto-post/ directory yet.
      mkdirSync(dirname(HISTORY_PATH), { recursive: true });
      appendFileSync(HISTORY_PATH, JSON.stringify({
        sha: GITHUB_SHA,
        tweet_id: tweet.data.id,
        text: finalText,
        image: imageNote,
      }) + '\n');

      const summary = process.env.GITHUB_STEP_SUMMARY;
      if (summary) {
        writeFileSync(
          summary,
          [
            '### Auto-post published',
            '',
            `**Tweet:** ${finalText}`,
            `**Image:** ${imageNote}`,
            `**Tweet id:** ${tweet.data.id}`,
            '',
          ].join('\n'),
          { flag: 'a' },
        );
      }
    }
  } finally {
    if (previewProc && previewProc.pid) {
      try { process.kill(-previewProc.pid); } catch { /* already gone */ }
    }
  }
}

// Run the pipeline only when invoked directly (so tests can import the pure
// helpers above without triggering a post).
const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
