import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractFeatures } from '../src/platforms/x/index.mjs';

test('counts links, hashtags, mentions', () => {
  const f = extractFeatures('check this out https://example.com #build #ship @jack @dorsey');
  assert.equal(f.linkCount, 1);
  assert.equal(f.hasBodyLink, true);
  assert.equal(f.hashtags, 2);
  assert.equal(f.mentions, 2);
});

test('does not count an email @ as a mention', () => {
  const f = extractFeatures('reach me at a@b.com');
  assert.equal(f.mentions, 0);
});

test('detects reply invitation via question', () => {
  assert.equal(extractFeatures('what would you build first?').invitesReply, true);
  assert.equal(extractFeatures('shipped a new dashboard today.').invitesReply, false);
});

test('caps ratio flags shouting but not short acronyms', () => {
  assert.ok(extractFeatures('THIS IS A HUGE ANNOUNCEMENT TODAY').capsRatio > 0.6);
  assert.ok(extractFeatures('the API is live').capsRatio < 0.6); // an acronym isn't shouting
});

test('media flags carry through from object input', () => {
  const f = extractFeatures({ text: 'new clip', hasMedia: true, mediaType: 'video' });
  assert.equal(f.hasMedia, true);
  assert.equal(f.mediaType, 'video');
});

test('emoji counting', () => {
  assert.equal(extractFeatures('ship it 🚀🔥').emoji, 2);
});
