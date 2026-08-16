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
//   2. Gemini segments the commit into 1-4 distinct changes (most pushes are
//      one coherent change and get exactly one; a push that bundles a few
//      unrelated tweaks gets one clause + one image per change), each with
//      its own draft clause + candidate routes to screenshot.
//   3. Per change, image source (first match wins):
//        a. cover.png       — static image, used verbatim (always singular —
//                             skips segmentation entirely)
//        b. config.preview  — build & serve the pushed code locally, shoot it
//        c. homepage URL    — screenshot the deployed site
//      When several routes are shot, Gemini vision picks the most engaging;
//      it can also drive the page (click/hover/select) toward a better state.
//      A change the model tags as an interaction/motion (drag/reorder, expand,
//      tab switch, hover reveal…) is instead RECORDED: a vision loop drives the
//      real interaction with a synthetic cursor, trimmed+transcoded to mp4
//      (falls back to a still on no ffmpeg / nav miss / any error).
//      A change whose capture all fails is dropped (text-only), not fatal.
//   4. Editor pass: Gemini critiques the assembled draft against an
//      engagement rubric + recent post history, then rewrites it.
//   5. Post to X with up to 4 images, OR a single video (X allows either, never
//      a mix — a video wins and other media is dropped, text lines kept).
//      Append to history.jsonl (the workflow commits it back so future runs
//      learn from past posts).
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
import { pathToFileURL, fileURLToPath } from 'node:url';
import { decide as decideSchedule } from './schedule.mjs';

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

// Backoff schedule for transient 503s within a single model's attempts.
// A run makes several gemini() calls (draft, vision pick, verification,
// editor); kept short so repeated overload across calls can't blow past
// the workflow's job timeout.
const GEMINI_503_RETRY_DELAYS_MS = [2000, 5000];

const RUBRIC = `
Engagement rubric (what makes a post worth reading):
- One idea per change: the change plus why it matters, in a single natural sentence.
- The "why" is real product value a stranger can feel ("MLS bets are in now"), never a restatement of the change ("to reflect broader coverage"), and never just the internal mechanism or the name of the library/system/theme used ("uses Carbon icons"). If the change is conceptual or visual, say what it now lets a user do or feel, not which system powers it.
- Lead with the idea or the payoff, not the act of shipping. The first line has to earn the read on its own; a reader who doesn't know the product should still get why this is interesting.
- A genuine take or an honest question can lift a post from informative to engaging, but only when it's TRUE to the change and something a real builder would actually say. It has to be earned by the substance, never manufactured, never clickbait or reply-bait. No honest take to make? Ship the clean statement.
- Concrete beats abstract: name the thing ("live odds now refresh every 30s"), never "improved performance".
- Earn the cold read. Most reach is out-of-network (people who don't follow you, with zero context), and X taxes out-of-network posts by 25%. What beats that tax is an ORIGINAL a stranger will reply to, quote, DM, or copy the link to send a friend. On the real published weights a copy-link share and a reply on your original from a mutual are the two biggest signals (+20 each); a like is +0.5 and a profile visit is worth 0, so write to be forwarded and replied to, not liked.
- Forward-worthy beats clever: a concrete, specific detail (a real number, a before/after, a crisp how or why) is what a stranger sends to a friend or quotes with a comment. If it isn't worth forwarding, it isn't scoring.
- State it as a fact about the product, not a narrated action: "the 'Create App' button makes it faster to spin up a new project", not "We renamed the setup button to 'Create App' so it's easier to spin up a new project".
- Sound like a person, not a changelog or a press release. Casual and direct beats stiff and formal.
- Be genuinely different from your recent posts, not just reworded. X's diversity rerank and author-diversity decay both down-rank a feed full of your near-identical updates, so vary the angle and the framing (and the visual), not only the first word.
- When a push bundles several distinct changes: each gets its own line, ordered
  most user-facing first, no connective narration ("also", "plus", "additionally")
  between them. Every line stands alone, same rules as a single post.
`.trim();

function buildVoice(includeCommitLink) {
  const limitLine = includeCommitLink
    ? '- Under 240 characters total (room is reserved for an auto-appended commit link).'
    : '- Under 280 characters total.';
  return `
Voice rules (follow strictly):
- One statement per change: name the change, then why it matters, in a single natural sentence. e.g. "the 'Create App' button makes it faster to spin up a new project" rather than "We renamed the setup button to 'Create App' so it's easier to spin up a new project".
- Write like a person talking, not a marketer or a changelog. Casual, plain, direct. Contractions are good (it's, you're, doesn't).
- Never use "we", "our", or "I" as the subject. Never open with a changelog verb: no "Added/Fixed/Updated/Renamed/Improved/Introduced X" (with OR without a following "so Y"), and never "Added the ability to/for X". Those narrate the act of shipping instead of stating the idea. Lead with what the thing does or lets someone do (e.g. "Icons now change with the theme, not just the colors" rather than "Added different icon packs per theme").
- Never the changelog pattern "X now does Y to reflect Z".
- Assume the reader has never heard of this project. Give just enough that a stranger can tell what it is and why the change matters, still in one casual sentence. Never bolt on a boilerplate "In [Product]," label to do it, let the orientation live inside the sentence.

Do NOT write like AI. Specifically:
- No em dashes or en dashes (the "—" or "–" characters) anywhere. Use a comma, a period, or reword the sentence. This is the single most important rule.
- Drop the "feature — benefit" / "does X, keeping things Y" appendage formula. Just say the thing.
- No rule-of-three padding ("clean, fast, and easy to scan"): keep the one that actually matters.
- Never these tell-words or phrases: seamless(ly), robust, elevate, leverage, streamline, effortless, empower, unlock, delve, boasts, "designed to", "ensures that", "when it comes to", "not only ... but also", "it's worth noting", "in today's", "game changer", "the power of".
- No hype words: "amazing", "exciting", "thrilled", "stoked", "huge", "massive".
- No exclamation marks. No emojis anywhere. No hashtags unless they genuinely add reach.
${limitLine}

Engagement, but only when it's honest:
- A single genuine take or one honest question is welcome after the statement WHEN there is a real one to make: a specific opinion or tradeoff a thoughtful builder would actually voice about this exact change, true to what shipped and adding real insight. When there isn't one, just state the thing well and stop. A clean factual post beats a forced take.
- Never manufacture engagement. No clickbait or reply-farming ("agree?", "thoughts?", "am I wrong?", "who else", "retweet if"), no fake controversy, no rage-bait, no question asked only to pull replies.
- Never trash, dunk on, or undercut the thing you're announcing. A real, specific, defensible tradeoff is fair to raise, but frame it as a tradeoff, not as calling your own work bad.
- Still one idea: a take or question extends the statement, it doesn't bolt on a second unrelated point.
- If the change is purely internal with no user impact, say so plainly; don't dress it up as a feature.
- If the push bundles multiple distinct changes, put each on its own line (a
  short list, no bullets/numbering) instead of one run-on sentence. See the
  rubric for ordering and connective-word rules.
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

// X media rules: a post carries EITHER up to 4 images OR a single video, never
// a mix. Given the per-change media list (ordered most-user-facing first),
// return what actually gets attached: the first video alone if any change
// produced one, else up to 4 images. droppedForVideo reports how many items the
// single-video rule shed (their text lines still post).
export function pickPostMedia(media) {
  const list = Array.isArray(media) ? media.filter((m) => m && m.file) : [];
  const firstVideo = list.find((m) => m.type === 'video');
  if (firstVideo) return { items: [firstVideo], droppedForVideo: list.length - 1 };
  return { items: list.slice(0, 4), droppedForVideo: 0 };
}

// Belt-and-suspenders removal of the mechanical "AI wrote this" tells the model
// still slips in despite the voice rules. The em/en dash is the loudest signal:
// a dash (with whatever spacing) becomes a comma, which keeps the line casual
// and flowing. Deliberately conservative — it only touches punctuation and
// spacing, never rewords, and preserves newlines so bundled posts keep one
// change per line. Rewording the underlying phrasing is the voice rules' job.
export function stripAiTells(text) {
  return String(text)
    .replace(/[ \t]*[—–][ \t]*/g, ', ') // — or – (any surrounding spaces) -> ", "
    .replace(/,[ \t]*,/g, ',')                     // collapse a doubled comma the swap may create
    .replace(/,([ \t]*[.;:!?])/g, '$1')            // ", ." -> "." when a dash sat before end punctuation
    .replace(/[ \t]+([,.;:!?])/g, '$1')            // no space before punctuation
    .replace(/[ \t]{2,}/g, ' ')                     // collapse runs of spaces
    .replace(/[ \t]+$/gm, '');                      // trim trailing spaces per line
}

// Deterministic voice-rule lint. Returns the mechanical voice violations we can
// read straight off the text — the ones the optimizer tends to reintroduce when
// it chases the engagement score. Semantic judgments (is a take genuine, is a
// question honest vs clickbait beyond the obvious farm phrases) stay with the
// LLM/constraints; this catches the checkable ones so the score-optimizer can
// never trade them away. Used as a gate: the optimizer may not raise this count.
export function lintVoice(text) {
  const t = String(text || '');
  const first = (t.split('\n').find((l) => l.trim()) || '').trim();
  const violations = [];
  // Banned changelog opener ("Added/Fixed/Updated X…") — voice leads with the idea.
  if (/^(added|fixed|updated|renamed|improved|introduced|refactored|removed|changed|shipped|created|implemented)\b/i.test(first)) {
    violations.push({ rule: 'changelog-opener', detail: first.slice(0, 40) });
  }
  // Cheap reply-farming phrases (clickbait) — a genuine question is fine, these aren't.
  const farm = t.match(/\b(?:agree|thoughts)\?|\b(?:am i wrong|change my mind|who else|retweet if|tell me below|like if|comment below|sound off)\b|\bdrop a (?:reply|comment|like|❤)/i);
  if (farm) violations.push({ rule: 'reply-farm', detail: farm[0] });
  if (/[—–]/.test(t)) violations.push({ rule: 'em-dash' });
  if (/[!]/.test(t)) violations.push({ rule: 'exclamation' });
  if (/\p{Extended_Pictographic}/u.test(t)) violations.push({ rule: 'emoji' });
  const hashtags = (t.match(/(^|\s)#[A-Za-z]\w*/g) || []).length;
  if (hashtags > 1) violations.push({ rule: 'hashtags', detail: String(hashtags) });
  if (t.length > 280) violations.push({ rule: 'over-length', detail: String(t.length) });
  return violations;
}

// ---------------------------------------------------------------- project context (exported pure helpers for tests)

// How long the "what this project is" blurb fed into the prompts may get. Kept
// short so it orients without bloating the prompt or drowning the change itself.
const PROJECT_CONTEXT_CAP = 300;

const collapseWs = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const ensureStop = (s) => (/[.!?]$/.test(s) ? s : `${s}.`);
// Two blurbs are "the same" if either starts with the other's first ~40 chars —
// enough to catch a README intro that just restates the repo description.
function sameGist(a, b) {
  if (!a || !b) return false;
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  return la.includes(lb.slice(0, 40)) || lb.includes(la.slice(0, 40));
}
function truncateContext(s, cap = PROJECT_CONTEXT_CAP) {
  const t = collapseWs(s);
  if (t.length <= cap) return t;
  const cut = t.slice(0, cap - 1);
  const sp = cut.lastIndexOf(' ');
  const base = sp > cap * 0.6 ? cut.slice(0, sp) : cut;
  return `${base.replace(/[\s.,;:]+$/, '')}…`;
}

// Pull the first real prose paragraph out of a README's markdown — past the
// title, badge/shield rows, logo blocks, HTML comments, and code fences. This
// is the auto-derived "what is this project" fallback when the owner hasn't set
// one. Returns '' when the README is all chrome and no prose.
export function readmeIntro(markdown) {
  const md = String(markdown || '').replace(/<!--[\s\S]*?-->/g, '');
  for (const raw of md.split(/\n\s*\n/)) {
    const block = raw.trim();
    if (!block || block.startsWith('```')) continue; // skip blanks + code fences
    const t = block
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')   // markdown images
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // links -> their text
      .replace(/<[^>]+>/g, ' ')                // html tags
      .replace(/^[>\s]*#{1,6}\s.*$/gm, '')     // heading lines (incl. blockquoted)
      .replace(/[`*_~]+/g, '')                 // emphasis / backticks
      .replace(/\s+/g, ' ')
      .trim();
    // Real prose only: not a leftover heading, has a space, some letters, and
    // enough length that a badge row or bare title doesn't sneak through.
    if (!t || /^#{1,6}\s/.test(t) || t.length < 15 || !/\s/.test(t) || !/[a-zA-Z]/.test(t)) continue;
    return t;
  }
  return '';
}

// Compose the final project-context blurb from its available pieces, in priority
// order (repo description first — it's the owner's own one-liner — then the
// README intro if it adds anything, then the homepage as a trailing note).
// Truncated to `cap`. Deterministic and network-free so it's unit-testable.
export function composeProjectContext({ description = '', readmeIntro: intro = '', homepage = '' } = {}, cap = PROJECT_CONTEXT_CAP) {
  const desc = collapseWs(description);
  const rd = collapseWs(intro);
  const home = collapseWs(homepage);
  const parts = [];
  if (desc) parts.push(ensureStop(desc));
  if (rd && !sameGist(rd, desc)) parts.push(ensureStop(rd));
  let text = parts.join(' ');
  if (home && !text.includes(home)) text = text ? `${text} Site: ${home}` : `Site: ${home}`;
  return truncateContext(text, cap);
}

// Resolve a short, stable "what this project is" blurb to ground the post copy.
// Owner-authored wins (PROJECT_CONTEXT env / config.projectContext, used
// verbatim); otherwise auto-derive from the repo description + homepage + README
// intro. Best-effort throughout — every fetch is guarded and any failure just
// drops that source, so the worst case reproduces today's behavior (no blurb).
async function resolveProjectContext({ config, repo, ghHeaders }) {
  const owner = collapseWs(process.env.PROJECT_CONTEXT || (typeof config.projectContext === 'string' ? config.projectContext : ''));
  if (owner) return truncateContext(owner);

  let description = '';
  let homepage = '';
  let intro = '';
  try {
    const r = await fetch(`https://api.github.com/repos/${repo}`, { headers: ghHeaders });
    if (r.ok) {
      const j = await r.json();
      description = j.description || '';
      homepage = j.homepage || '';
    }
  } catch (err) {
    console.warn(`Project-context repo fetch failed: ${err.message}`);
  }
  try {
    const r = await fetch(`https://api.github.com/repos/${repo}/readme`, { headers: ghHeaders });
    if (r.ok) {
      const j = await r.json();
      if (j && j.content) {
        const md = Buffer.from(j.content, j.encoding === 'base64' ? 'base64' : 'utf8').toString('utf8');
        intro = readmeIntro(md);
      }
    }
  } catch (err) {
    console.warn(`Project-context README fetch failed: ${err.message}`);
  }
  return composeProjectContext({ description, readmeIntro: intro, homepage });
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
    // 503 means the model is transiently overloaded (Google's own wording:
    // "high demand... usually temporary") — worth a couple of backed-off
    // retries on the same model before writing it off. 404/400/other 5xx
    // are not fixed by waiting, so those fall straight through.
    for (let attempt = 0; ; attempt++) {
      res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload },
      );
      if (res.ok) break;
      lastErr = `${res.status} ${await res.text()}`;
      if (res.status !== 503 || attempt >= GEMINI_503_RETRY_DELAYS_MS.length) break;
      const delay = GEMINI_503_RETRY_DELAYS_MS[attempt];
      console.warn(`Model ${model} overloaded (503); retrying in ${delay}ms.`);
      await sleep(delay);
    }
    if (res.ok) break;
    // 404/400 mean this model id is unavailable to this key — try the next one.
    // Anything else (quota, auth, persistent 5xx) is not fixed by switching models: stop.
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
Pick the one that best SHOWS the change described — prefer visible content over empty states, error pages, or generic landing pages. Also favor a TIGHT, change-focused framing where the subject fills the frame and reads clearly at thumbnail size in a feed; down-rank wide catalog/gallery/storybook views where the subject is small amid lots of whitespace. The image's real job is to stop a stranger's scroll and make the post worth replying to or forwarding, so pick the most legible, self-explanatory frame that lands with zero context, not a flat or near-empty one.

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
export async function shootElementCloseUp(ctx, url, hint, tag) {
  if (!hint || (!hint.text && !hint.selector)) return null;
  const page = await ctx.newPage();
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 }).catch(async () => {
      await page.goto(url, { waitUntil: 'load', timeout: 30_000 });
    });
    // Prefer a match in the main content area, not the app chrome — the hint
    // text ("Badge") often also appears in the sidebar nav, and grabbing that
    // would crop the wrong thing. Skips anything inside nav/aside/header/sidebar.
    const inChrome = (el) => !!el.closest('nav,aside,header,[role=navigation],[class*="sidebar" i],[class*="Sidebar" i]');
    const firstContentMatch = async (loc) => {
      const n = Math.min(await loc.count(), 20);
      let fallback = null;
      for (let i = 0; i < n; i++) {
        const cand = loc.nth(i);
        if (!(await cand.isVisible().catch(() => false))) continue;
        if (fallback === null) fallback = cand;
        const chrome = await cand.evaluate(inChrome).catch(() => false);
        if (!chrome) return cand;
      }
      return fallback;
    };

    let target = null;
    if (hint.selector) {
      try { target = await firstContentMatch(page.locator(hint.selector)); }
      catch { /* model-supplied selector may be invalid syntax */ }
    }
    if (!target && hint.text) {
      target = await firstContentMatch(page.getByText(hint.text, { exact: false }));
    }
    if (!target) {
      console.warn(`Close-up: element not found for hint ${JSON.stringify(hint)}.`);
      return null;
    }

    // The hint often matches a small label; climb to a crop-worthy container,
    // but stop at a wide readable band (e.g. a row of variants) — a low height
    // is fine — and refuse to climb into a parent that balloons in BOTH
    // dimensions, which means we'd be leaping into the empty story canvas
    // around the content (the exact bug that shot a tiny badge on a blank page).
    const handle = await target.evaluateHandle((el) => {
      let n = el;
      while (n.parentElement) {
        const r = n.getBoundingClientRect();
        if (r.width >= 280 && r.height >= 24) break;
        const pr = n.parentElement.getBoundingClientRect();
        const balloons = pr.height > r.height * 3 && pr.width > r.width * 1.5;
        if (r.width >= 120 && r.height >= 20 && balloons) break;
        n = n.parentElement;
      }
      return n;
    });
    // boundingBox() is top-frame viewport coords (frame-safe for Storybook's
    // preview iframe), which is what page.screenshot({clip}) expects.
    const box = await handle.asElement().boundingBox();
    const vp = page.viewportSize() || { width: 1280, height: 800 };
    if (!box || box.width < 40 || box.height < 24) {
      console.warn('Close-up: container too small or unmeasurable; using the full-page shot instead.');
      return null;
    }
    if (box.width * box.height > vp.width * vp.height * 0.85) {
      console.warn('Close-up: container covers almost the whole page; using the full-page shot instead.');
      return null;
    }
    // Pad the crop so the component has breathing room rather than sitting
    // edge-to-edge; clamp to the viewport.
    const PAD = 28;
    const x = Math.max(0, box.x - PAD);
    const y = Math.max(0, box.y - PAD);
    const clip = {
      x, y,
      width: Math.min(vp.width - x, box.width + PAD * 2),
      height: Math.min(vp.height - y, box.height + PAD * 2),
    };
    const file = join(tmpdir(), `auto-post-closeup-${tag}.png`);
    await page.screenshot({ path: file, clip });
    console.log(`Close-up captured (${Math.round(clip.width)}x${Math.round(clip.height)}, padded) on ${url}.`);
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

