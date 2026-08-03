// Ingest an X (Premium) analytics CSV export and turn it into the ACTUAL
// engagement signal for the feedback loop. Pure + dependency-free so it's fully
// testable. The actual score uses the SAME action weights the scorer predicts
// with (Σ weight × rate-per-impression), so predicted and actual land on one
// comparable 0–100 scale.

import { ACTION_WEIGHTS, REFERENCE_EV } from '../../scorer/src/platforms/x/weights.mjs';

// --- minimal RFC4180-ish CSV parser (handles quoted fields, commas, newlines) ---
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const s = String(text).replace(/^﻿/, ''); // strip BOM
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\r') { /* ignore */ }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

// Header synonyms → normalized keys. X's export column names vary across the
// legacy "Tweet activity" CSV and the newer Premium account-analytics export;
// match loosely (lowercased, non-alphanumerics collapsed).
const HEADER_SYNONYMS = {
  tweetId: ['tweet id', 'post id', 'id'],
  permalink: ['tweet permalink', 'post link', 'permalink', 'link', 'url'],
  text: ['tweet text', 'post text', 'text', 'post'],
  date: ['date', 'time', 'created at', 'datetime'],
  impressions: ['impressions', 'impression', 'views', 'view'],
  likes: ['likes', 'like'],
  replies: ['replies', 'reply'],
  reposts: ['reposts', 'retweets', 'repost', 'retweet'],
  quotes: ['quotes', 'quote tweets', 'quote'],
  bookmarks: ['bookmarks', 'bookmark'],
  shares: ['shares', 'share'],
  profileClicks: ['profile visits', 'user profile clicks', 'profile clicks', 'profile clicks and follows'],
  urlClicks: ['url clicks', 'link clicks'],
  detailExpands: ['detail expands', 'detail expand', 'post clicks'],
  mediaViews: ['media views', 'video views', 'media engagements'],
  follows: ['follows', 'new follows', 'new followers', 'new follower'],
  engagements: ['engagements', 'engagement'],
};

const norm = (h) => String(h).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function buildColumnMap(headerRow) {
  const map = {};
  headerRow.forEach((h, idx) => {
    const n = norm(h);
    for (const [key, syns] of Object.entries(HEADER_SYNONYMS)) {
      if (syns.includes(n)) { if (map[key] == null) map[key] = idx; break; }
    }
  });
  return map;
}

const TWEET_ID_RE = /(?:status(?:es)?\/)(\d{5,25})|\b(\d{10,25})\b/;
function extractTweetId(value) {
  if (!value) return null;
  const m = String(value).match(TWEET_ID_RE);
  return m ? (m[1] || m[2]) : null;
}

const num = (v) => {
  const n = Number(String(v ?? '').replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : 0;
};

// Parse the CSV into normalized rows: { tweetId, text, date, metrics{...} }.
export function parseAnalyticsCsv(csvText) {
  const rows = parseCsv(csvText);
  if (rows.length < 2) return [];
  const cols = buildColumnMap(rows[0]);
  const out = [];
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    const get = (k) => (cols[k] != null ? cells[cols[k]] : undefined);
    // A dedicated id column is trusted as-is when it's plain digits; otherwise
    // pull the id out of the permalink URL.
    const idCell = get('tweetId');
    const tweetId = (idCell && /^\d{3,25}$/.test(String(idCell).trim()))
      ? String(idCell).trim()
      : extractTweetId(idCell) || extractTweetId(get('permalink'));
    const metrics = {
      impressions: num(get('impressions')),
      likes: num(get('likes')),
      replies: num(get('replies')),
      reposts: num(get('reposts')),
      quotes: num(get('quotes')),
      bookmarks: num(get('bookmarks')),
      shares: num(get('shares')),
      profileClicks: num(get('profileClicks')),
      urlClicks: num(get('urlClicks')),
      detailExpands: num(get('detailExpands')),
      mediaViews: num(get('mediaViews')),
      follows: num(get('follows')),
      engagements: num(get('engagements')),
    };
    out.push({ tweetId, text: get('text')?.trim() || null, date: get('date') || null, metrics });
  }
  return out;
}

// Map raw metrics -> per-action rates (count / impressions), then to the actual
// engagement score with the scorer's own weights. Shares fall back to bookmarks
// (both are "save/forward" intent) when a shares column isn't present.
export function actualScore(metrics) {
  const impr = metrics.impressions > 0 ? metrics.impressions : null;
  if (!impr) return { score: null, engagementRate: null, reason: 'no-impressions' };

  const rate = {
    like: metrics.likes / impr,
    retweet: metrics.reposts / impr,
    reply: metrics.replies / impr,
    share: (metrics.shares || metrics.bookmarks) / impr,
    follow: metrics.follows / impr,
    profileClickAndEngage: metrics.profileClicks / impr,
    openAndDwell: (metrics.detailExpands || metrics.urlClicks) / impr,
    videoWatch50: metrics.mediaViews / impr,
    // negativeFeedback isn't in the export; treated as 0.
  };
  let ev = 0;
  for (const [action, r] of Object.entries(rate)) ev += (ACTION_WEIGHTS[action] || 0) * r;

  const engagements = metrics.engagements
    || (metrics.likes + metrics.replies + metrics.reposts + metrics.quotes + metrics.bookmarks);
  return {
    score: Math.max(0, Math.min(100, Math.round((ev / REFERENCE_EV) * 100))),
    engagementRate: Math.round((engagements / impr) * 10000) / 10000,
    impressions: impr,
    rates: rate,
  };
}

// Merge parsed analytics rows into history records (array of parsed JSONL
// objects). Matches by tweet_id first, then by normalized text. Adds `actual`
// (metrics + score) and `measured_at`. Returns { records, matched, unmatched }.
export function mergeActuals(records, analyticsRows, now = new Date()) {
  const byId = new Map();
  const byText = new Map();
  for (const row of analyticsRows) {
    if (row.tweetId) byId.set(String(row.tweetId), row);
    if (row.text) byText.set(norm(row.text).slice(0, 80), row);
  }
  let matched = 0;
  const records2 = records.map((rec) => {
    if (rec.actual) return rec; // already measured
    let row = rec.tweet_id ? byId.get(String(rec.tweet_id)) : null;
    if (!row && rec.text) row = byText.get(norm(rec.text).slice(0, 80));
    if (!row) return rec;
    matched++;
    return { ...rec, actual: { ...actualScore(row.metrics), metrics: row.metrics }, measured_at: now.toISOString() };
  });
  return { records: records2, matched, unmatched: analyticsRows.length - matched };
}
