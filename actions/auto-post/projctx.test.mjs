// Pure-logic tests for project-context grounding: README intro extraction and
// the compose/priority/truncate step. No network or Gemini key needed — the
// fetching glue (resolveProjectContext) is thin and exercised live.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readmeIntro, composeProjectContext } from './post.mjs';

test('readmeIntro returns the first real prose paragraph, past title + badges', () => {
  const md = `# CoolApp

[![build](https://img.shields.io/badge/build-passing-green)](https://ci.example)

CoolApp is a task manager for teams that turns messy checklists into shared boards.

## Install
run it`;
  assert.equal(
    readmeIntro(md),
    'CoolApp is a task manager for teams that turns messy checklists into shared boards.',
  );
});

test('readmeIntro skips HTML logo/heading blocks and strips inline links', () => {
  const md = `<p align="center"><img src="logo.png" /></p>

<h1>Ledger</h1>

Ledger is a [fast](https://x.example) tool for tracking spending across accounts.`;
  assert.equal(
    readmeIntro(md),
    'Ledger is a fast tool for tracking spending across accounts.',
  );
});

test('readmeIntro strips HTML comments and skips code fences', () => {
  const md = `<!-- hidden note -->

\`\`\`
code block, not prose here
\`\`\`

Notes is a plain little markdown editor you can run entirely offline.`;
  assert.equal(
    readmeIntro(md),
    'Notes is a plain little markdown editor you can run entirely offline.',
  );
});

test('readmeIntro returns empty when there is no prose', () => {
  assert.equal(readmeIntro('# Title\n\n![badge](x)\n'), '');
  assert.equal(readmeIntro(''), '');
  assert.equal(readmeIntro(null), '');
});

test('composeProjectContext combines description, intro, and homepage', () => {
  const out = composeProjectContext({
    description: 'A task manager for teams',
    readmeIntro: 'CoolApp turns messy checklists into shared boards',
    homepage: 'https://cool.app',
  });
  assert.equal(
    out,
    'A task manager for teams. CoolApp turns messy checklists into shared boards. Site: https://cool.app',
  );
});

test('composeProjectContext drops a README intro that just restates the description', () => {
  const out = composeProjectContext({
    description: 'CoolApp is a task manager',
    readmeIntro: 'CoolApp is a task manager for teams',
  });
  assert.equal(out, 'CoolApp is a task manager.');
});

test('composeProjectContext handles a lone description or lone homepage', () => {
  assert.equal(composeProjectContext({ description: 'Just a thing' }), 'Just a thing.');
  assert.equal(composeProjectContext({ homepage: 'https://x.example' }), 'Site: https://x.example');
  assert.equal(composeProjectContext({}), '');
});

test('composeProjectContext truncates to the cap with an ellipsis at a word boundary', () => {
  const long = 'word '.repeat(200).trim(); // 999 chars
  const out = composeProjectContext({ description: long }, 60);
  assert.ok(out.length <= 60, `length ${out.length}`);
  assert.ok(out.endsWith('…'), out);
  assert.ok(!/\s…$/.test(out), 'no space before ellipsis');
});