// ---------------------------------------------------------------- interactive browse

// This site is driven UNATTENDED and the result is posted PUBLICLY, so the
// browse loop must never trigger a mutating, financial, account, or outward-
// send action. Any offered element whose accessible name matches this is
// removed from the action set the model can pick from. Deliberately does NOT
// block navigational/display toggles like "Apply theme", tabs, or menus —
// those are exactly what produce a compelling shot.
const UNSAFE_ACTION_NAME = /\b(delete|remove|discard|destroy|erase|deactivate|pay|buy|purchase|checkout|order|subscribe|unsubscribe|withdraw|transfer|deposit|log\s?out|sign\s?out|reset password|delete account|confirm payment|send (message|email|invite)|publish|new comment|post comment)\b/i;

// Tags visible interactive elements across the page's same-origin frames with a
// data attribute and returns a compact list the model can pick from by `ref`.
// Re-run every step because acting on the page changes the DOM. Storybook is
// the motivating case: the sidebar nav and theme toolbar live in the top
// frame, story internals in a child iframe — both are covered.
export async function snapshotInteractives(page) {
  const tagger = (frameIndex) => {
    // Includes text inputs / the catalog search box (marked editable) so the
    // loop can type a component name into search to jump straight to it, or
    // focus/fill the changed field to reveal a focus-state change.
    const SEL = 'a,button,select,summary,input:not([type=hidden]),textarea,[contenteditable=""],[contenteditable=true],[role=button],[role=tab],[role=menuitem],[role=menuitemradio],[role=switch],[role=link],[role=option],[role=searchbox],[role=textbox],[aria-haspopup]';
    const EDITABLE_TYPES = new Set(['text', 'search', 'email', 'url', 'tel', 'number', '']);
    const items = [];
    let i = 0;
    for (const el of document.querySelectorAll(SEL)) {
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      const visible = r.width > 2 && r.height > 2 && r.bottom > 0 && r.top < innerHeight
        && r.right > 0 && r.left < innerWidth
        && st.visibility !== 'hidden' && st.display !== 'none' && st.pointerEvents !== 'none';
      if (!visible) continue;
      const tag = el.tagName.toLowerCase();
      const type = (el.getAttribute('type') || '').toLowerCase();
      const editable = (tag === 'textarea')
        || el.isContentEditable
        || el.getAttribute('role') === 'searchbox' || el.getAttribute('role') === 'textbox'
        || (tag === 'input' && EDITABLE_TYPES.has(type));
      if (tag === 'input' && type === 'password') continue; // never type into passwords
      const name = (el.getAttribute('aria-label') || el.innerText || el.getAttribute('placeholder') || el.value || el.getAttribute('title') || '')
        .trim().replace(/\s+/g, ' ').slice(0, 80);
      if (!name) continue;
      el.setAttribute('data-autopost-ref', `${frameIndex}:${i}`);
      const item = { ref: `${frameIndex}:${i}`, tag, role: el.getAttribute('role') || null, name };
      if (editable) item.editable = true;
      // Collapsed/expanded state lets the nav-drill reveal nested items.
      const ae = el.getAttribute('aria-expanded');
      if (ae === 'true' || ae === 'false') item.expanded = ae === 'true';
      else if (tag === 'summary') item.expanded = !!(el.parentElement && el.parentElement.open);
      if (el.tagName === 'SELECT') item.options = [...el.options].map((o) => o.value).slice(0, 12);
      items.push(item);
      if (++i >= 55) break;
    }
    return items;
  };

  const frames = page.frames();
  const all = [];
  for (let f = 0; f < frames.length; f++) {
    try {
      const items = await frames[f].evaluate(tagger, f);
      all.push(...items);
    } catch { /* cross-origin or detached frame — skip */ }
    if (all.length >= 80) break;
  }
  return all;
}

function refLocator(page, ref) {
  const frameIndex = Number(String(ref).split(':')[0]);
  const frame = page.frames()[frameIndex];
  if (!frame) return null;
  return frame.locator(`[data-autopost-ref="${ref}"]`).first();
}

// Type text into a control the way the browse/nav loops intend: focus + replace,
// never submit. Playwright's fill() throws ("Element is not an <input>,
// <textarea> or [contenteditable]") when the ref points at a wrapper that isn't
// itself fillable — the common case is a combobox/search field (e.g. downshift)
// whose real <input> is nested inside it, which is precisely what stalled the
// vision loop. Recover by filling that inner field, and if there is none, by
// focusing the control and typing via the keyboard. Only rethrows genuine
// failures on real fields (timeout, detached) so callers keep their try/catch.
async function typeIntoField(page, loc, value) {
  const text = String(value ?? '').slice(0, 60);
  try {
    await loc.fill(text, { timeout: 8000 });
    return;
  } catch (err) {
    if (!/not an <input>/i.test(err.message)) throw err; // real field failed, not a wrapper
  }
  const inner = loc.locator('input:not([type=hidden]), textarea, [contenteditable=""], [contenteditable=true]').first();
  try {
    if (await inner.count()) {
      await inner.fill(text, { timeout: 8000 });
      return;
    }
  } catch { /* no fillable descendant — fall through to keyboard */ }
  // Last resort: focus the control and type. Select-all first so we replace any
  // existing value; never press Enter, so nothing is submitted.
  await loc.click({ timeout: 8000 });
  await page.keyboard.press('Control+A').catch(() => {});
  if (text) await page.keyboard.type(text, { delay: 10 });
  else await page.keyboard.press('Delete').catch(() => {});
}

// ---------------------------------------------------------------- deterministic navigation

// Text match used to find a nav item / search result for a target component
// name. Splits camelCase boundaries then normalizes to lowercase alphanumerics,
// so "DraggableList", "Draggable List" and "draggable-list" all compare equal.
const normText = (s) => String(s || '')
  .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, ' ')
  .trim();

// A change's nav_target may name a few components ("Input and Select"); split
// into individual destinations to try in order.
export function splitTargets(navTarget) {
  return String(navTarget || '')
    .split(/,|\/|&|\+|\band\b/i)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 4);
}

export function scoreNameMatch(name, target) {
  const a = normText(name), b = normText(target);
  if (!a || !b) return 0;
  if (a === b) return 4;
  if (a.startsWith(b) || b.startsWith(a)) return 3;
  if (a.includes(b) || b.includes(a)) return 2;
  const at = new Set(a.split(' '));
  return b.split(' ').some((w) => at.has(w)) ? 1 : 0;
}

// Best clickable nav item / search result for a target, from a snapshot. Skips
// the search box itself and unsafe controls; slightly prefers leaves over group
// headers so "Input" doesn't stop at an "Inputs" group. Requires a real match
// (>= includes), not just a weak shared word.
export function bestNavMatch(items, target) {
  let best = null, bestScore = 1.5;
  for (const it of items) {
    if (it.editable || UNSAFE_ACTION_NAME.test(it.name)) continue;
    let s = scoreNameMatch(it.name, target);
    if (s && it.expanded !== undefined) s -= 0.5; // prefer a leaf over a group header
    if (s > bestScore) { bestScore = s; best = it; }
  }
  return best;
}

// Did we actually land on the target? Generic signals, checked across frames:
// a nav item marked selected/current whose text matches, or a prominent heading
// near the top, or the URL. Works for any catalog that highlights the active
// item (Storybook, the e4 explorebook, most SPAs) without app-specific config.
async function arrivedAtTarget(page, target) {
  for (const frame of page.frames()) {
    try {
      const ok = await frame.evaluate((t) => {
        const norm = (s) => String(s || '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
        const b = norm(t);
        if (!b) return false;
        const SEL = '[aria-current],[aria-selected="true"],[data-selected="true"],.active,.selected,.is-active,.is-selected';
        for (const el of document.querySelectorAll(SEL)) {
          const txt = norm(el.textContent);
          if (!txt) continue;
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0 && (txt === b || txt.includes(b))) return true;
        }
        for (const el of document.querySelectorAll('h1,h2,h3,[role=heading]')) {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.top >= 0 && r.top < 440 && norm(el.textContent).includes(b)) return true;
        }
        return false;
      }, target);
      if (ok) return true;
    } catch { /* cross-origin/detached frame */ }
  }
  try { if (normText(page.url()).includes(normText(target))) return true; } catch { /* bad url */ }
  return false;
}

// Deterministically drive the app to the component/screen named by nav_target,
// BEFORE any vision loop — so reaching the right place doesn't depend on the
// model's discretion. Project-agnostic: (1) type the target into a search/
// filter box and click the best result; (2) failing that, click the matching
// nav item, expanding collapsed groups until it appears. Verified via a generic
// arrival check. Best-effort and bounded: returns {ok:false} to let the caller
// fall back to the vision loop rather than throwing. Safety-gated (never types
// into passwords, never clicks destructive/financial/send controls).
export async function navigateToTarget(page, navTarget, { maxMs = 25_000 } = {}) {
  if (!navTarget) return { ok: false, reason: 'no target' };
  const deadline = Date.now() + maxMs;
  const targets = splitTargets(navTarget);
  const settle = async () => {
    await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});
    await sleep(350);
  };

  // Strategy 1: search-jump.
  for (const t of targets) {
    if (Date.now() > deadline) break;
    const snap = await snapshotInteractives(page);
    const search = snap.find((it) => it.editable && /search|find|filter|jump|command|go to/i.test(it.name))
      || snap.find((it) => it.editable);
    if (!search) break; // no search box anywhere; go straight to nav-drill
    const sloc = refLocator(page, search.ref);
    if (!sloc) continue;
    try {
      await typeIntoField(page, sloc, t);
      await sleep(500); // let results filter
      const hit = bestNavMatch(await snapshotInteractives(page), t);
      if (hit) {
        await refLocator(page, hit.ref).click({ timeout: 6000 });
        await settle();
        if (await arrivedAtTarget(page, t)) return { ok: true, via: 'search', target: t };
      }
      await typeIntoField(page, sloc, '').catch(() => {}); // reset for the next target
      await sleep(200);
    } catch { /* try nav-drill / next target */ }
  }

  // Strategy 2: nav-drill — click the item, expanding collapsed groups to reveal it.
  for (const t of targets) {
    for (let attempt = 0; attempt < 5 && Date.now() < deadline; attempt++) {
      const snap = await snapshotInteractives(page);
      const hit = bestNavMatch(snap, t);
      if (hit) {
        try {
          await refLocator(page, hit.ref).click({ timeout: 6000 });
          await settle();
          if (await arrivedAtTarget(page, t)) return { ok: true, via: 'nav', target: t };
        } catch { /* fall through to expanding */ }
        break;
      }
      const collapsed = snap.filter((it) => it.expanded === false && !UNSAFE_ACTION_NAME.test(it.name));
      if (!collapsed.length) break;
      for (const g of collapsed.slice(0, 6)) {
        try { await refLocator(page, g.ref).click({ timeout: 4000 }); await sleep(200); } catch { /* ignore */ }
      }
    }
  }
  return { ok: false };
}

