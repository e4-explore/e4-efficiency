// Auto-posts a project update to X when a merge lands on `main`.
// Installed by the `project-update-auto-poster` skill.
//
// Pipeline:
//   1. Pull commit context from the GitHub API.
//   2. Gemini drafts post text + candidate routes to screenshot.
//   3. Image source (first match wins):
//        a. .github/auto-post/cover.png  — static image, used verbatim
//        b. config.json "preview"        — build & serve the pushed code
//                                          locally, screenshot candidate
//                                          routes, Gemini vision picks best
//        c. repo homepage URL            — screenshot candidate routes on
//                                          the deployed site, vision picks
//   4. Editor pass: Gemini critiques the draft against an engagement
//      rubric + recent post history, rewrites it.
//   5. Post to X with media. Append to history.jsonl (the workflow
//      commits it back so future runs learn from past posts).
//
// Edit the VOICE block to retune tone; edit RUBRIC to retune the editor.

import { chromium } from 'playwright';
import { TwitterApi } from 'twitter-api-v2';
import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';

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

// ---------------------------------------------------------------- config

// Optional per-repo config committed at .github/auto-post/config.json:
// {
//   "preview": {                      // build & serve the pushed code in CI
//     "command": "npm ci && npm run build && npx serve -l 4173 dist",
//     "port": 4173,                   // port the served app listens on
//     "readyPath": "/",               // path polled until it returns 200
//     "timeoutSeconds": 180           // max wait for the server to come up
//   },
//   "routes": ["/", "/props", "/leaderboard"]   // hint list for Gemini
// }
let config = {};
if (existsSync('config.json')) {
  config = JSON.parse(readFileSync('config.json', 'utf8'));
}

// cover.png next to this script overrides everything (static image mode).
const COVER_PATH = resolve('cover.png');
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
console.log(`Image mode: ${imageMode}`);

// ---------------------------------------------------------------- voice

const VOICE = `
Voice rules (follow strictly):
- Concise, builder tone — like a Show HN comment from someone shipping.
- 1–2 short sentences. Past tense. Plain language.
- No hype words: never "amazing", "exciting", "game-changer", "thrilled", "stoked", "huge", "massive".
- No exclamation marks.
- At most one fitting emoji (optional, skip if unsure).
- No hashtags unless they genuinely add reach.
- Under 240 characters total (room is reserved for an auto-appended commit link).
- Speak about the project in the third person or the work in the first-person plural ("we"), never "I".
- If the change is purely internal/no user impact, say so plainly — don't pretend it's a feature.
`.trim();

const RUBRIC = `
Engagement rubric (what makes a post worth reading):
- The first five words earn the rest: lead with the change's payoff, not preamble.
- Concrete beats abstract: name the thing ("live odds now refresh every 30s"), never "improved performance".
- One idea per post. If the commit did three things, pick the one users feel.
- Sound like a person shipping, not a changelog or a brand account.
- Vary structure against recent posts — if the last post opened with the feature name, don't do it again.
`.trim();

// ---------------------------------------------------------------- helpers

async function gemini(parts, { maxOutputTokens = 1024 } = {}) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts }],
        generationConfig: {
          responseMimeType: 'application/json',
          temperature: 0.7,
          maxOutputTokens,
        },
      }),
    },
  );
  if (!res.ok) throw new Error(`Gemini call failed: ${res.status} ${await res.text()}`);
  const body = await res.json();
  const text = body?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error(`Gemini returned no text. Body: ${JSON.stringify(body).slice(0, 500)}`);
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`Failed to parse Gemini JSON: ${e.message}. Raw: ${text.slice(0, 500)}`);
  }
}

function loadHistory(limit = 10) {
  if (!existsSync('history.jsonl')) return [];
  return readFileSync('history.jsonl', 'utf8')
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
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`Preview server never became ready at ${url} within ${timeoutSeconds}s`);
}

// ---------------------------------------------------------------- 1. commit context

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

