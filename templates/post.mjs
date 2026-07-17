// Auto-posts a project update to X when a merge lands on `main`.
// Part of the `project-update-auto-poster` skill / composite action.
//
// This ONE file runs in two modes:
//   • Vendored:   copied into a consumer's .github/auto-post/ and run with
//                 cwd = .github/auto-post (the classic install.sh layout).
//   • Referenced: bundled inside the composite action at actions/auto-post/,
//                 run with cwd = consumer repo root and AUTOPOST_DATA_DIR set
//                 to .github/auto-post. Config arrives via env (from action
//                 inputs) instead of config.json.
//
// Pipeline:
//   1. Pull commit context from the GitHub API.
//   2. Gemini drafts post text + candidate routes to screenshot.
//   3. Image source (first match wins):
//        a. cover.png       — static image, used verbatim
//        b. config.preview  — build & serve the pushed code locally, shoot it
//        c. homepage URL    — screenshot the deployed site (deploy-gate first)
//      When several routes are shot, Gemini vision picks the most engaging.
//   4. Editor pass: Gemini critiques the draft against an engagement rubric
//      + recent post history, then rewrites it.
//   5. Post to X with media. Append to history.jsonl (the workflow commits it
//      back so future runs learn from past posts).
//
// Edit VOICE to retune tone; edit RUBRIC to retune the editor.
//
// Design note: the deploy-gate poll lives HERE (not as a separate action
// step) so there is a single implementation that is mode-aware (only gates
// the deployed-homepage path) and backfill-aware (skips workflow_dispatch).

import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// ---------------------------------------------------------------- constants

// Gemini model fallback chain. `gemini-2.5-flash` was retired and 404s for
// newer API keys, so we try, in order: an explicit override, then the current
// "latest" aliases, then a concrete lite model. On 404/400 we advance to the
// next; any other status is a hard error.
const GEMINI_MODELS = [
  process.env.GEMINI_MODEL,
  'gemini-flash-latest',
  'gemini-flash-lite-latest',
  'gemini-2.5-flash-lite',
].filter(Boolean);

const RUBRIC = `
Engagement rubric (what makes a post worth reading):
- The first five words earn the rest: lead with the change's payoff, not preamble.
- Concrete beats abstract: name the thing ("live odds now refresh every 30s"), never "improved performance".
- One idea per post. If the commit did three things, pick the one users feel.
- Sound like a person shipping, not a changelog or a brand account.
- Vary structure against recent posts — if the last post opened with the feature name, don't do it again.
`.trim();