// Bounded, vision-driven interaction loop. Starting from a landing URL, lets
// the model click/hover/select its way toward the most compelling state
// (branded theme, composed screen, an opened menu…), capturing a frame after
// every step. Returns the single best frame it saw, or null to fall back to
// the plain route/close-up shots. Every failure degrades gracefully; the loop
// is hard-bounded on steps and wall-clock so it can't hang the CI job.
async function browseForBestFrame(ctx, startUrl, { postText, commitMessage, interactionHints, navTarget, stateHint, maxSteps = 5, wallClockMs = 90_000 }, tag = 'x') {
  const page = await ctx.newPage();
  const frames = [];
  const history = [];
  const deadline = Date.now() + wallClockMs;
  try {
    await page.goto(startUrl, { waitUntil: 'networkidle', timeout: 30_000 }).catch(async () => {
      await page.goto(startUrl, { waitUntil: 'load', timeout: 30_000 });
    });

    // tag keeps filenames distinct across concurrent/sequential calls in the
    // same run (e.g. one call per bundled change) so frames can't collide.
    const capture = async (label) => {
      const file = join(tmpdir(), `auto-post-frame-${tag}-${frames.length}.png`);
      await page.screenshot({ path: file, fullPage: false });
      frames.push({ file, label });
    };
    await capture('initial landing');

    // Deterministically get to the target component first (search/nav-drill) so
    // the vision loop only has to refine the state/framing, not find the place.
    if (navTarget) {
      const nav = await navigateToTarget(page, navTarget);
      if (nav.ok) {
        console.log(`Browse: navigated to "${nav.target}" via ${nav.via}.`);
        await capture(`navigated to ${nav.target}`);
      } else {
        console.log(`Browse: could not deterministically navigate to "${navTarget}"; letting the vision loop try.`);
      }
    }

    const hintLine = interactionHints ? `\nOWNER HINTS (prefer these): ${interactionHints}` : '';
    const targetLine = navTarget ? `\nTARGET COMPONENT/SCREEN (navigate here — this is where the change lives): ${navTarget}` : '';
    const stateLine = stateHint ? `\nSTATE TO REACH (the change is only visible in this state): ${stateHint}` : '';

    for (let step = 0; step < maxSteps && Date.now() < deadline; step++) {
      const all = await snapshotInteractives(page);
      const offered = all.filter((it) => !UNSAFE_ACTION_NAME.test(it.name)).slice(0, 42);
      if (!offered.length) break;

      const shot = frames[frames.length - 1];
      let decision;
      try {
        decision = await gemini([
          {
            text: `You are driving a real web page to capture the most compelling screenshot for this social post. Click/hover/select/type on navigational and display controls to reach the state that shows the change. Do NOT submit forms, buy, delete, or send anything.

YOUR GOAL: get to the SPECIFIC component/screen the change is about and show it in the exact state described — do not settle for a generic landing / welcome / "Start" / overview page, which never shows a specific component's change.${targetLine}${stateLine}
- To navigate a component catalog fast: if there's a search/filter box (often "Find components", "Search", ⌘K), TYPE the target component's name into it, then click the matching result — this is more reliable than hunting through nested nav. You may also expand a collapsed nav group (e.g. "Components") and click the item.
- Prefer a shot where the component fills the frame and shows the FULL set of its variants/states together (a "Tones"/"Variants"/"States"/"All"/gallery view) over a single-instance "Playground"/demo, and over one small element on an empty canvas. BUT it has to stay legible at thumbnail size in a feed: if showing the full set shrinks each item to a tiny speck on a big canvas of whitespace, prefer a tighter cluster (a representative handful, zoomed in) where the detail actually reads. A wide catalog/storybook grid where the subject is small amid lots of empty space is a WEAK shot, not a strong one.
- If the change is a focus/open/hover/expanded state (e.g. an accent border on a focused input, an open dropdown), reach it: type into or click the field to focus it, click a select to open it, hover to reveal.

POST DRAFT: ${postText}
COMMIT MESSAGE: ${commitMessage}${hintLine}

ACTIONS SO FAR: ${history.length ? history.join(' | ') : '(none yet)'}

The attached screenshot is the CURRENT state. Interactive elements you may act on (pick by "ref"; "editable":true = a field you can type into):
${offered.map((it) => `- ${it.ref} [${it.role || it.tag}]${it.editable ? ' editable' : ''} "${it.name}"${it.options ? ` options=${JSON.stringify(it.options)}` : ''}`).join('\n')}

If the current state already clearly showcases the change, stop. Otherwise pick ONE action that most advances toward it.
Return ONLY JSON:
{
  "done": boolean,        // true = current state clearly shows the change; stop
  "action": "click" | "hover" | "select" | "type" | null,
  "ref": string | null,   // one of the refs above
  "value": string | null, // "select": option value. "type": the text to enter (e.g. the target component name)
  "reason": string
}`,
          },
          { inline_data: { mime_type: 'image/png', data: readFileSync(shot.file).toString('base64') } },
        ]);
      } catch (err) {
        console.warn(`Browse decision failed (${err.message}); stopping loop.`);
        break;
      }

      if (decision.done || !decision.action || !decision.ref) {
        console.log(`Browse: model stopped — ${decision.reason ?? 'no reason'}`);
        break;
      }
      const picked = offered.find((it) => it.ref === decision.ref);
      if (!picked) { console.warn(`Browse: ref ${decision.ref} not in offered set; stopping.`); break; }

      const loc = refLocator(page, decision.ref);
      if (!loc) { console.warn('Browse: could not resolve ref to a locator; stopping.'); break; }
      try {
        if (decision.action === 'select') {
          await loc.selectOption(decision.value ?? '', { timeout: 8000 });
        } else if (decision.action === 'hover') {
          await loc.hover({ timeout: 8000 });
        } else if (decision.action === 'type') {
          // Focus + replace (no submit); routes around combobox/search wrappers
          // whose real <input> is nested. Caps length; never presses Enter.
          await typeIntoField(page, loc, decision.value);
        } else {
          await loc.click({ timeout: 8000 });
        }
        history.push(`${decision.action} "${picked.name}"${decision.action === 'type' ? ` = "${decision.value ?? ''}"` : ''}`);
        console.log(`Browse step ${step}: ${decision.action} "${picked.name}" — ${decision.reason ?? ''}`);
        await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
        await sleep(500); // let menus/animations/filter results settle
        await capture(`after ${decision.action} "${picked.name}"`);
      } catch (err) {
        console.warn(`Browse action failed (${err.message}); stopping loop.`);
        break;
      }
    }

    if (frames.length <= 1) return null; // never interacted; nothing gained over the route shot

    // Pick the single most compelling frame across everything we saw. Insist on
    // a clean, complete-looking state — reject half-open menus or broken frames.
    let best = frames[frames.length - 1];
    try {
      const pick = await gemini([
        {
          text: `Choose the single most compelling screenshot to attach to this post. Prefer a clean, complete-looking state that clearly shows the change; reject anything that looks half-rendered, mid-transition, or broken. Favor a TIGHT, change-focused frame where the subject fills most of the image and reads clearly at thumbnail size in a feed; down-rank wide catalog/gallery/storybook grids where the subject is small amid lots of empty space. The image's real job is to stop a stranger's scroll and make the post worth replying to or forwarding, so pick the most legible, self-explanatory frame that lands with zero context.

POST DRAFT: ${postText}
COMMIT MESSAGE: ${commitMessage}

Frames in order: ${frames.map((f, i) => `[${i}] ${f.label}`).join(', ')}
Return ONLY JSON: { "best_index": number, "reason": string }`,
        },
        ...frames.map((f) => ({ inline_data: { mime_type: 'image/png', data: readFileSync(f.file).toString('base64') } })),
      ], { maxOutputTokens: 8192 });
      if (Number.isInteger(pick.best_index) && pick.best_index >= 0 && pick.best_index < frames.length) {
        best = frames[pick.best_index];
        console.log(`Browse best frame: [${pick.best_index}] ${best.label} — ${pick.reason ?? ''}`);
      }
    } catch (err) {
      console.warn(`Browse frame pick failed (${err.message}); using the last frame.`);
    }
    return { file: best.file, note: `screenshot of ${startUrl} (${best.label})` };
  } catch (err) {
    console.warn(`Interactive browse failed (${err.message}); falling back to plain screenshots.`);
    return null;
  } finally {
    await page.close().catch(() => {});
  }
}