const commitUrl = `${GITHUB_SERVER_URL || 'https://github.com'}/${GITHUB_REPOSITORY}/commit/${GITHUB_SHA}`;
const history = loadHistory();

// ---------------------------------------------------------------- 2. draft + candidate routes

const routesHint = Array.isArray(config.routes) && config.routes.length
  ? `\n- Known routes in this app: ${JSON.stringify(config.routes)}`
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

// ---------------------------------------------------------------- 3. image

let imagePath;
let imageNote; // human-readable description of the image for logs/summary/editor
let previewProc = null;

try {
  if (USE_COVER) {
    imagePath = COVER_PATH;
    imageNote = 'static cover image';
  } else {
    // Resolve the base URL: local preview server or deployed homepage.
    let baseUrl;
    if (PREVIEW) {
      const port = PREVIEW.port;
      if (!PREVIEW.command || !port) throw new Error('config.json preview needs both "command" and "port".');
      console.log(`Starting preview server: ${PREVIEW.command}`);
      // Run from the repo root (this script lives in .github/auto-post).
      previewProc = spawn(PREVIEW.command, {
        shell: true,
        cwd: resolve('../..'),
        stdio: 'inherit',
        detached: true,
      });
      baseUrl = `http://127.0.0.1:${port}`;
      await waitForServer(new URL(PREVIEW.readyPath || '/', baseUrl).toString(), PREVIEW.timeoutSeconds || 180);
      console.log('Preview server is up.');
    } else {
      baseUrl = HOMEPAGE_URL;
    }

    const candidates = (Array.isArray(draftPlan.candidate_paths) && draftPlan.candidate_paths.length
      ? draftPlan.candidate_paths : ['/'])
      .slice(0, 3)
      .map((p) => (typeof p === 'string' && p.trim() ? p.trim() : '/'));

    // Screenshot every candidate route.
    const shots = [];
    const browser = await chromium.launch();
    try {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      for (const [i, path] of candidates.entries()) {
        const url = new URL(path, baseUrl).toString();
        const file = `screenshot-${i}.png`;
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
      ], { maxOutputTokens: 256 });

      const idx = Number.isInteger(pick.best_index) && pick.best_index >= 0 && pick.best_index < shots.length
        ? pick.best_index : 0;
      chosen = shots[idx];
      console.log(`Vision pick: [${idx}] ${chosen.path} — ${pick.reason ?? 'no reason given'}`);
    }
    imagePath = chosen.file;
    imageNote = `screenshot of ${chosen.url}`;
  }

  // ---------------------------------------------------------------- 4. editor pass

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
  }], { maxOutputTokens: 512 });

  const finalDraft = (edited.post_text ?? '').trim();
  if (finalDraft) {
    console.log(`Editor critique: ${edited.critique ?? '(none)'}`);
    postText = finalDraft;
  } else {
    console.warn('Editor pass returned empty text; keeping original draft.');
  }

  // ---------------------------------------------------------------- 5. post + record

  const TWEET_LIMIT = 280;
  const withLink = `${postText} ${commitUrl}`;
  const finalText = withLink.length <= TWEET_LIMIT ? withLink : postText.slice(0, TWEET_LIMIT);
  console.log('Final post:', finalText);

  const twitter = new TwitterApi({
    appKey: X_API_KEY,
    appSecret: X_API_SECRET,
    accessToken: X_ACCESS_TOKEN,
    accessSecret: X_ACCESS_TOKEN_SECRET,
  });

  const mediaId = await twitter.v1.uploadMedia(imagePath, { mimeType: 'image/png' });
  const tweet = await twitter.v2.tweet({
    text: finalText,
    media: { media_ids: [mediaId] },
  });
  console.log('Posted tweet id:', tweet.data.id);

  // Record for future runs (the workflow commits this file back to the repo).
  appendFileSync('history.jsonl', JSON.stringify({
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
    try { process.kill(-previewProc.pid); } catch { /* already gone */ }
  }
}
