#!/usr/bin/env node
// FREE CLI: score a post before you publish it — the number, the subscores, and
// which levers are weak. Deterministic, offline, no key.
//
//   echo "my draft" | post-score
//   post-score "my draft" --media image --json
//
// The written fixes for these issues and the auto-optimizer are the paid tier
// (@e4/post-scorer-pro / `post-score-pro`).

import { readFileSync } from 'node:fs';
import { evaluatePost } from '../src/index.mjs';

function parseArgs(argv) {
  const o = { platform: 'x', media: 'none', json: false, linkInReply: false };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') o.json = true;
    else if (a === '--link-in-reply') o.linkInReply = true;
    else if (a === '--media') o.media = argv[++i];
    else if (a === '--platform') o.platform = argv[++i];
    else if (a === '-h' || a === '--help') o.help = true;
    else rest.push(a);
  }
  o.text = rest.join(' ');
  return o;
}

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const bar = (n) => `${'█'.repeat(Math.round(clamp(n, 0, 100) / 10))}${'░'.repeat(10 - Math.round(clamp(n, 0, 100) / 10))} ${String(n).padStart(3)}`;

function printResult(r) {
  console.log(`\n  X post score: ${r.score}/100   (free — heuristics)\n`);
  for (const [k, v] of Object.entries(r.subscores)) console.log(`  ${k.padEnd(11)} ${bar(v)}`);
  if (r.issues.length) {
    console.log(`\n  Weak spots (${r.fixesAvailable}):`);
    for (const i of r.issues) console.log(`   ⚠ ${i.lever} → hurts ${i.subscore} [${i.severity}]`);
    console.log('\n  Unlock the fixes + auto-optimize with Pro (post-score-pro).');
  } else {
    console.log('\n  No weak spots flagged. Pro adds LLM scoring + auto-optimize.');
  }
  console.log('');
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) {
    console.log('Usage: post-score [text] [--media image|video|none] [--link-in-reply] [--json]');
    return;
  }
  const text = (o.text || readFileSync(0, 'utf8')).trim();
  if (!text) { console.error('No post text provided (pass as an argument or pipe via stdin).'); process.exit(1); }

  const input = {
    text,
    hasMedia: o.media === 'image' || o.media === 'video',
    mediaType: o.media === 'none' ? null : o.media,
    hasLinkInReply: o.linkInReply,
  };
  const result = await evaluatePost(input, { platform: o.platform });
  if (o.json) { console.log(JSON.stringify(result, null, 2)); return; }
  printResult(result);
}

main().catch((err) => { console.error(err); process.exit(1); });