// Resolves the single best image for ONE bundled change: route shots, an
// element close-up, an optional interactive-browse frame, vision-picked
// across all three, then verified and — on a miss — retried once against
// routes widened from this change's own files (not the whole commit's).
// Mirrors the original single-change pipeline exactly, just parameterized so
// it can run once per item in a batch of several changes from the same push.
// `tag` must be distinct per call in a run (keeps temp filenames from
// colliding across changes). Returns { file, note } or null if every attempt
// failed for THIS change — the caller drops the image but keeps its text
// clause; it's fatal only if every change in the batch fails.
async function resolveChangeImage(ctx, baseUrl, repoRoot, change, shared, tag) {
  const { commitMessage, interactiveShots, interactionHints, browseMaxSteps, browseWallClockMs } = shared;
  const clause = change.clause;
  const candidates = (Array.isArray(change.candidate_paths) && change.candidate_paths.length
    ? change.candidate_paths : ['/'])
    .slice(0, 3)
    .map((p) => (typeof p === 'string' && p.trim() ? p.trim() : '/'));
  const elementHint = (change.element_hint && typeof change.element_hint === 'object') ? change.element_hint : null;
  const navTarget = typeof change.nav_target === 'string' && change.nav_target.trim() ? change.nav_target.trim() : null;
  const stateHint = typeof change.interaction_hint === 'string' && change.interaction_hint.trim() ? change.interaction_hint.trim() : null;

  const shots = await shootRoutes(ctx, baseUrl, candidates, `${tag}-r1`);
  if (!shots.length) {
    console.warn(`Change "${clause}": every candidate screenshot failed; posting without an image for this item.`);
    return null;
  }
  const chosen = await pickBestShot(shots, clause, commitMessage);
  const fallback = { file: chosen.file, note: `screenshot of ${chosen.url}` };

  const pool = [fallback];
  const closeup = await shootElementCloseUp(ctx, chosen.url, elementHint, `${tag}-r1`);
  if (closeup) pool.push({ file: closeup, note: `close-up of the changed component on ${chosen.url}` });
  if (interactiveShots) {
    const framed = await browseForBestFrame(
      ctx, chosen.url,
      { postText: clause, commitMessage, interactionHints, navTarget, stateHint, maxSteps: browseMaxSteps, wallClockMs: browseWallClockMs },
      `${tag}-r1`,
    );
    if (framed) pool.push(framed);
  }

  let imagePath, imageNote;
  if (pool.length === 1) {
    imagePath = fallback.file;
    imageNote = fallback.note;
  } else {
    const best = await pickBestShot(pool.map((p) => ({ ...p, path: p.note, url: p.note })), clause, commitMessage);
    imagePath = best.file;
    imageNote = best.note;
  }

  // Verify the image shows this change. If it doesn't, widen the search once
  // — scoped to this change's own files, not the whole commit's — before
  // falling back to the best full-page shot from the first round.
  if (!(await shotShowsChange(imagePath, clause, commitMessage))) {
    let recovered = false;
    const changeFiles = Array.isArray(change.files) && change.files.length ? change.files : undefined;
    const routeFiles = listRouteFiles(repoRoot);
    if (routeFiles.length) {
      try {
        const tried = new Set(candidates);
        const widened = await gemini([{
          text: `A screenshot for this social post missed the change. Find where the changed UI actually renders.

POST DRAFT: ${clause}
COMMIT MESSAGE: ${commitMessage}
FILES CHANGED: ${JSON.stringify(changeFiles ?? [])}
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
          const shots2 = await shootRoutes(ctx, baseUrl, newPaths, `${tag}-r2`);
          if (shots2.length) {
            const chosen2 = await pickBestShot(shots2, clause, commitMessage);
            const hint2 = (widened.element_hint && typeof widened.element_hint === 'object')
              ? widened.element_hint : elementHint;
            const closeup2 = await shootElementCloseUp(ctx, chosen2.url, hint2, `${tag}-r2`);
            const file2 = closeup2 ?? chosen2.file;
            if (await shotShowsChange(file2, clause, commitMessage)) {
              imagePath = file2;
              imageNote = closeup2
                ? `close-up of the changed component on ${chosen2.url}`
                : `screenshot of ${chosen2.url}`;
              recovered = true;
            }
          }
        }
      } catch (err) {
        console.warn(`Change "${clause}": widened route search failed: ${err.message}`);
      }
    }
    if (!recovered) {
      // Last resort: the plain full-page shot of the best route. Only keep it if
      // it actually shows the change — posting a confirmed-wrong image (e.g. a
      // generic landing page) is worse than posting the line with no image, so
      // drop it and let this change go text-only in that case.
      if (await shotShowsChange(fallback.file, clause, commitMessage)) {
        imagePath = fallback.file;
        imageNote = fallback.note;
      } else {
        console.warn(`Change "${clause}": no shot could be confirmed to show the change; posting this line text-only.`);
        return null;
      }
    }
  }
  return { file: imagePath, note: imageNote };
}

// ---------------------------------------------------------------- interaction video

// Playwright's video recorder does NOT capture the OS cursor, so a recorded
// drag looks like rows moving by themselves. We draw a synthetic pointer in the
// page's top frame and move it in lockstep with page.mouse. Coordinates are
// main-frame viewport pixels (what page.mouse and locator.boundingBox() both
// use), so the overlay lines up even when the real UI is inside an iframe
// (Storybook's preview frame is the motivating case).
const CURSOR_JS = `(() => {
  if (window.__apCursorInstalled) return;
  window.__apCursorInstalled = true;
  const c = document.createElement('div');
  c.id = '__ap_cursor';
  c.style.cssText = 'position:fixed;left:-100px;top:-100px;z-index:2147483647;pointer-events:none;width:26px;height:26px;transform-origin:2px 2px;filter:drop-shadow(0 1px 2px rgba(0,0,0,.35));transition:transform .05s ease-out';
  c.innerHTML = '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M5 2.5l13 6.5-5.4 1.4L9.6 17 5 2.5z" fill="#111827" stroke="#ffffff" stroke-width="1.5" stroke-linejoin="round"/></svg>';
  document.documentElement.appendChild(c);
  // Dragging across text would paint an ugly selection highlight in the
  // recording on any page that doesn't guard it — suppress selection globally
  // (harmless for an unattended screenshotter) so clips stay clean.
  const s = document.createElement('style');
  s.textContent = '*{-webkit-user-select:none!important;user-select:none!important}';
  document.head.appendChild(s);
  window.__apMoveCursor = (x, y) => { c.style.left = x + 'px'; c.style.top = y + 'px'; };
  // Press squish and camera zoom compose into one transform. The cursor lives
  // on <html>, outside the zoomed <body>, so the camera doesn't scale it —
  // __apZoomCursor grows it in step so it reads as part of the zoomed scene.
  let pressed = false, camScale = 1;
  const apply = () => { c.style.transform = 'scale(' + ((pressed ? 0.8 : 1) * camScale) + ')'; };
  window.__apPressCursor = (down) => { pressed = down; c.style.transition = 'transform .05s ease-out'; apply(); };
  window.__apZoomCursor = (s, ms) => { camScale = s; c.style.transition = 'transform ' + (ms || 50) + 'ms cubic-bezier(.22,1,.36,1)'; apply(); };
  // Eased reposition used by the camera so the sprite rides along with the
  // zooming content (it lives on <html>, outside the transformed <body>);
  // restores the instant left/top afterwards so drag tracking stays snappy.
  window.__apGlideCursor = (x, y, ms) => {
    c.style.transition = 'transform ' + ms + 'ms cubic-bezier(.22,1,.36,1), left ' + ms + 'ms cubic-bezier(.22,1,.36,1), top ' + ms + 'ms cubic-bezier(.22,1,.36,1)';
    c.style.left = x + 'px'; c.style.top = y + 'px';
    setTimeout(() => { c.style.transition = 'transform .05s ease-out'; }, ms + 60);
  };
})()`;

export async function ensureCursor(page) {
  try { await page.evaluate(CURSOR_JS); } catch { /* page mid-navigation; retried next call */ }
}

export const boxCenter = (b) => (b ? { x: b.x + b.width / 2, y: b.y + b.height / 2 } : null);

export async function apMove(page, x, y) {
  await page.mouse.move(x, y);
  await page.evaluate(([px, py]) => window.__apMoveCursor && window.__apMoveCursor(px, py), [x, y]).catch(() => {});
}

// Animated, eased drag with the synthetic cursor tracking every step so the
// recording reads as a real hand-drag (press -> move -> settle -> release).
export async function apDrag(page, from, to, { steps = 26, holdMs = 150 } = {}) {
  await ensureCursor(page);
  await apMove(page, from.x, from.y);
  await sleep(220);
  await page.mouse.down();
  await page.evaluate(() => window.__apPressCursor && window.__apPressCursor(true)).catch(() => {});
  await sleep(holdMs);
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; // easeInOutQuad
    await apMove(page, from.x + (to.x - from.x) * e, from.y + (to.y - from.y) * e);
    await sleep(22);
  }
  await sleep(180);
  await page.mouse.up();
  await page.evaluate(() => { window.__apPressCursor && window.__apPressCursor(false); window.getSelection && window.getSelection().removeAllRanges(); }).catch(() => {});
  await sleep(550); // let the drop animation land
}

// ---------------------------------------------------------------- zoom camera
//
// FocuSee-style cinematic camera for recordings: ease-zoom in around the
// showcase interaction, hold, ease back out. Implemented as a CSS transform on
// the top document's <body>, so Playwright's recorder captures it directly —
// no post-processing, and Chromium re-rasterizes at the new scale so the
// punch-in stays pixel-sharp. The synthetic cursor sits on <html> (outside the
// transformed subtree), so its viewport coordinates stay valid while zoomed.
const CAMERA_JS = `(() => {
  if (window.__apCameraInstalled) return;
  window.__apCameraInstalled = true;
  // (fx, fy) is the focus point in viewport px; only ever called from the
  // rest state (scale 1), so body's client rect maps it to local coords.
  window.__apCameraZoom = (fx, fy, dx, dy, s, ms) => {
    const b = document.body; if (!b) return;
    const r = b.getBoundingClientRect();
    b.style.transformOrigin = (fx - r.left) + 'px ' + (fy - r.top) + 'px';
    b.style.transition = 'transform ' + ms + 'ms cubic-bezier(.22,1,.36,1)';
    b.style.transform = 'translate(' + dx + 'px,' + dy + 'px) scale(' + s + ')';
    window.__apZoomCursor && window.__apZoomCursor(s, ms);
  };
  window.__apCameraReset = (ms) => {
    const b = document.body; if (!b) return;
    b.style.transition = 'transform ' + ms + 'ms cubic-bezier(.4,0,.2,1)';
    b.style.transform = 'none';
    window.__apZoomCursor && window.__apZoomCursor(1, ms);
  };
})()`;

// Camera keyframe for a zoom of `scale` focused on `focus` (viewport px).
// Scaling around the focus point never reveals past the content's edges; the
// translate then re-centers the focus toward mid-viewport, clamped per side by
// (scale-1) * distance(focus, that edge) — exactly how far that edge moved
// off-screen — so no out-of-content gap can ever appear. recenter:false keeps
// the focus point exactly where it was (needed to preserve a live :hover — the
// real pointer doesn't move, so the content under it must not either).
export function cameraKeyframe(focus, scale, viewport = { width: 1280, height: 800 }, { recenter = true } = {}) {
  const s = Math.max(1, scale);
  const clampAxis = (want, lo, hi) => Math.max(-(s - 1) * hi, Math.min((s - 1) * lo, want));
  return {
    scale: s,
    fx: focus.x,
    fy: focus.y,
    dx: recenter ? clampAxis(viewport.width / 2 - focus.x, focus.x, viewport.width - focus.x) : 0,
    dy: recenter ? clampAxis(viewport.height / 2 - focus.y, focus.y, viewport.height - focus.y) : 0,
  };
}

// Where a rest-state (scale 1) viewport point lands on screen under a camera
// keyframe — used to glide the cursor sprite (which sits outside the zoomed
// subtree) along with the content it was pointing at.
export function cameraMapPoint(p, k) {
  return { x: k.fx + (p.x - k.fx) * k.scale + k.dx, y: k.fy + (p.y - k.fy) * k.scale + k.dy };
}

// Punch-in scale: the acted element plus breathing room fills the frame, kept
// in a tasteful range so it never gets extreme.
export function zoomScaleForBox(box, vw = 1280, vh = 800) {
  if (!box) return 1.8;
  const s = Math.min(vw / (box.width + 420), vh / (box.height + 320));
  return Math.max(1.35, Math.min(2, s));
}

export async function cameraZoomIn(page, k, { cursor = null, ms = 750 } = {}) {
  await page.evaluate(CAMERA_JS);
  await page.evaluate(([fx, fy, dx, dy, s, m]) => window.__apCameraZoom(fx, fy, dx, dy, s, m), [k.fx, k.fy, k.dx, k.dy, k.scale, ms]);
  if (cursor) {
    const p = cameraMapPoint(cursor, k);
    await page.evaluate(([x, y, m]) => window.__apGlideCursor && window.__apGlideCursor(x, y, m), [p.x, p.y, ms]).catch(() => {});
  }
  await sleep(ms + 150); // let the ease settle
}

export async function cameraReset(page, { cursor = null, ms = 850 } = {}) {
  await page.evaluate((m) => window.__apCameraReset && window.__apCameraReset(m), ms).catch(() => {});
  if (cursor) {
    await page.evaluate(([x, y, m]) => window.__apGlideCursor && window.__apGlideCursor(x, y, m), [cursor.x, cursor.y, ms]).catch(() => {});
  }
  await sleep(ms + 150);
}

// ---------------------------------------------------------------- pan camera
//
// A click-FOLLOWING camera for scripted flows: zoom in on each click, then PAN
// to the next. Unlike the single-punch camera above (which moves
// transform-origin per shot), this pins transform-origin at 0,0 and expresses
// the camera purely as translate()+scale(), so CSS smoothly interpolates a pan
// from one target to the next. Same principle otherwise: transform on <body>,
// cursor on <html> gliding + scaling alongside.
const FLOW_CAMERA_JS = `(() => {
  if (window.__apFlowInstalled) return;
  window.__apFlowInstalled = true;
  document.body.style.transformOrigin = '0 0';
  window.__apFlowPan = (tx, ty, s, ms) => {
    const b = document.body; if (!b) return;
    b.style.transition = 'transform ' + ms + 'ms cubic-bezier(.22,1,.36,1)';
    b.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(' + s + ')';
    window.__apZoomCursor && window.__apZoomCursor(s, ms);
  };
  window.__apFlowReset = (ms) => {
    const b = document.body; if (!b) return;
    b.style.transition = 'transform ' + ms + 'ms cubic-bezier(.4,0,.2,1)';
    b.style.transform = 'none';
    window.__apZoomCursor && window.__apZoomCursor(1, ms);
  };
})()`;

// Pan-camera keyframe (transform-origin 0,0): center rest-space point `restC`
// at `scale`, clamped per axis to [-(s-1)*dim, 0] so a content edge is never
// pulled inside the viewport (an edge target simply punches in softer). A point
// p in rest space then lands on screen at p*s + t — see flowMapPoint.
export function flowKeyframe(restC, scale, viewport = { width: 1280, height: 800 }) {
  const s = Math.max(1, scale);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  return {
    s,
    tx: clamp(viewport.width / 2 - restC.x * s, -(s - 1) * viewport.width, 0),
    ty: clamp(viewport.height / 2 - restC.y * s, -(s - 1) * viewport.height, 0),
  };
}

// On-screen position of a rest-space point under a pan keyframe.
export function flowMapPoint(p, k) {
  return { x: p.x * k.s + k.tx, y: p.y * k.s + k.ty };
}

// Rest-space position of a point currently measured on-screen under keyframe k
// (inverse of flowMapPoint) — lets us convert a freshly measured, possibly
// post-DOM-change element box back to rest space to plan the next pan.
export function flowUnmapPoint(sc, k) {
  return { x: (sc.x - k.tx) / k.s, y: (sc.y - k.ty) / k.s };
}

export const REST_CAMERA = { s: 1, tx: 0, ty: 0 };

export async function panCameraTo(page, k, { cursor = null, ms = 650 } = {}) {
  await page.evaluate(FLOW_CAMERA_JS);
  await page.evaluate(([tx, ty, s, m]) => window.__apFlowPan(tx, ty, s, m), [k.tx, k.ty, k.s, ms]);
  if (cursor) {
    const p = flowMapPoint(cursor, k);
    await page.evaluate(([x, y, m]) => window.__apGlideCursor && window.__apGlideCursor(x, y, m), [p.x, p.y, ms]).catch(() => {});
  }
  await sleep(ms + 180); // let the ease settle before measuring/acting
}

export async function flowCameraReset(page, { ms = 650 } = {}) {
  await page.evaluate((m) => window.__apFlowReset && window.__apFlowReset(m), ms).catch(() => {});
  await sleep(ms + 150);
}

// Like snapshotInteractives, but also offers structural "draggable candidates"
// (list rows, drag handles, sortable items) so the model can pick a drag
// source/target — those are usually plain <li>/<div>s the interactive tagger
// skips. Tagged with the same data-autopost-ref attribute refLocator resolves.
export async function snapshotForRecorder(page) {
  const tagger = (frameIndex) => {
    const INTERACT = 'a,button,select,summary,input:not([type=hidden]),textarea,[contenteditable=""],[contenteditable=true],[role=button],[role=tab],[role=menuitem],[role=menuitemradio],[role=switch],[role=link],[role=option],[role=searchbox],[role=textbox],[aria-haspopup]';
    const DRAG = '[draggable=true],[aria-roledescription*="drag" i],[class*="drag" i],[class*="sortable" i],[class*="handle" i],[role=listitem],[role=row],li';
    const EDITABLE_TYPES = new Set(['text', 'search', 'email', 'url', 'tel', 'number', '']);
    const items = [];
    let i = 0;
    const consider = (el, draggable) => {
      if (el.hasAttribute('data-autopost-ref')) return;
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      const visible = r.width > 2 && r.height > 2 && r.bottom > 0 && r.top < innerHeight
        && r.right > 0 && r.left < innerWidth
        && st.visibility !== 'hidden' && st.display !== 'none' && st.pointerEvents !== 'none';
      if (!visible) return;
      const tag = el.tagName.toLowerCase();
      const type = (el.getAttribute('type') || '').toLowerCase();
      if (tag === 'input' && type === 'password') return; // never type into passwords
      const editable = tag === 'textarea' || el.isContentEditable
        || el.getAttribute('role') === 'searchbox' || el.getAttribute('role') === 'textbox'
        || (tag === 'input' && EDITABLE_TYPES.has(type));
      const name = (el.getAttribute('aria-label') || el.innerText || el.getAttribute('placeholder') || el.value || el.getAttribute('title') || '')
        .trim().replace(/\s+/g, ' ').slice(0, 80);
      if (!name) return;
      el.setAttribute('data-autopost-ref', `${frameIndex}:${i}`);
      const item = { ref: `${frameIndex}:${i}`, tag, role: el.getAttribute('role') || null, name, draggable: !!draggable };
      if (editable) item.editable = true;
      if (el.tagName === 'SELECT') item.options = [...el.options].map((o) => o.value).slice(0, 12);
      items.push(item);
      i++;
    };
    for (const el of document.querySelectorAll(INTERACT)) { if (i >= 60) break; consider(el, false); }
    for (const el of document.querySelectorAll(DRAG)) { if (i >= 90) break; consider(el, true); }
    return items;
  };
  const frames = page.frames();
  const all = [];
  for (let f = 0; f < frames.length; f++) {
    try { all.push(...await frames[f].evaluate(tagger, f)); } catch { /* cross-origin/detached */ }
    if (all.length >= 90) break;
  }
  return all;
}

// Trim [startSec, endSec] out of a Playwright .webm and transcode to an
// X-friendly mp4 (H.264/yuv420p, even dimensions, faststart, no audio).
// Resolves false on any failure — notably when ffmpeg isn't on PATH — so the
// caller can fall back to the still-image pipeline.
export function ffmpegToMp4(inPath, outPath, startSec, endSec) {
  return new Promise((resolve) => {
    const dur = Math.max(0.5, endSec - startSec);
    const args = [
      '-y', '-i', inPath,
      '-ss', startSec.toFixed(2), '-t', dur.toFixed(2),
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2,fps=30',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an',
      outPath,
    ];
    let proc;
    try { proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] }); }
    catch (err) { console.warn(`ffmpeg unavailable: ${err.message}`); return resolve(false); }
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', (err) => { console.warn(`ffmpeg failed to start: ${err.message}`); resolve(false); });
    proc.on('close', (code) => {
      if (code === 0) return resolve(true);
      console.warn(`ffmpeg exited ${code}: ${stderr.slice(-400)}`);
      resolve(false);
    });
  });
}

// Records a short clip of ONE interaction change: a dedicated recording context,
// a bounded vision loop that first navigates to the right screen then performs
// the single showcase interaction (drag/reorder, expand, tab switch, hover
// reveal...) with a synthetic cursor, then trims+transcodes the clip to mp4.
// Returns { type:'video', file, note } or null — on no ffmpeg, a navigation
// miss the final frame can't confirm, or any error — so the caller falls back
// to the still-image pipeline for this change.
async function recordInteractionVideo(browser, baseUrl, change, shared, tag) {
  const { commitMessage, interactionHints, zoomCamera } = shared;
  const clause = change.clause;
  const interactionHint = typeof change.interaction_hint === 'string' ? change.interaction_hint.trim() : '';
  const candidates = (Array.isArray(change.candidate_paths) && change.candidate_paths.length ? change.candidate_paths : ['/'])
    .slice(0, 3).map((p) => (typeof p === 'string' && p.trim() ? p.trim() : '/'));
  const startUrl = new URL(candidates[0], baseUrl).toString();

  const dir = join(tmpdir(), `auto-post-vid-${tag}`);
  mkdirSync(dir, { recursive: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, recordVideo: { dir, size: { width: 1280, height: 800 } } });
  const page = await context.newPage();
  let video = null;
  let captureStart = null;
  let captureEnd = null;
  let finalFrame = null;
  const t0 = Date.now();
  const elapsed = () => (Date.now() - t0) / 1000;
  const history = [];
  const hintLine = interactionHints ? `\nOWNER HINTS: ${interactionHints}` : '';
  const navTarget = typeof change.nav_target === 'string' && change.nav_target.trim() ? change.nav_target.trim() : '';
  const targetLine = navTarget ? `\nTARGET COMPONENT/SCREEN (navigate here — the change lives here): ${navTarget}` : '';

  try {
    await page.goto(startUrl, { waitUntil: 'networkidle', timeout: 30_000 }).catch(async () => {
      await page.goto(startUrl, { waitUntil: 'load', timeout: 30_000 });
    });
    video = page.video();

    // Get to the target component deterministically before the showcase loop
    // (recorded, but trimmed away — the clip keeps only the showcase interaction).
    if (navTarget) {
      const nav = await navigateToTarget(page, navTarget);
      if (nav.ok) console.log(`Recorder: navigated to "${nav.target}" via ${nav.via}.`);
      else console.log(`Recorder: could not deterministically navigate to "${navTarget}"; letting the vision loop try.`);
    }

    const deadline = Date.now() + 90_000;
    for (let step = 0; step < 6 && Date.now() < deadline; step++) {
      await ensureCursor(page);
      const offered = (await snapshotForRecorder(page)).filter((it) => !UNSAFE_ACTION_NAME.test(it.name)).slice(0, 44);
      if (!offered.length) break;

      const frameFile = join(tmpdir(), `auto-post-vidframe-${tag}-${step}.png`);
      await page.screenshot({ path: frameFile, fullPage: false });

      let decision;
      try {
        decision = await gemini([
          {
            text: `You are driving a real web page to make a SHORT SCREEN RECORDING that shows off one UI interaction for a social post. First navigate to the screen where it happens, then perform the SINGLE interaction that best demonstrates the change — e.g. drag a list row to reorder it, expand/collapse a panel, switch a tab, hover to reveal actions. A synthetic cursor is drawn for you; just choose actions. Prefer the interaction with the clearest, most satisfying VISIBLE payoff (something visibly moves, opens, or updates) that a stranger would want to reply to or send a friend: a clip only earns X's "quality view" credit past ~10 seconds and the per-view weight is tiny, so the point is a result worth talking about, not motion for its own sake. Avoid a subtle change that reads as nothing happening.

Get to the SPECIFIC component/screen the change is about — do NOT settle for a generic landing / welcome / "Start" / overview page. To reach a component in a catalog fast: if there's a search/filter box (often "Find components", "Search", ⌘K), use action "type" to enter the target name, then click the matching result; or expand a collapsed nav group (e.g. "Components") and click the item.${targetLine}

POST DRAFT: ${clause}
INTERACTION TO SHOW: ${interactionHint || '(infer from the draft + commit)'}
COMMIT MESSAGE: ${commitMessage}${hintLine}

ACTIONS SO FAR: ${history.length ? history.join(' | ') : '(none yet)'}

The attached screenshot is the CURRENT state. Elements you may act on (pick by "ref"; "draggable":true = a row/handle you can drag; "editable":true = a field you can type into):
${offered.map((it) => `- ${it.ref} [${it.role || it.tag}]${it.draggable ? ' draggable' : ''}${it.editable ? ' editable' : ''} "${it.name}"${it.options ? ` options=${JSON.stringify(it.options)}` : ''}`).join('\n')}

Rules: navigation actions (click/type/hover/select) to get there; then ONE showcase interaction. Never submit forms, buy, delete, or send anything. Set "is_capture": true ONLY on the single showcase-interaction step, never on a navigation step (typing into a search box is navigation, not the showcase). Once the showcase interaction is done, stop with "done": true.
Return ONLY JSON:
{
  "done": boolean,
  "action": "drag" | "click" | "hover" | "select" | "type" | null,
  "ref": string | null,       // source element
  "to_ref": string | null,    // drag target element (drag only; the row to drop onto/past)
  "dy": number | null,        // fallback drag distance in px if no to_ref (positive = down)
  "value": string | null,     // "select": option value. "type": the text to enter (e.g. target component name)
  "is_capture": boolean,      // true only on the showcase interaction
  "reason": string
}`,
          },
          { inline_data: { mime_type: 'image/png', data: readFileSync(frameFile).toString('base64') } },
        ]);
      } catch (err) {
        console.warn(`Recorder decision failed (${err.message}); stopping.`);
        break;
      }

      if (decision.done || !decision.action || !decision.ref) {
        console.log(`Recorder: model stopped — ${decision.reason ?? 'no reason'}`);
        break;
      }
      const picked = offered.find((it) => it.ref === decision.ref);
      const src = refLocator(page, decision.ref);
      if (!picked || !src) { console.warn(`Recorder: ref ${decision.ref} unusable; stopping.`); break; }

      const isCapture = decision.is_capture === true;
      if (isCapture && captureStart === null) captureStart = elapsed();
      // On the showcase step the camera punches in right after the action, so
      // keep the post-action settle short — the zoom-in should follow the click
      // by a beat, not a full second, and it eases in AS the state finishes
      // settling (the FocuSee feel). Navigation steps keep the longer settle so
      // the next screenshot the vision loop sees is stable.
      const settleMs = isCapture ? 160 : 600;
      let cursorAt = null; // where the synthetic cursor ends up, for the camera
      try {
        if (decision.action === 'drag') {
          const from = boxCenter(await src.boundingBox());
          if (!from) { console.warn('Recorder: drag source has no box; stopping.'); break; }
          let to = null;
          if (decision.to_ref) {
            const dst = refLocator(page, decision.to_ref);
            if (dst) to = boxCenter(await dst.boundingBox().catch(() => null));
          }
          if (!to) to = { x: from.x, y: from.y + (Number.isFinite(decision.dy) && decision.dy ? decision.dy : 140) };
          await apDrag(page, from, to);
          cursorAt = to;
        } else if (decision.action === 'hover') {
          const b = boxCenter(await src.boundingBox());
          if (b) await apMove(page, b.x, b.y);
          await src.hover({ timeout: 8000 });
          await sleep(isCapture ? 220 : 700);
          cursorAt = b;
        } else if (decision.action === 'select') {
          await src.selectOption(decision.value ?? '', { timeout: 8000 });
          await sleep(settleMs);
        } else if (decision.action === 'type') {
          const b = boxCenter(await src.boundingBox());
          if (b) { await apMove(page, b.x, b.y); await sleep(120); }
          await typeIntoField(page, src, decision.value); // focuses + fills, no submit; handles combobox wrappers
          await sleep(settleMs);
          cursorAt = b;
        } else {
          const b = boxCenter(await src.boundingBox());
          if (b) { await apMove(page, b.x, b.y); await sleep(150); }
          await src.click({ timeout: 8000 });
          await sleep(settleMs);
          cursorAt = b;
        }
        history.push(`${decision.action} "${picked.name}"${decision.action === 'type' ? ` = "${decision.value ?? ''}"` : ''}`);
        console.log(`Recorder step ${step}: ${decision.action} "${picked.name}"${isCapture ? ' [capture]' : ''} — ${decision.reason ?? ''}`);
        // The showcase interaction is terminal, so don't let a settling network
        // gate the punch-in — zoom promptly. Navigation steps still wait so the
        // loop's next screenshot is stable.
        if (!isCapture) await page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => {});
      } catch (err) {
        console.warn(`Recorder action failed (${err.message}); stopping.`);
        break;
      }

      // Cinematic camera on the showcase step: the interaction ran at 1x with
      // the page completely untouched (acting while CSS-scaled breaks drag
      // libraries and rect-positioned popovers) — now ease-zoom into where it
      // happened, hold on the result, ease back out. Presentational only:
      // any trouble resets the camera and the clip is simply un-zoomed.
      if (isCapture && zoomCamera) {
        try {
          const box = await src.boundingBox().catch(() => null); // re-measured: the element in its post-action state/slot
          const focus = boxCenter(box) || cursorAt;
          if (focus) {
            // A hover reveal only survives if the point under the real (unmoved)
            // pointer stays put — zoom around it and skip the re-centering.
            const k = cameraKeyframe(focus, zoomScaleForBox(box), undefined, { recenter: decision.action !== 'hover' });
            await cameraZoomIn(page, k, { cursor: cursorAt });
            await sleep(1300);
            await cameraReset(page, { cursor: cursorAt });
            console.log(`Recorder: camera punch-in at ${k.scale.toFixed(2)}x.`);
          }
        } catch (err) {
          console.warn(`Recorder: zoom camera failed (${err.message}); clip stays un-zoomed.`);
          await cameraReset(page, { ms: 250 }).catch(() => {});
        }
      }
      if (isCapture) captureEnd = elapsed();
    }

    await sleep(400);
    finalFrame = join(tmpdir(), `auto-post-vidfinal-${tag}.png`);
    await page.screenshot({ path: finalFrame, fullPage: false }).catch(() => { finalFrame = null; });
  } finally {
    // Closing the context finalizes the .webm; grab its path afterwards.
    await page.close().catch(() => {});
    await context.close().catch(() => {});
  }

  const totalDur = elapsed();
  let webm = null;
  try { webm = video ? await video.path() : null; } catch { webm = null; }
  if (!webm || !existsSync(webm)) {
    console.warn(`Recorder: no clip produced for "${clause}".`);
    return null;
  }
  if (captureStart === null) {
    // The model never flagged a showcase step (e.g. couldn't reach the screen).
    // Don't ship a video of aimless navigation — fall back to a still.
    console.warn(`Recorder: no showcase interaction captured for "${clause}"; falling back to image.`);
    return null;
  }

  const mp4 = join(tmpdir(), `auto-post-video-${tag}.mp4`);
  const trimStart = Math.max(0, captureStart - 0.6);
  const trimEnd = Math.min(totalDur, (captureEnd ?? totalDur) + 0.8);
  const ok = await ffmpegToMp4(webm, mp4, trimStart, trimEnd);
  if (!ok || !existsSync(mp4)) {
    console.warn(`Recorder: mp4 conversion failed for "${clause}"; falling back to image.`);
    return null;
  }
  // Guard the original failure mode: if the final frame doesn't actually show
  // the change (e.g. we recorded a drag on the wrong screen), don't post it.
  if (finalFrame && !(await shotShowsChange(finalFrame, clause, commitMessage))) {
    console.warn(`Recorder: final frame doesn't show the change for "${clause}"; falling back to image.`);
    return null;
  }
  console.log(`Recorder: captured ${(trimEnd - trimStart).toFixed(1)}s clip for "${clause}".`);
  return { type: 'video', file: mp4, note: `screen recording of the interaction on ${startUrl}` };
}

// ---------------------------------------------------------------- scripted flows
//
// An owner defines a named flow in natural language (config.json "flows"); the
// recorder walks its steps, Gemini resolving each step to one element action,
// and the click-following pan camera punches in on every click and pans to the
// next — the productized version of the hand-built multi-click zoom-follow.
// Fail-open: any trouble returns null and the caller falls back to the
// autonomous recorder, then to a still.

// Tiny glob matcher for flow.match.paths: supports ** (any depth) and * (one
// segment). Enough to target a change's files without a dependency.
export function globMatch(glob, path) {
  const re = new RegExp('^' + String(glob)
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, ' ')
    .replace(/\*/g, '[^/]*')
    .replace(/ /g, '.*') + '$');
  return re.test(String(path));
}

// Choose a flow for a video-capture change: by navTarget substring or file
// globs. A criteria-less flow is eligible only when it is the sole flow.
export function pickFlow(flows, change) {
  const usable = (Array.isArray(flows) ? flows : []).filter((f) => f && Array.isArray(f.steps) && f.steps.length);
  if (!usable.length) return null;
  const navTarget = (typeof change?.nav_target === 'string' ? change.nav_target : '').toLowerCase();
  const files = Array.isArray(change?.files) ? change.files : [];
  const hasCriteria = (m) => m && ((typeof m.navTarget === 'string' && m.navTarget.trim()) || (Array.isArray(m.paths) && m.paths.length));
  const matches = (f) => {
    const m = f.match || {};
    if (!hasCriteria(m)) return false;
    const byNav = typeof m.navTarget === 'string' && m.navTarget.trim() && navTarget.includes(m.navTarget.trim().toLowerCase());
    const byPath = Array.isArray(m.paths) && m.paths.some((g) => files.some((fp) => globMatch(g, fp)));
    return !!(byNav || byPath);
  };
  const explicit = usable.find(matches);
  if (explicit) return explicit;
  const criteriaLess = usable.filter((f) => !hasCriteria(f.match));
  return usable.length === 1 && criteriaLess.length === 1 ? criteriaLess[0] : null;
}

// Default step resolver: Gemini executes ONE scripted step. Narrow prompt (vs.
// the open-ended "pick a showcase" loop) so it reliably does what was scripted.
async function geminiResolveStep({ stepText, screenshotPath, elements, history, payoff }) {
  const list = elements.map((it) => `- ${it.ref} [${it.role || it.tag}]${it.draggable ? ' draggable' : ''}${it.editable ? ' editable' : ''} "${it.name}"${it.options ? ` options=${JSON.stringify(it.options)}` : ''}`).join('\n');
  const prompt = payoff
    ? `You are finishing a scripted product-flow screen recording. The camera should punch in on the RESULT/payoff of the flow (e.g. the score, the confirmation message, the changed value). Return a SHORT, distinctive VISIBLE TEXT snippet from that result region so it can be located on the page (e.g. "/ 100", "weak", "Saved", the number). Prefer something in the result, not a button.
GOAL: ${stepText}
The attached screenshot is the current state.
Return ONLY JSON: { "text": string|null, "reason": string }`
    : `You are executing ONE step of a scripted product-flow screen recording. Perform exactly the step below and nothing else. A synthetic cursor is drawn for you.
STEP: ${stepText}
DONE SO FAR: ${history.length ? history.join(' | ') : '(none)'}

The attached screenshot is the CURRENT state. Elements you may act on (pick by "ref"; "editable":true = a field you can type into; "draggable":true = a row you can drag):
${list}

Rules: choose the ONE action that carries out this step. "type" fills a field (never submits). "press" sends a key (use for "press enter"/"score it"/"submit" style steps; set "key":"Enter"). Never buy, delete, or send anything. If the step is already satisfied or impossible, set "done":true.
Return ONLY JSON:
{ "action": "click"|"type"|"select"|"hover"|"drag"|"press"|null, "ref": string|null, "value": string|null, "key": string|null, "done": boolean, "reason": string }`;
  return gemini([{ text: prompt }, { inline_data: { mime_type: 'image/png', data: readFileSync(screenshotPath).toString('base64') } }]);
}

// Records a scripted flow. resolveStep is injectable (Gemini-backed by default;
// tests pass a deterministic resolver). Returns { type:'video', file, note } or
// null on any failure so the caller can fall back.
export async function recordScriptedFlow(browser, baseUrl, flow, shared, tag, { resolveStep = geminiResolveStep } = {}) {
  const zoomCamera = shared.zoomCamera !== false;
  const steps = flow.steps.map((s) => (typeof s === 'string' ? s.trim() : '')).filter(Boolean);
  if (!steps.length) return null;
  const startUrl = new URL(flow.url || '/', baseUrl).toString();

  const dir = join(tmpdir(), `auto-post-flow-${tag}`);
  mkdirSync(dir, { recursive: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, recordVideo: { dir, size: { width: 1280, height: 800 } } });
  const page = await context.newPage();
  let video = null;
  let cam = REST_CAMERA;
  let captureStart = null;
  let acted = 0;
  const history = [];
  const t0 = Date.now();
  const elapsed = () => (Date.now() - t0) / 1000;

  // Raw-mouse click at a screen point with the cursor press animation — used
  // while zoomed, where the target's on-screen box was measured moments ago.
  const pressClickAt = async (p) => {
    await apMove(page, p.x, p.y);
    await sleep(120);
    await page.mouse.down();
    await page.evaluate(() => window.__apPressCursor && window.__apPressCursor(true)).catch(() => {});
    await sleep(110);
    await page.mouse.up();
    await page.evaluate(() => window.__apPressCursor && window.__apPressCursor(false)).catch(() => {});
    await sleep(360);
  };
  // Zoom-follow to a located element and return its settled on-screen center.
  const zoomToTarget = async (loc) => {
    const box = await loc.boundingBox();
    if (!box) return null;
    const scCenter = boxCenter(box);
    if (!zoomCamera) return scCenter; // flat: no camera, click where it is
    const restC = flowUnmapPoint(scCenter, cam);
    const restBox = { width: box.width / cam.s, height: box.height / cam.s };
    const k = flowKeyframe(restC, zoomScaleForBox(restBox));
    await panCameraTo(page, k, { cursor: restC });
    cam = k;
    const b2 = await loc.boundingBox();
    return b2 ? boxCenter(b2) : flowMapPoint(restC, k);
  };

  // snapshotForRecorder skips already-tagged elements (it's built to run once
  // per page state); across flow steps the same controls persist, so clear the
  // tags first and let it re-tag the full current DOM every step.
  const freshSnapshot = async () => {
    await page.evaluate(() => document.querySelectorAll('[data-autopost-ref]').forEach((e) => e.removeAttribute('data-autopost-ref'))).catch(() => {});
    return (await snapshotForRecorder(page)).filter((it) => !UNSAFE_ACTION_NAME.test(it.name)).slice(0, 44);
  };

  try {
    await page.goto(startUrl, { waitUntil: 'networkidle', timeout: 30_000 }).catch(async () => {
      await page.goto(startUrl, { waitUntil: 'load', timeout: 30_000 });
    });
    video = page.video();
    await ensureCursor(page);
    await page.evaluate(FLOW_CAMERA_JS);
    await sleep(500);
    captureStart = elapsed();

    for (let i = 0; i < steps.length; i++) {
      await ensureCursor(page);
      const offered = await freshSnapshot();
      const shot = join(tmpdir(), `auto-post-flowframe-${tag}-${i}.png`);
      await page.screenshot({ path: shot, fullPage: false });

      let decision;
      try {
        decision = await resolveStep({ stepText: steps[i], screenshotPath: shot, elements: offered, history, index: i });
      } catch (err) {
        console.warn(`Flow "${flow.name}": step ${i} resolver failed (${err.message}); stopping.`);
        break;
      }
      if (!decision || decision.done) { console.log(`Flow "${flow.name}": step ${i} done/skip — ${decision?.reason ?? ''}`); continue; }

      const action = decision.action;
      try {
        if (action === 'press') {
          await page.keyboard.press(decision.key || 'Enter');
          await sleep(500);
        } else {
          const loc = decision.ref ? refLocator(page, decision.ref) : null;
          const picked = offered.find((it) => it.ref === decision.ref);
          if (!loc || !picked) { console.warn(`Flow "${flow.name}": step ${i} ref ${decision.ref} unusable; stopping.`); break; }
          if (action === 'type') {
            if (zoomCamera && cam !== REST_CAMERA) { await flowCameraReset(page); cam = REST_CAMERA; }
            const b = boxCenter(await loc.boundingBox().catch(() => null));
            if (b) { await apMove(page, b.x, b.y); await sleep(120); }
            await typeIntoField(page, loc, decision.value);
            await sleep(400);
          } else if (action === 'select') {
            const at = await zoomToTarget(loc);
            if (at) { await apMove(page, at.x, at.y); await sleep(120); }
            await loc.selectOption(decision.value ?? '', { timeout: 8000 });
            await sleep(400);
          } else if (action === 'hover') {
            const at = await zoomToTarget(loc);
            if (at) await apMove(page, at.x, at.y);
            await loc.hover({ timeout: 8000 }).catch(() => {});
            await sleep(600);
          } else if (action === 'drag') {
            if (zoomCamera && cam !== REST_CAMERA) { await flowCameraReset(page); cam = REST_CAMERA; }
            const from = boxCenter(await loc.boundingBox());
            if (from) await apDrag(page, from, { x: from.x, y: from.y + 140 });
          } else { // click / toggle
            const at = await zoomToTarget(loc);
            if (!at) { console.warn(`Flow "${flow.name}": step ${i} target has no box; stopping.`); break; }
            await pressClickAt(at);
          }
          history.push(`${action} "${picked.name}"${action === 'type' ? ` = "${decision.value ?? ''}"` : ''}`);
        }
        acted++;
        console.log(`Flow "${flow.name}" step ${i}: ${action} — ${decision.reason ?? ''}`);
        await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});
      } catch (err) {
        console.warn(`Flow "${flow.name}": step ${i} action failed (${err.message}); stopping.`);
        break;
      }
    }

    // Optional payoff punch-in on the flow's result, then ease out. The result
    // (a score, a confirmation) is usually NON-interactive, so the resolver
    // returns a visible text snippet to locate rather than an element ref.
    if (acted > 0) {
      let payoffText = null;
      if (zoomCamera && flow.payoff) {
        // The result (score, confirmation) often renders async after the last
        // step — let it settle before the resolver looks, or it'll describe an
        // empty state.
        await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => {});
        await sleep(1500);
        await ensureCursor(page);
        const offered = await freshSnapshot();
        const shot = join(tmpdir(), `auto-post-flowpayoff-${tag}.png`);
        await page.screenshot({ path: shot, fullPage: false });
        try {
          const d = await resolveStep({ stepText: flow.payoff, screenshotPath: shot, elements: offered, history, payoff: true });
          payoffText = d && typeof d.text === 'string' && d.text.trim() ? d.text.trim() : null;
        } catch { /* skip payoff on resolver trouble */ }
      }
      if (zoomCamera && payoffText) {
        // Give the located text a moment to actually be in the DOM.
        await page.waitForFunction((q) => document.body.innerText.toLowerCase().includes(q), payoffText.toLowerCase(), { timeout: 4000 }).catch(() => {});
        const box = await page.evaluate((txt) => {
          const q = txt.toLowerCase();
          const leaves = [...document.querySelectorAll('*')].filter((e) => !e.children.length && (e.textContent || '').toLowerCase().includes(q));
          if (!leaves.length) return null;
          leaves.sort((a, b) => (a.textContent.length - b.textContent.length)); // most specific match
          const r = leaves[0].getBoundingClientRect();
          return r.width > 2 && r.height > 2 ? { x: r.x, y: r.y, width: r.width, height: r.height } : null;
        }, payoffText);
        if (box) {
          const restC = flowUnmapPoint(boxCenter(box), cam);
          const k = flowKeyframe(restC, 1.6); // fixed, gentle payoff zoom framing the result + its surroundings
          await panCameraTo(page, k, { cursor: restC });
          cam = k;
          await sleep(1600);
        }
      }
      if (zoomCamera && cam !== REST_CAMERA) await flowCameraReset(page);
    }
    await sleep(300);
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
  }

  const totalDur = elapsed();
  let webm = null;
  try { webm = video ? await video.path() : null; } catch { webm = null; }
  if (!webm || !existsSync(webm) || acted === 0 || captureStart === null) {
    console.warn(`Flow "${flow.name}": nothing usable recorded; falling back.`);
    return null;
  }
  const mp4 = join(tmpdir(), `auto-post-flow-${tag}.mp4`);
  const ok = await ffmpegToMp4(webm, mp4, Math.max(0, captureStart - 0.4), totalDur);
  if (!ok || !existsSync(mp4)) {
    console.warn(`Flow "${flow.name}": mp4 conversion failed; falling back.`);
    return null;
  }
  console.log(`Flow "${flow.name}": recorded ${acted} step(s), ${(totalDur - captureStart).toFixed(1)}s.`);
  return { type: 'video', file: mp4, note: `screen recording of the "${flow.name}" flow on ${startUrl}` };
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

// Post-scorer loaders. Two tiers, both loaded lazily and relative to this file:
//   • FREE  @e4/post-scorer      — deterministic score + subscores + named
//                                  issues (the diagnosis). Always run when found.
//   • PRO   @e4/post-scorer-pro  — written fixes + the auto-optimizer. Gated by
//                                  a license key (POST_SCORER_LICENSE_KEY).
// Each resolves in both distribution modes: referenced (packages live beside the
// action in the checked-out repo) and vendored (install.sh drops the free core
// into ./scorer/; the paid ./scorer-pro/ is installed by subscribers). Because
// the packages ship inside the same tag as this action, moving the v1 tag pushes
// scorer improvements to referenced-mode consumers automatically. All failures
// are soft: a missing package just means that tier is skipped and the validated
// editor+publish path runs unchanged.
async function tryImport(relPaths) {
  for (const rel of relPaths) {
    try {
      return await import(new URL(rel, import.meta.url));
    } catch { /* try next candidate */ }
  }
  return null;
}
const loadScorerFree = () => tryImport(['../../packages/scorer/src/index.mjs', './scorer/src/index.mjs']);
const loadScorerPro = () => tryImport(['../../packages/scorer-pro/src/index.mjs', './scorer-pro/src/index.mjs']);

async function main() {
  const {
    GITHUB_TOKEN,
    GITHUB_REPOSITORY,
    GITHUB_SHA,
    GITHUB_BEFORE_SHA,
    GITHUB_SERVER_URL,
    HOMEPAGE_URL,
    GEMINI_API_KEY,
    X_API_KEY,
    X_API_SECRET,
    X_ACCESS_TOKEN,
    X_ACCESS_TOKEN_SECRET,
    // Scheduling queue (optional). When both are set, a `defer` decision
    // enqueues the fully-prepared post (text + already-uploaded X media_ids)
    // to the Worker for firing at run_at. When absent, `defer` degrades to
    // an immediate post with a warning — safe for repos that haven't wired
    // up the queue yet.
    WORKER_URL,
    WORKER_ENQUEUE_TOKEN,
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

  // Score-optimize: after the editor pass, score the draft against X's ranking
  // model (via packages/scorer) and, if it's below target, iterate it higher
  // while staying inside the voice rules. On by default; additive and skippable
  // (turns off with OPTIMIZE_POST=false, and self-skips if the scorer or LLM is
  // unavailable). Target is the 0–100 score to stop at; iterations caps rewrites.
  const OPTIMIZE_POST = envBool('OPTIMIZE_POST', config.optimizePost ?? true);
  const OPTIMIZE_TARGET = Number.parseInt(process.env.OPTIMIZE_TARGET || config.optimizeTarget || '80', 10) || 80;
  const OPTIMIZE_ITERATIONS = Math.max(0, Math.min(4, Number.parseInt(
    process.env.OPTIMIZE_ITERATIONS || config.optimizeIterations || '2', 10,
  ) || 2));
  // License key for the paid optimizer (@e4/post-scorer-pro). Absent = free tier:
  // the draft is still scored and its weak spots logged, but not auto-optimized.
  const SCORER_LICENSE_KEY = process.env.POST_SCORER_LICENSE_KEY || config.postScorerLicenseKey || '';

  let routes = Array.isArray(config.routes) ? config.routes : undefined;
  if (process.env.ROUTES && process.env.ROUTES.trim()) {
    try {
      const parsed = JSON.parse(process.env.ROUTES);
      if (Array.isArray(parsed)) routes = parsed;
    } catch {
      console.warn('ROUTES env is not valid JSON; ignoring.');
    }
  }

  // Interactive browse: let the screenshotter click/hover/select its way to a
  // more compelling state before shooting (on by default; falls back to plain
  // route screenshots on any trouble). interactionHints is optional free text
  // steering it, e.g. "prefer a branded theme and composed example screens".
  const INTERACTIVE_SHOTS = envBool('INTERACTIVE_SHOTS', config.interactiveShots ?? true);
  const interactionHints = (process.env.INTERACTION_HINTS && process.env.INTERACTION_HINTS.trim())
    || (typeof config.interactionHints === 'string' ? config.interactionHints.trim() : '')
    || '';

  // Interaction videos: when a change is fundamentally an interaction/motion
  // (drag/reorder, expand, tab switch, hover reveal…), record a short clip of
  // the actual interaction instead of a still (on by default; needs ffmpeg on
  // PATH — present on GitHub-hosted runners — else it falls back to a still).
  // Also requires interactive shots (both drive the page). Its own kill-switch
  // so video can be disabled without turning off the validated interactive stills.
  const INTERACTION_VIDEOS = envBool('INTERACTION_VIDEOS', config.interactionVideos ?? true);

  // Zoom camera: FocuSee-style ease-zoom in/out around the showcase
  // interaction in recorded clips (on by default). Purely presentational —
  // off, recordings behave exactly as before.
  const ZOOM_CAMERA = envBool('ZOOM_CAMERA', config.zoomCamera ?? true);

  // Scripted flows: owner-defined, natural-language product flows (config.json
  // "flows"). A video-capture change matching a flow (by navTarget/paths) is
  // recorded by walking the flow's steps with Gemini + the click-following
  // camera, instead of the vision loop picking one interaction. Empty by
  // default — no flows means the autonomous recorder is used, unchanged.
  const FLOWS = Array.isArray(config.flows) ? config.flows : [];

  // A push can bundle several distinct changes (one feature at a time is the
  // common case and still gets exactly one image); this caps how many get
  // their own image, hard-limited to 4 — X's own max images per post.
  const MAX_BUNDLE_IMAGES = Math.max(1, Math.min(4, Number.parseInt(
    process.env.MAX_BUNDLE_IMAGES || config.maxBundleImages || '4', 10,
  ) || 4));

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
  let files = (commit.files ?? []).slice(0, 25).map((f) => ({
    filename: f.filename,
    status: f.status,
    additions: f.additions,
    deletions: f.deletions,
    patch: typeof f.patch === 'string' ? f.patch.slice(0, 1500) : undefined,
  }));

  // A merge commit's diff above (vs its first parent, per the single-commit
  // endpoint) reflects whichever side WASN'T already on the branch — e.g. a
  // push rejected for being behind, then resolved with `git pull` (merge, not
  // rebase), makes the diff show the REMOTE's commit, not the local work
  // being pushed (the local work is already "in" the first parent, so it
  // contributes no visible diff there). When we know the branch tip before
  // this push (BEFORE_SHA, from the push event's github.event.before),
  // compare before...after instead — the true net diff of the push,
  // regardless of merges or how many commits it bundles. Falls back to the
  // single-commit diff above when unavailable (e.g. workflow_dispatch
  // backfill has no "before").
  let pushCommits = [];
  const validBeforeSha = GITHUB_BEFORE_SHA && !/^0+$/.test(GITHUB_BEFORE_SHA);
  if (validBeforeSha) {
    try {
      const cmpRes = await fetch(
        `https://api.github.com/repos/${GITHUB_REPOSITORY}/compare/${GITHUB_BEFORE_SHA}...${GITHUB_SHA}`,
        { headers: ghHeaders },
      );
      if (cmpRes.ok) {
        const cmp = await cmpRes.json();
        if (Array.isArray(cmp.files) && cmp.files.length) {
          files = cmp.files.slice(0, 25).map((f) => ({
            filename: f.filename,
            status: f.status,
            additions: f.additions,
            deletions: f.deletions,
            patch: typeof f.patch === 'string' ? f.patch.slice(0, 1500) : undefined,
          }));
        }
        pushCommits = (cmp.commits ?? [])
          .map((c) => (c.commit?.message ?? '').split('\n')[0])
          .filter(Boolean);
      }
    } catch (err) {
      console.warn(`Compare fetch failed: ${err.message}`);
    }
  }

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
  const pushBlock = pushCommits.length
    ? `\nCOMMITS ACTUALLY INCLUDED IN THIS PUSH (a push can bundle multiple commits — e.g. a routine merge — so this list plus the diff above is the ground truth for what changed; the single "Message" above may just be a generic "Merge branch..." message with no real content, ignore it if so):\n${pushCommits.map((s) => `- ${s}`).join('\n')}\n`
    : '';
  const recentBlock = recentSubjects.length
    ? `\nRECENT COMMITS, oldest first (the arc of work — mine these for why this change matters):\n${recentSubjects.map((s) => `- ${s}`).join('\n')}\n`
    : '';

  const history = loadHistory(HISTORY_PATH);

  // Stable "what this project is" blurb so every post orients a first-time
  // reader (owner-authored, else auto-derived from repo/README). Best-effort:
  // '' just reproduces the old behavior.
  const projectContext = await resolveProjectContext({ config, repo: GITHUB_REPOSITORY, ghHeaders });
  console.log(`Project context: ${projectContext ? projectContext.slice(0, 120) : '(none)'}`);
  const projectContextBlock = projectContext
    ? `- What this project is: ${projectContext}\n  Use this to orient a reader who has never seen the project so each post makes sense on its own. Let it inform natural phrasing, do NOT paste it in verbatim or prefix a post with "In <project>...".\n`
    : '';

  // ---- 2. segment into 1-4 distinct changes + draft each ----

  const routesHint = Array.isArray(routes) && routes.length
    ? `\n- Known routes in this app: ${JSON.stringify(routes)}`
    : '';
  const wantRoutes = !USE_COVER;

  const draftPlan = await gemini([{
    text: `${VOICE}

You are writing a short social post about the change(s) below. Most pushes are
ONE coherent change — return exactly one item for those, even if it touches
many files; do not artificially split a single feature into pieces. Some
pushes genuinely bundle a few distinct, separately-noticeable changes to the
same area (the common case when someone works on one thing, notices a few
other things nearby, and fixes those too in the same push) — for those, return
one item per distinct change, ordered most user-facing first. Cap at
${MAX_BUNDLE_IMAGES}; if there are more, keep the ${MAX_BUNDLE_IMAGES} most
user-visible and fold anything minor into the nearest relevant item instead of
giving it its own.

PROJECT
- Repo: ${GITHUB_REPOSITORY}${routesHint}
${projectContextBlock}${USE_COVER ? '- Image: a static cover image already chosen by the project owner will be attached (same image regardless of how many changes are found).' : '- A screenshot — or, for an interaction/motion change, a short screen recording — of the app will be captured per change; you choose which routes to try for each and mark which changes are interactions (capture: "video").'}

COMMIT
- Message: ${commitMessage}
- Author: ${author}
- Files changed (truncated):
${JSON.stringify(files, null, 2)}
${pushBlock}${prBlock}${recentBlock}
TASK
Return ONLY a JSON object matching this exact schema (no prose):
{
  "changes": [
    {
      "clause": string,           // this ONE change's post line, following the voice rules above
      "files": string[]${wantRoutes ? ',' : ''}  // subset of "Files changed" that this specific change corresponds to
${wantRoutes ? `      "candidate_paths": string[],  // 1 to 3 URL paths most likely to visually showcase THIS change,
                                     // ordered best-guess first. Use "/" if unsure.
                                     // Examples: ["/", "/pricing", "/props/today"]
                                     // PREFER a route/view that shows the FULL set of the changed
                                     // component's variants/states/tones together (e.g. a "Tones",
                                     // "Variants", "States", "All", or gallery story) over a single-instance
                                     // "Playground"/demo — it shows the change across every option AND fills
                                     // the frame instead of one small element on an empty canvas.
      "nav_target": string | null,   // the name of the specific component/screen to open to SEE this change
                                     // (e.g. "Input", "Select", "Badge"). Many catalogs are navigated by
                                     // clicking a sidebar/search, NOT by URL, so this names the destination for
                                     // the screenshotter to reach (via the catalog's search box or nav). Null
                                     // if the change is on the default/landing view itself.
      "element_hint": {              // the element to zoom the shot into — the GROUP that contains ALL the
                                     // changed component's instances/variants (so the crop captures the whole
                                     // set), not one instance. Null when no single region wraps the change.
        "text": string | null,       // short distinguishing text rendered inside that region, as a user sees it
        "selector": string | null    // a CSS selector for it if the diff makes one obvious, else null
      } | null,                      // null when no single region visibly wraps the change
      "capture": "image" | "video",  // "video" ONLY when THIS change is fundamentally an interaction or motion a
                                     // still can't convey: drag/drop, reorder/sortable, expand/collapse, tab switch,
                                     // animation, transition. A focus/open/hover state whose END STATE a still CAN
                                     // show (an accent border on a focused field, an open dropdown) is "image" —
                                     // set interaction_hint so the screenshotter reaches that state. When unsure, "image".
      "interaction_hint": string | null  // the interactive STATE the change is only visible in, as one short phrase,
                                     // for EITHER capture mode. e.g. "focus the input to show its accent border",
                                     // "open the select dropdown", "drag a list row by its handle to reorder it",
                                     // "hover a card to reveal the actions". Null when the change shows in the
                                     // component's default resting state.
` : ''}    }
  ]
}`,
  }]);

  const rawChanges = Array.isArray(draftPlan.changes) ? draftPlan.changes : [];
  const changes = rawChanges
    .filter((c) => c && typeof c === 'object' && typeof c.clause === 'string' && c.clause.trim())
    .map((c) => ({ ...c, clause: c.clause.trim() }))
    .slice(0, MAX_BUNDLE_IMAGES);
  if (!changes.length) throw new Error('Gemini returned no usable changes.');

  let postText = changes.map((c) => c.clause).join('\n');

  // ---- 3. images (one per change, up to MAX_BUNDLE_IMAGES) ----

  let imagePaths = [];
  let imageNotes = []; // human-readable descriptions, same order as imagePaths
  let mediaTypes = []; // 'image' | 'video', same order as imagePaths
  // What the scorer predicted for the post that actually goes out — captured in
  // step 4b and written into history so the analytics feedback loop can later
  // compare predicted vs. real engagement and recalibrate. Null when the scorer
  // is unavailable (vendored install without the free core).
  let postPrediction = null;
  let previewProc = null;

  try {
    let media = []; // { type: 'image'|'video', file, note }, one per captured change (in order)
    if (USE_COVER) {
      // Static cover is always singular — one image regardless of how many
      // changes were found; there's nothing per-change to screenshot.
      media = [{ type: 'image', file: COVER_PATH, note: 'static cover image' }];
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

      // One browser+context reused across every change (cheaper than
      // relaunching per change); tag prefixes on every temp file keep them
      // from colliding. Interactive browse gets a smaller per-change budget
      // when bundling more than one change, so total wall-clock stays sane.
      const browser = await chromium.launch();
      try {
        // deviceScaleFactor 2 renders at retina resolution so element close-ups
        // (often a fraction of the 1280px viewport) aren't upscaled blurry when
        // X displays them larger in the timeline.
        const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });

        const shared = {
          commitMessage,
          interactiveShots: INTERACTIVE_SHOTS,
          interactionHints,
          zoomCamera: ZOOM_CAMERA,
          browseMaxSteps: changes.length > 1 ? 3 : 5,
          browseWallClockMs: changes.length > 1 ? 45_000 : 90_000,
        };

        for (const [i, change] of changes.entries()) {
          const tag = `c${i}`;
          let resolved = null;
          // Interaction/motion changes get a short screen recording instead of a
          // still — a drag/reorder/expand/tab can't be conveyed in one frame.
          // recordInteractionVideo returns null (no ffmpeg, nav miss, unverified,
          // any error) to hand off to the normal image pipeline for this change.
          if (INTERACTIVE_SHOTS && INTERACTION_VIDEOS && change.capture === 'video') {
            // A matching owner-scripted flow wins: it records the whole product
            // flow (Gemini walks the steps) with the click-following camera.
            const flow = pickFlow(FLOWS, change);
            if (flow) {
              resolved = await recordScriptedFlow(browser, baseUrl, flow, shared, tag).catch((err) => {
                console.warn(`Change "${change.clause}": scripted flow "${flow.name}" errored (${err.message}); falling back.`);
                return null;
              });
            }
            // No flow, or the flow couldn't produce a clip: the autonomous
            // single-interaction recorder is the fallback (then a still).
            if (!resolved) {
              resolved = await recordInteractionVideo(browser, baseUrl, change, shared, tag).catch((err) => {
                console.warn(`Change "${change.clause}": video capture errored (${err.message}); falling back to image.`);
                return null;
              });
            }
          }
          if (!resolved) {
            const img = await resolveChangeImage(ctx, baseUrl, REPO_ROOT, change, shared, tag);
            if (img) resolved = { type: 'image', file: img.file, note: img.note };
          }
          if (resolved) media.push(resolved);
        }
        if (!media.length) {
          // No shot could be confirmed for any bundled change. Rather than drop
          // the whole update, fall through to a text-only post — the same
          // graceful degradation each individual change already does when its
          // shot can't be verified (see resolveChangeImage). The draft text
          // carries every clause regardless of media.
          console.warn('No shot could be confirmed for any bundled change; posting text-only.');
        }
      } finally {
        await browser.close();
      }
    }

    // X media rules: a post carries EITHER up to 4 images OR a single video,
    // never a mix. When any change produced a video, post that one video (the
    // changes are ordered most-user-facing first) with the full multi-line text;
    // otherwise attach up to 4 images exactly as before.
    const picked = pickPostMedia(media);
    if (picked.droppedForVideo > 0) {
      console.warn(`X allows a single video with no other media; posting the video and dropping ${picked.droppedForVideo} other media item(s) — their text lines still post.`);
    }
    imagePaths = picked.items.map((m) => m.file);
    imageNotes = picked.items.map((m) => m.note);
    mediaTypes = picked.items.map((m) => m.type);

    // ---- 4. editor pass ----

    const historyBlock = history.length
      ? `\nRECENT POSTS (do not repeat their hooks, structure, or phrasing):\n${history.map((h) => `- ${h.text}`).join('\n')}\n`
      : '';

    const imagesBlock = imageNotes.length > 1
      ? `ATTACHED IMAGES (${imageNotes.length}, same order as the draft's lines):\n${imageNotes.map((n, i) => `${i + 1}. ${n}`).join('\n')}`
      : `ATTACHED IMAGE: ${imageNotes[0] ?? '(none)'}`;

    const edited = await gemini([{
      text: `${VOICE}

${RUBRIC}

You are the editor. Improve the draft below so it scores as high as possible on the rubric while staying strictly inside the voice rules. Scoring high means a stranger scrolling past would stop, read, and want to reply to it, quote it, or send it to a friend (replies, quotes and copy-link shares are the highest-weighted signals and what carry an out-of-network post), not just recognize or like it. If the draft is already strong, tighten it; do not pad it. If the draft has multiple lines (one per bundled change), keep it multi-line: do not collapse it into one sentence, and do not add or drop lines.

Sanity-check visibility, not just engagement: X decides whether a post is shown at all (visibility filtering) separately from how it ranks, and out-of-network recommendations are dropped entirely for anything that trips a spam / "Do Not Amplify" / misleading label. Keep the draft clean of misleading claims, manufactured controversy, and engagement-farming. A safe, substantive post a stranger would forward beats a spicy one that risks being suppressed.

Before returning, reread the draft and strip anything that reads as AI-written: em/en dashes, the "feature — benefit" appendage, rule-of-three lists, and the banned tell-words in the voice rules. Rewrite those spots in plain, casual, human phrasing rather than just deleting the punctuation.
${historyBlock}${prBlock}${projectContext ? `\nWHAT THIS PROJECT IS (assume the reader has never heard of it, keep enough orientation that the post stands alone, do NOT prepend it as a label): ${projectContext}\n` : ''}
DRAFT: ${postText}
COMMIT MESSAGE: ${commitMessage}
${imagesBlock}

Return ONLY JSON: { "post_text": string, "critique": string }`,
    }], { maxOutputTokens: 8192 });

    const finalDraft = (edited.post_text ?? '').trim();
    if (finalDraft) {
      console.log(`Editor critique: ${edited.critique ?? '(none)'}`);
      postText = finalDraft;
    } else {
      console.warn('Editor pass returned empty text; keeping original draft.');
    }

    // ---- 4b. algorithm score + optimization (additive; skips cleanly if unavailable) ----
    // FREE: score the edited draft the way X's Grok/Phoenix ranking model would
    // and log its weak spots. PRO (licensed): iterate it higher WITHOUT leaving
    // the voice rules. Purely additive — the editor above and the publish below
    // are untouched; on any trouble (no package, LLM hiccup) we keep the draft.
    const free = await loadScorerFree();
    if (free) {
      const hasMedia = imagePaths.length > 0;
      const mediaType = mediaTypes[0] === 'video' ? 'video' : (hasMedia ? 'image' : null);
      const scoreInput = { text: postText, hasMedia, mediaType };
      try {
        const diag = await free.evaluatePost(scoreInput, { platform: 'x' });
        console.log(`Post score (free): ${diag.score}/100. Weak spots: ${
          diag.issues.length ? diag.issues.map((i) => `${i.lever}[${i.severity}]`).join(', ') : 'none'}.`);

        if (OPTIMIZE_POST && OPTIMIZE_ITERATIONS > 0) {
          const pro = await loadScorerPro();
          if (pro && SCORER_LICENSE_KEY) {
            try {
              // The editor's on-voice draft — the floor the optimizer isn't
              // allowed to make worse (see the voice gate below).
              const editorDraft = postText;
              // Ground any take/question in what actually shipped, so the
              // optimizer can only sharpen a REAL angle, not invent one.
              const changeContext = [
                projectContext ? `Project: ${projectContext}` : '',
                commitMessage && `Commit: ${commitMessage.split('\n')[0]}`,
                changes.length ? `Change(s): ${changes.map((c) => c.clause).join(' | ')}` : '',
                pr?.title ? `PR: ${pr.title}` : '',
              ].filter(Boolean).join('\n');
              const constraints = `${VOICE}\n\n${RUBRIC}\n\n- Keep the same facts and meaning as the draft.\n- Keep the draft's orientation for a first-time reader: do not strip the context that tells a stranger what the project is and why the change matters.\n- If the draft has multiple lines (one per bundled change), keep it multi-line: do not add, drop, or merge lines.\n- Any take or question you add MUST be genuinely supported by the change context below. Do not invent opinions, criticisms, or claims, and never add a question just to farm replies. If there is no honest, specific take to make, keep the clean factual statement rather than forcing one.\n\nCHANGE CONTEXT (a take or question must be true to this):\n${changeContext || '(the draft above is all that is known)'}`;
              // The optimizer's LLM interface is (prompt) => parsed JSON — exactly
              // what gemini() returns — so we adapt it inline (no extra import).
              const scoreLlm = (prompt) => gemini([{ text: prompt }]);
              const result = await pro.optimizePost(scoreInput, {
                platform: 'x', llm: scoreLlm, constraints,
                targetScore: OPTIMIZE_TARGET, maxIterations: OPTIMIZE_ITERATIONS,
                licenseKey: SCORER_LICENSE_KEY,
              });
              console.log(`Post score (pro): ${result.iterations[0]?.score} -> ${result.best?.evaluation?.score}/100 (${result.reason}).`);
              // Voice gate: a higher score is only worth taking if it didn't cost
              // voice compliance. The optimizer may not introduce MORE mechanical
              // voice violations than the editor's draft had (banned opener,
              // reply-farm clickbait, emoji, em dash…); if it does, keep the draft.
              if (result.improved && result.best?.text) {
                const candidate = stripAiTells(result.best.text);
                const gained = lintVoice(candidate).length - lintVoice(stripAiTells(editorDraft)).length;
                if (gained > 0) {
                  console.warn(`Optimizer raised voice violations (+${gained}: ${lintVoice(candidate).map((v) => v.rule).join(', ')}); keeping the editor's draft over the higher-scoring rewrite.`);
                } else {
                  postText = result.best.text;
                }
              }
            } catch (err) {
              if (err.code === 'UNLICENSED') console.log('Pro optimizer: invalid license; posting the editor\'s draft.');
              else console.warn(`Pro optimization skipped (${err.message}); keeping edited draft.`);
            }
          } else if (!SCORER_LICENSE_KEY) {
            console.log('Pro optimizer not enabled (no POST_SCORER_LICENSE_KEY). Publishing the editor\'s draft as-is; set a license + install @e4/post-scorer-pro to auto-optimize before posting.');
          }
        }

        // Capture the prediction for the FINAL draft (post-optimize; postText may
        // have changed above) so history records what the scorer expected — the
        // training signal the analytics loop compares against real engagement.
        // Deterministic + instant.
        const finalDiag = await free.evaluatePost({ text: postText, hasMedia, mediaType }, { platform: 'x' });
        postPrediction = {
          score: finalDiag.score,
          subscores: finalDiag.subscores,
          has_media: hasMedia,
          media_type: mediaType,
          scorer_version: free.VERSION ?? null,
        };
      } catch (err) {
        console.warn(`Scoring skipped (${err.message}); keeping edited draft.`);
      }
    }

    // Final deterministic scrub of the mechanical AI tells (em dashes above all)
    // the model still emits despite the voice rules. Runs on whatever we're
    // about to post, edited or not.
    const scrubbed = stripAiTells(postText);
    if (scrubbed !== postText) {
      console.log('Scrubbed AI writing tells (em/en dashes, spacing) from the post.');
      postText = scrubbed;
    }
    // Surface any voice violations that survived (e.g. an opener the editor kept),
    // so the run log shows them even when we couldn't auto-fix.
    const residual = lintVoice(postText);
    if (residual.length) console.warn(`Voice lint on final post: ${residual.map((v) => v.rule).join(', ')}.`);

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

    // X allows at most 4 images per post (or a single video); pickPostMedia
    // already enforced that, but a defensive slice here costs nothing.
    imagePaths = imagePaths.slice(0, 4);
    imageNotes = imageNotes.slice(0, imagePaths.length);
    mediaTypes = mediaTypes.slice(0, imagePaths.length);
    const postingVideo = mediaTypes[0] === 'video';
    const imagesSummaryLine = postingVideo
      ? `**Video:** ${imageNotes[0] ?? '(none)'}`
      : imageNotes.length > 1
        ? `**Images:**\n${imageNotes.map((n, i) => `${i + 1}. ${n}`).join('\n')}`
        : `**Image:** ${imageNotes[0] ?? '(none)'}`;

    if (DRY_RUN) {
      // Preview mode: everything ran except the publish. Nothing is written to
      // history (so no commit-back), and the draft + images are surfaced in
      // the job summary for review. The images themselves are exposed as a
      // step output (absolute paths on the runner, one per line) so the
      // caller workflow can upload them as downloadable artifacts —
      // GITHUB_STEP_SUMMARY is text-only, it can't carry the actual PNGs off
      // the ephemeral runner.
      console.log(`DRY RUN — not publishing to X. Would post with ${imagePaths.length} ${postingVideo ? 'video' : 'image(s)'}: ${imageNotes.join(' | ')}`);
      const output = process.env.GITHUB_OUTPUT;
      if (output && imagePaths.length) {
        // Multiline GITHUB_OUTPUT values need the <<DELIM ... DELIM heredoc form.
        appendFileSync(output, `image_paths<<AUTOPOST_EOF\n${imagePaths.join('\n')}\nAUTOPOST_EOF\n`);
      }
      const summary = process.env.GITHUB_STEP_SUMMARY;
      if (summary) {
        writeFileSync(
          summary,
          [
            '### Auto-post dry run (nothing published)',
            '',
            `**Would tweet:** ${finalText}`,
            imagesSummaryLine,
            '**Preview:** download the `auto-post-dry-run-preview` artifact from this run (Summary tab, bottom of page).',
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

      // Image uploads are unchanged from the validated path (mimeType
      // image/png); a video item uploads as video/mp4 instead — twitter-api-v2
      // handles the chunked INIT/APPEND/FINALIZE + processing wait for videos.
      // pickPostMedia guarantees imagePaths is either up-to-4 images or exactly
      // one video, never a mix.
      const mediaIds = [];
      for (let k = 0; k < imagePaths.length; k++) {
        const mimeType = mediaTypes[k] === 'video' ? 'video/mp4' : 'image/png';
        mediaIds.push(await twitter.v1.uploadMedia(imagePaths[k], { mimeType }));
      }
      // SCHEDULING (additive): the validated posting call itself is unchanged;
      // this branch wraps around it. If the scheduler says defer AND the
      // Worker queue is configured, hand off the ready-to-post payload
      // (text + already-uploaded media_ids, both valid ~24h) and exit. If the
      // Worker isn't configured, log the intent and fall through to post now —
      // this keeps repos that haven't wired up the queue unbroken.
      let scheduleConfig = null;
      try {
        const p = fileURLToPath(new URL('./windows.json', import.meta.url));
        scheduleConfig = JSON.parse(readFileSync(p, 'utf8'));
      } catch (err) {
        console.warn('Scheduler: windows.json unreadable, posting now.', err.message);
      }
      // Author-diversity spacing: feed the scheduler the last post's time so it
      // can hold a new post far enough from the previous one (posts clustered in
      // the same reader's feed decay each other). Newest history entry wins.
      const lastPostAt = [...history].reverse().find((h) => h && h.posted_at)?.posted_at || null;
      const decision = scheduleConfig
        ? decideSchedule(new Date(), { ...scheduleConfig, lastPostAt })
        : { action: 'post-now', reason: 'no schedule config', window: null };
      console.log(`Scheduler: ${decision.action} — ${decision.reason}`);

      if (decision.action === 'defer' && WORKER_URL && WORKER_ENQUEUE_TOKEN) {
        const res = await fetch(new URL('/api/v1/pending', WORKER_URL).href, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${WORKER_ENQUEUE_TOKEN}`,
          },
          body: JSON.stringify({
            text: finalText,
            media_ids: mediaIds,
            run_at: decision.runAt,
            sha: GITHUB_SHA,
            repo: process.env.GITHUB_REPOSITORY,
          }),
        });
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          throw new Error(`Worker enqueue failed: ${res.status} ${body}`);
        }
        const { id } = await res.json();
        console.log(`Enqueued for ${decision.runAt} (queue id: ${id}).`);

        // Record now so future runs know this SHA is committed. `posted_at`
        // reflects the scheduled fire time; downstream scoring should measure
        // engagement velocity from actual post time, so it may want to check
        // `deferred: true` and re-fetch post time later.
        mkdirSync(dirname(HISTORY_PATH), { recursive: true });
        appendFileSync(HISTORY_PATH, JSON.stringify({
          sha: GITHUB_SHA,
          tweet_id: null,
          queue_id: id,
          deferred: true,
          text: finalText,
          images: imageNotes,
          posted_at: decision.runAt,
          predicted: postPrediction,
        }) + '\n');

        const summary = process.env.GITHUB_STEP_SUMMARY;
        if (summary) {
          writeFileSync(
            summary,
            [
              '### Auto-post deferred',
              '',
              `**Will tweet at ${decision.runAt}:** ${finalText}`,
              imagesSummaryLine,
              `**Reason:** ${decision.reason}`,
              `**Queue id:** ${id}`,
              '',
            ].join('\n'),
            { flag: 'a' },
          );
        }
        return;
      }
      if (decision.action === 'defer') {
        console.warn(`Scheduler wanted to defer but WORKER_URL/WORKER_ENQUEUE_TOKEN not set; posting now.`);
      }

      // X rejects a `media` field with an empty media_ids array, so a text-only
      // post (no shot confirmed for any change) must omit `media` entirely.
      const tweet = mediaIds.length
        ? await twitter.v2.tweet({ text: finalText, media: { media_ids: mediaIds } })
        : await twitter.v2.tweet({ text: finalText });
      console.log('Posted tweet id:', tweet.data.id);

      // Record for future runs (the workflow commits this file back to the repo).
      // Ensure the data dir exists — a referenced-model consumer may configure
      // everything via inputs and have no .github/auto-post/ directory yet.
      mkdirSync(dirname(HISTORY_PATH), { recursive: true });
      appendFileSync(HISTORY_PATH, JSON.stringify({
        sha: GITHUB_SHA,
        tweet_id: tweet.data.id,
        text: finalText,
        images: imageNotes,
        posted_at: new Date().toISOString(), // when to start measuring from
        predicted: postPrediction,            // scorer's expectation (null if unavailable)
      }) + '\n');

      const summary = process.env.GITHUB_STEP_SUMMARY;
      if (summary) {
        writeFileSync(
          summary,
          [
            '### Auto-post published',
            '',
            `**Tweet:** ${finalText}`,
            imagesSummaryLine,
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
