#!/usr/bin/env node
// Pro CLI: full suggestions + auto-optimize. Requires POST_SCORER_LICENSE_KEY.
// Uses GEMINI_API_KEY for the LLM (BYO key). Falls back to the free CLI's output
// shape if unlicensed, with an upsell.
//
//   post-score-pro "draft" --media image --optimize

import { readFileSync } from 'node:fs';
import { evaluatePro, optimizePost } from '../src/index.mjs';
import { fromGeminiKey } from '../src/provider.mjs';

function parseArgs(argv) {
  const o = { platform: 'x', media: 'none', json: false, optimize: false, target: 85, iterations: 3, linkInReply: false };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') o.json = true;
    else if (a === '--optimize' || a === '-o') o.optimize = true;
    else if (a === '--link-in-reply') o.linkInReply = true;
    else if (a === '--media') o.media = argv[++i];
    else if (a === '--target') o.target = Number(argv[++i]);
    else if (a === '--iterations') o.iterations = Number(argv[++i]);
    else rest.push(a);
  }
  o.text = rest.join(' ');
  return o;
}

// The Gemini adapter (model fallback list, token budget, per-call temperature)
// lives in provider.mjs so the CLI and the API Worker share one implementation.
const geminiAdapter = (key) => fromGeminiKey(key, { model: process.env.GEMINI_MODEL });

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const bar = (n) => `${'█'.repeat(Math.round(clamp(n, 0, 100) / 10))}${'░'.repeat(10 - Math.round(clamp(n, 0, 100) / 10))} ${String(n).padStart(3)}`;

function printResult(r) {
  console.log(`\n  X post score: ${r.score}/100   (pro — ${r.predictionSource === 'hybrid' ? 'heuristics + LLM' : 'heuristics only'})\n`);
  for (const [k, v] of Object.entries(r.subscores)) console.log(`  ${k.padEnd(11)} ${bar(v)}`);
  if (r.critique) console.log(`\n  Biggest problem: ${r.critique}`);
  if (r.suggestions?.length) {
    console.log('\n  Fixes (highest impact first):');
    r.suggestions.forEach((s) => console.log(`   • [${s.severity}] ${s.text}`));
  }
  console.log('');
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const text = (o.text || readFileSync(0, 'utf8')).trim();
  if (!text) { console.error('No post text provided.'); process.exit(1); }
  const llm = process.env.GEMINI_API_KEY ? geminiAdapter(process.env.GEMINI_API_KEY) : null;
  const input = { text, hasMedia: o.media === 'image' || o.media === 'video', mediaType: o.media === 'none' ? null : o.media, hasLinkInReply: o.linkInReply };

  try {
    if (o.optimize) {
      const result = await optimizePost(input, { platform: o.platform, llm, targetScore: o.target, maxIterations: o.iterations });
      if (o.json) return void console.log(JSON.stringify(result, null, 2));
      console.log(`\n  Optimized ${result.iterations[0].score} -> ${result.best.evaluation.score}/100  (${result.reason})`);
      console.log(`\n  Best version:\n  ${result.best.text.replace(/\n/g, '\n  ')}`);
      return printResult(result.best.evaluation);
    }
    const r = await evaluatePro(input, { platform: o.platform, llm });
    if (o.json) return void console.log(JSON.stringify(r, null, 2));
    printResult(r);
  } catch (err) {
    if (err.code === 'UNLICENSED') {
      console.error(`\n  ${err.message}\n  Run the free scorer with: post-score "${text.slice(0, 30)}..."\n`);
      process.exit(2);
    }
    throw err;
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
