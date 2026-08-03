import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, parseAnalyticsCsv, actualScore, mergeActuals } from '../src/metrics.mjs';

// A synthetic export shaped like X's analytics CSV (legacy "Tweet activity"
// column names, with a permalink carrying the tweet id).
const CSV = `Tweet id,Tweet permalink,Tweet text,time,impressions,likes,replies,retweets,user profile clicks,url clicks
"1001","https://twitter.com/me/status/1001","rebuilt onboarding, first win in 30s","2026-08-01",5000,120,40,15,60,25
"1002","https://twitter.com/me/status/1002","updated the settings page","2026-08-01",800,4,0,0,3,1`;

test('parseCsv handles quoted fields', () => {
  const rows = parseCsv('a,"b,c",d\n1,2,3');
  assert.deepEqual(rows[0], ['a', 'b,c', 'd']);
  assert.deepEqual(rows[1], ['1', '2', '3']);
});

test('parseAnalyticsCsv maps columns and extracts tweet id from permalink', () => {
  const rows = parseAnalyticsCsv(CSV);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].tweetId, '1001');
  assert.equal(rows[0].metrics.impressions, 5000);
  assert.equal(rows[0].metrics.likes, 120);
  assert.equal(rows[0].metrics.replies, 40);
  assert.equal(rows[0].metrics.profileClicks, 60);
});

test('actualScore is bounded and rewards the high-engagement post more', () => {
  const rows = parseAnalyticsCsv(CSV);
  const hot = actualScore(rows[0].metrics);
  const cold = actualScore(rows[1].metrics);
  assert.ok(hot.score >= 0 && hot.score <= 100);
  assert.ok(hot.score > cold.score);
  assert.ok(hot.engagementRate > cold.engagementRate);
});

test('actualScore handles zero impressions gracefully', () => {
  assert.equal(actualScore({ impressions: 0, likes: 5 }).score, null);
});

test('mergeActuals matches by tweet_id and fills in actual + measured_at', () => {
  const rows = parseAnalyticsCsv(CSV);
  const history = [
    { tweet_id: '1001', text: 'rebuilt onboarding, first win in 30s', predicted: { score: 70 } },
    { tweet_id: '9999', text: 'no analytics for this one', predicted: { score: 40 } },
  ];
  const { records, matched } = mergeActuals(history, rows);
  assert.equal(matched, 1);
  assert.ok(records[0].actual && records[0].actual.score >= 0);
  assert.ok(records[0].measured_at);
  assert.equal(records[1].actual, undefined);
});

test('mergeActuals falls back to text match when tweet_id is absent', () => {
  const rows = parseAnalyticsCsv(CSV);
  const history = [{ text: 'updated the settings page', predicted: { score: 20 } }];
  const { records, matched } = mergeActuals(history, rows);
  assert.equal(matched, 1);
  assert.ok(records[0].actual);
});

test('already-measured records are left untouched', () => {
  const rows = parseAnalyticsCsv(CSV);
  const history = [{ tweet_id: '1001', actual: { score: 55 } }];
  const { records, matched } = mergeActuals(history, rows);
  assert.equal(matched, 0);
  assert.equal(records[0].actual.score, 55);
});