function buildVoice(includeCommitLink) {
  const limitLine = includeCommitLink
    ? '- Under 240 characters total (room is reserved for an auto-appended commit link).'
    : '- Under 270 characters total.';
  return `
Voice rules (follow strictly):
- Concise, builder tone — like a Show HN comment from someone shipping.
- 1–2 short sentences. Past tense. Plain language.
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

// Find the first BALANCED top-level {...} object in a string, scanning past
// string contents so braces inside string values don't skew the depth count.
// Respects \ escapes and " string boundaries. Returns the slice or null.
export function firstBalancedObject(s) {
  const start = s.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') {
      inStr = true;
    } else if (c === '{') {
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

// Parse JSON, tolerating trailing garbage after a valid object (some models
// emit a stray `}` after the JSON). Falls back to the first balanced object;
// rethrows the ORIGINAL parse error only if that also fails.
export function parseLenient(text) {
  try {
    return JSON.parse(text);
  } catch (orig) {
    const extracted = firstBalancedObject(text);
    if (extracted !== null && extracted !== text) {
      try {
        return JSON.parse(extracted);
      } catch {
        /* fall through to rethrow */
      }
    }
    throw orig;
  }
}

function envBool(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return v === 'true' || v === '1' || v === 'yes';
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- gemini (exported for smoke tests)

export async function gemini(parts, { maxOutputTokens = 8192 } = {}) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY is not set.');
  if (!GEMINI_MODELS.length) throw new Error('No Gemini models configured.');

  let lastErr;
  for (const model of GEMINI_MODELS) {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts }],
          generationConfig: { responseMimeType: 'application/json', temperature: 0.7, maxOutputTokens },
        }),
      },
    );

    if (res.ok) {
      const body = await res.json();
      const finish = body?.candidates?.[0]?.finishReason;
      const text = body?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) {
        throw new Error(`Gemini (${model}) returned no text${finish ? ` (finishReason ${finish})` : ''}. Body: ${JSON.stringify(body).slice(0, 500)}`);
      }
      try {
        return parseLenient(text);
      } catch (e) {
        throw new Error(`Failed to parse Gemini JSON from ${model}${finish ? ` (finishReason ${finish})` : ''}: ${e.message}. Raw: ${text.slice(0, 500)}`);
      }
    }

    // Retired / unknown model, or a bad request against this model name.
    if (res.status === 404 || res.status === 400) {
      lastErr = new Error(`Model ${model} unavailable: ${res.status} ${(await res.text()).slice(0, 200)}`);
      console.warn(`${lastErr.message} — trying next model.`);
      continue;
    }

    // Anything else (401, 429, 5xx) is a hard stop — retrying models won't help.
    throw new Error(`Gemini call failed (${model}): ${res.status} ${await res.text()}`);
  }
  throw lastErr || new Error('No Gemini model produced a response.');
}

// ---------------------------------------------------------------- runtime helpers

async function waitForServer(url, timeoutSeconds) {
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(2000);
  }
  throw new Error(`Preview server never became ready at ${url} within ${timeoutSeconds}s`);
}

// Poll a health endpoint that reports the currently-deployed commit SHA, and
// wait until it matches the target SHA. Prevents screenshotting the OLD UI
// when the deploy lags the merge. Fails on timeout rather than posting stale.
async function waitForDeployedSha(gate, targetSha) {
  const deadline = Date.now() + gate.timeoutSeconds * 1000;
  const pathParts = String(gate.shaJsonPath || 'commit').split('.');
  let lastSeen = 'unknown';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(gate.healthUrl, { cache: 'no-store' });
      if (res.ok) {
        const body = await res.json();
        let val = body;
        for (const p of pathParts) val = val?.[p];
        if (typeof val === 'string' && val) {
          lastSeen = val;
          // Tolerate short vs. full SHAs in either direction.
          if (val === targetSha || targetSha.startsWith(val) || val.startsWith(targetSha)) {
            console.log(`Deploy gate: health reports ${val}, matches target ${targetSha.slice(0, 7)}. Proceeding.`);
            return;
          }
        }
        console.log(`Deploy gate: deployed ${lastSeen}, waiting for ${targetSha.slice(0, 7)}...`);
      }
    } catch {
      /* endpoint not reachable yet */
    }
    await sleep(10000);
  }
  throw new Error(`Deploy gate timed out after ${gate.timeoutSeconds}s waiting for ${targetSha} at ${gate.healthUrl} (last seen: ${lastSeen})`);
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
    TRIGGER,
  } = process.env;

  // Where config.json / cover.png / history.jsonl live (all in the CONSUMER
  // repo). Vendored mode: cwd is already .github/auto-post → '.'. Referenced
  // mode: the action sets AUTOPOST_DATA_DIR and runs from the repo root.
  const DATA_DIR = process.env.AUTOPOST_DATA_DIR || '.';
  const REPO_ROOT = process.env.AUTOPOST_DATA_DIR ? process.cwd() : resolve('../..');
  const CONFIG_PATH = join(DATA_DIR, 'config.json');
  const COVER_PATH = resolve(DATA_DIR, 'cover.png');
  const HISTORY_PATH = join(DATA_DIR, 'history.jsonl');

  let fileConfig = {};
  if (existsSync(CONFIG_PATH)) fileConfig = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));

  // --- resolve config: env (action inputs) overrides config.json ---

  const includeCommitLink = envBool('INCLUDE_COMMIT_LINK', fileConfig.includeCommitLink ?? false);

  let routes = Array.isArray(fileConfig.routes) ? fileConfig.routes : undefined;
  if (process.env.ROUTES && process.env.ROUTES.trim()) {
    try {
      const parsed = JSON.parse(process.env.ROUTES);
      if (Array.isArray(parsed)) routes = parsed;
    } catch {
      console.warn('ROUTES env is not valid JSON; ignoring.');
    }
  }

  let deployGate = fileConfig.deployGate?.healthUrl ? { ...fileConfig.deployGate } : null;
  if (process.env.DEPLOY_GATE_HEALTH_URL && process.env.DEPLOY_GATE_HEALTH_URL.trim()) {
    deployGate = {
      healthUrl: process.env.DEPLOY_GATE_HEALTH_URL.trim(),
      shaJsonPath: (process.env.DEPLOY_GATE_SHA_JSON_PATH || deployGate?.shaJsonPath || 'commit').trim(),
      timeoutSeconds: Number(process.env.DEPLOY_GATE_TIMEOUT_SECONDS || deployGate?.timeoutSeconds || 720),
    };
  } else if (deployGate) {
    deployGate.shaJsonPath = deployGate.shaJsonPath || 'commit';
    deployGate.timeoutSeconds = deployGate.timeoutSeconds || 720;
  }

  const USE_COVER = existsSync(COVER_PATH);
  const PREVIEW = !USE_COVER && fileConfig.preview ? fileConfig.preview : null;
  const isBackfill = TRIGGER === 'workflow_dispatch';

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
  console.log(`Image mode: ${imageMode}${isBackfill ? ' (backfill)' : ''}; commit link ${includeCommitLink ? 'on' : 'off'}.`);

  const VOICE = buildVoice(includeCommitLink);

  // ---- 1. commit context ----

  const commitRes = await fetch(
    `https://api.github.com/repos/${GITHUB_REPOSITORY}/commits/${GITHUB_SHA}`,
    { headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, 'User-Agent': 'auto-post' } },
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

