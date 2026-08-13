#!/usr/bin/env node
// Pro CLI: full suggestions + auto-optimize. Requires POST_SCORER_LICENSE_KEY.
// Uses GEMINI_API_KEY for the LLM (BYO key). Falls back to the free CLI's output
// shape if unlicensed, with an upsell.
//
//   post-score-pro "draft" --media image --optimize

import { readFileSync } from 'node:fs';
import { evaluatePro, optimizePost } from '../src/index.mjs';
import { extractFirstJsonObject } from '../src/provider.mjs';

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

function geminiAdapter(key) {
  // Try GEMINI_MODEL first if set, then fall through a list of currently
  // generate-capable models (cheap → more capable). Google rotates model
  // availability and some ids 404 for newer accounts even while they still
  // appear in the models.list endpoint, so this list is verified against
  // :generateContent, not the catalog. The loop below skips any that 404, so
  // a stale entry degrades instead of breaking — but keep this list current.
  const models = [process.env.GEMINI_MODEL, 'gemini-2.5-flash', 'gemini-flash-lite-latest', 'gemini-3.5-flash'].filter(Boolean);
  // Per-call `temperature`: the scoring pass asks for a cool value (reproducible
  // grades) and the rewrite pass a warm one (varied drafts). Default 0.6 for any
  // direct caller that doesn't specify.
  return async (prompt, { temperature = 0.6 } = {}) => {
    let lastErr = '';
    for (const model of models) {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`,
        // maxOutputTokens must cover the model's hidden "thinking" tokens PLUS
        // the JSON payload. At 2048 the 2.5/3.x thinking models intermittently
        // spend the whole budget reasoning and return truncated (finishReason
        // MAX_TOKENS) or empty text, which surfaced here as "Unbalanced JSON
        // object in model reply" / silent fallback to heuristics-only. 8192
        // gives enough headroom to finish thinking and still emit the object.
        // (Not using thinkingConfig:{thinkingBudget:0} — some models 400 on it.)
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { responseMimeType: 'application/json', temperature, maxOutputTokens: 8192 } }) },
      );
      if (!res.ok) { lastErr = `${res.status} ${await res.text()}`; continue; }
      const body = await res.json();
      const text = body?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (text) return JSON.parse(extractFirstJsonObject(text));
    }
    throw new Error(`Gemini call failed: ${lastErr}`);
  };
}

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
