// Auto-posts a project update to X when a merge lands on `main`.
// Installed by the `project-update-auto-poster` skill. Edit the VOICE block
// below to retune tone; everything else is mechanical glue.

import { chromium } from 'playwright';
import { TwitterApi } from 'twitter-api-v2';
import { writeFileSync } from 'node:fs';

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

const required = {
  GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_SHA, HOMEPAGE_URL,
  GEMINI_API_KEY, X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_TOKEN_SECRET,
};
for (const [k, v] of Object.entries(required)) {
  if (!v) throw new Error(`Missing required env var: ${k}`);
}

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

// 1. Fetch commit context from GitHub.
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

// 2. Ask Gemini for post text + a path to screenshot.
const prompt = `${VOICE}

You are writing one short social post about the change below.

PROJECT
- Repo: ${GITHUB_REPOSITORY}
- Homepage URL (your screenshot will be of a subpath of this): ${HOMEPAGE_URL}

COMMIT
- Message: ${commitMessage}
- Author: ${author}
- Files changed (truncated):
${JSON.stringify(files, null, 2)}

TASK
Return ONLY a JSON object matching this exact schema (no prose):
{
  "post_text": string,          // the social post, under 240 chars, in voice
  "screenshot_path": string     // path relative to homepage URL that best showcases this change.
                                // Use "/" if unsure. Examples: "/", "/pricing", "/blog/new-thing".
}`;

const geminiRes = await fetch(
  `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`,
  {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        temperature: 0.7,
        maxOutputTokens: 512,
      },
    }),
  },
);
if (!geminiRes.ok) throw new Error(`Gemini call failed: ${geminiRes.status} ${await geminiRes.text()}`);
const geminiBody = await geminiRes.json();

const rawText = geminiBody?.candidates?.[0]?.content?.parts?.[0]?.text;
if (!rawText) throw new Error(`Gemini returned no text. Body: ${JSON.stringify(geminiBody).slice(0, 500)}`);

let plan;
try {
  plan = JSON.parse(rawText);
} catch (e) {
  throw new Error(`Failed to parse Gemini JSON: ${e.message}. Raw: ${rawText.slice(0, 500)}`);
}

let postText = (plan.post_text ?? '').trim();
const screenshotPath = (plan.screenshot_path ?? '/').trim() || '/';

if (!postText) throw new Error('Gemini returned empty post_text.');

// 3. Append commit link if it fits, then hard-cap at 280.
const TWEET_LIMIT = 280;
const withLink = `${postText} ${commitUrl}`;
const finalText = withLink.length <= TWEET_LIMIT ? withLink : postText.slice(0, TWEET_LIMIT);

console.log('Drafted post:', finalText);
console.log('Screenshot path:', screenshotPath);

// 4. Screenshot the chosen path.
const screenshotUrl = new URL(screenshotPath, HOMEPAGE_URL).toString();
console.log('Screenshotting:', screenshotUrl);

const browser = await chromium.launch();
let screenshotPathOnDisk = 'screenshot.png';
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  await page.goto(screenshotUrl, { waitUntil: 'networkidle', timeout: 30_000 }).catch(async (err) => {
    console.warn(`networkidle timed out (${err.message}); falling back to load.`);
    await page.goto(screenshotUrl, { waitUntil: 'load', timeout: 30_000 });
  });
  await page.screenshot({ path: screenshotPathOnDisk, fullPage: false });
} finally {
  await browser.close();
}

// 5. Post to X with media attached.
const twitter = new TwitterApi({
  appKey: X_API_KEY,
  appSecret: X_API_SECRET,
  accessToken: X_ACCESS_TOKEN,
  accessSecret: X_ACCESS_TOKEN_SECRET,
});

const mediaId = await twitter.v1.uploadMedia(screenshotPathOnDisk, { mimeType: 'image/png' });
const tweet = await twitter.v2.tweet({
  text: finalText,
  media: { media_ids: [mediaId] },
});

console.log('Posted tweet id:', tweet.data.id);

// 6. Drop a summary in the Actions step output.
const summary = process.env.GITHUB_STEP_SUMMARY;
if (summary) {
  writeFileSync(
    summary,
    [
      '### Auto-post published',
      '',
      `**Tweet:** ${finalText}`,
      `**Screenshot URL:** ${screenshotUrl}`,
      `**Tweet id:** ${tweet.data.id}`,
      '',
    ].join('\n'),
    { flag: 'a' },
  );
}