TASK
Return ONLY a JSON object matching this exact schema (no prose):
{
  "post_text": string${wantRoutes ? `,
  "candidate_paths": string[]   // 1 to 3 URL paths most likely to visually showcase this change,
                                // ordered best-guess first. Use "/" if unsure.
                                // Examples: ["/", "/pricing", "/props/today"]` : ''}
}`,
  }]);

  let postText = (draftPlan.post_text ?? '').trim();
  if (!postText) throw new Error('Gemini returned empty post_text.');

  // ---- 3. image ----

  let imagePath;
  let imageNote;
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
        baseUrl = HOMEPAGE_URL;
        // Deploy-gate: only for the deployed-homepage path, and never for a
        // backfill (the old commit's deploy is long gone).
        if (deployGate && !isBackfill) {
          console.log(`Deploy gate: polling ${deployGate.healthUrl} for SHA ${GITHUB_SHA.slice(0, 7)} (path "${deployGate.shaJsonPath}", up to ${deployGate.timeoutSeconds}s).`);
          await waitForDeployedSha(deployGate, GITHUB_SHA);
        } else if (deployGate && isBackfill) {
          console.log('Deploy gate: skipped for backfill run.');
        }
      }

      const candidates = (Array.isArray(draftPlan.candidate_paths) && draftPlan.candidate_paths.length
        ? draftPlan.candidate_paths : ['/'])
        .slice(0, 3)
        .map((p) => (typeof p === 'string' && p.trim() ? p.trim() : '/'));

      const shots = [];
      const browser = await chromium.launch();
      try {
        const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
        for (const [i, path] of candidates.entries()) {
          const url = new URL(path, baseUrl).toString();
          const file = join(tmpdir(), `auto-post-shot-${i}.png`);
          console.log(`Screenshotting candidate ${i}: ${url}`);
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
            console.warn(`Candidate ${i} (${url}) failed: ${err.message} — skipping.`);
          }
        }
      } finally {
        await browser.close();
      }
      if (!shots.length) throw new Error('Every candidate screenshot failed.');

      // Vision pass: Gemini looks at the actual images and picks the best one.
      let chosen = shots[0];
      if (shots.length > 1) {
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
        chosen = shots[idx];
        console.log(`Vision pick: [${idx}] ${chosen.path} — ${pick.reason ?? 'no reason given'}`);
      }
      imagePath = chosen.file;
      imageNote = `screenshot of ${chosen.url}`;
    }

    // ---- 4. editor pass ----

    const historyBlock = history.length
      ? `\nRECENT POSTS (do not repeat their hooks, structure, or phrasing):\n${history.map((h) => `- ${h.text}`).join('\n')}\n`
      : '';

    const edited = await gemini([{
      text: `${VOICE}

${RUBRIC}

You are the editor. Improve the draft below so it scores as high as possible on the rubric while staying strictly inside the voice rules. If the draft is already strong, tighten it; do not pad it.
${historyBlock}
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
  } finally {
    if (previewProc && previewProc.pid) {
      try {
        process.kill(-previewProc.pid);
      } catch {
        /* already gone */
      }
    }
  }
}

function loadHistory(historyPath, limit = 10) {
  if (!existsSync(historyPath)) return [];
  return readFileSync(historyPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean)
    .slice(-limit);
}

// Run the pipeline only when invoked directly (so tests can import the pure
// helpers above without triggering a post).
const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
