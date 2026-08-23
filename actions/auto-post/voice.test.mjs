// node --test actions/auto-post/voice.test.mjs
// Covers the AI-writing-tell guards: lintVoice() flags them and stripAiTells()
// mechanically removes the safe ones (fake lead-ins, filler intensifiers).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lintVoice, stripAiTells } from './post.mjs';

const rules = (t) => lintVoice(t).map((v) => v.rule);

// ---- lintVoice flags each tell ----

test('flags the "it\'s not X, it\'s Y" reversal', () => {
  assert.ok(rules("This isn't a workflow, it's a mindset.").includes('reversal'));
  assert.ok(rules("It's not about the tools, it's about judgment.").includes('reversal'));
  // A plain sentence that happens to contain a comma + it's is fine.
  assert.ok(!rules('bets now load instantly and the odds refresh live').includes('reversal'));
});

test('flags a rhetorical question answered in the same breath', () => {
  assert.ok(rules('The result? Not what I expected.').includes('rhetorical-qa'));
  assert.ok(rules('Bets load instantly. The best part? It is free.').includes('rhetorical-qa'));
  // A single real question at the END of the post is allowed, not flagged.
  assert.ok(!rules('rebuilt the settings page. what setting do you change first?').includes('rhetorical-qa'));
});

test('flags a three-word stack of one-word sentences', () => {
  assert.ok(rules('Simple. Clean. Powerful.').includes('three-word-stack'));
  assert.ok(!rules('the dashboard is simple and clean now').includes('three-word-stack'));
});

test('flags fake lead-ins', () => {
  assert.ok(rules("Here's the thing: onboarding was slow.").includes('fake-lead-in'));
  assert.ok(rules("Let's be honest, nobody read the docs.").includes('fake-lead-in'));
  assert.ok(!rules('onboarding is now a single screen').includes('fake-lead-in'));
});

test('flags filler intensifiers', () => {
  assert.ok(rules('I genuinely think this is a really powerful shift.').includes('filler'));
  assert.ok(rules('this actually ships today').includes('filler'));
  assert.ok(!rules('this ships today with live odds').includes('filler'));
});

// ---- stripAiTells removes the safe ones (before -> after) ----

test('strips a fake lead-in and re-capitalizes the new opener', () => {
  assert.equal(
    stripAiTells("Here's the thing: onboarding was slow, so it's one screen now."),
    'Onboarding was slow, so it\'s one screen now.',
  );
});

test('strips mid-sentence filler intensifiers without mangling the sentence', () => {
  assert.equal(
    stripAiTells('I genuinely think this is a really powerful shift.'),
    'I think this is a powerful shift.',
  );
  assert.equal(stripAiTells('the odds actually refresh live now'), 'the odds refresh live now');
});

test('leaves a clean post untouched', () => {
  const clean = 'live odds now refresh every 30s with no page reload';
  assert.equal(stripAiTells(clean), clean);
  assert.equal(lintVoice(clean).length, 0);
});

test('after stripAiTells, the removed tells no longer lint', () => {
  const before = "Here's the thing: this is a really big change.";
  const after = stripAiTells(before);
  const r = rules(after);
  assert.ok(!r.includes('fake-lead-in'));
  assert.ok(!r.includes('filler'));
});
