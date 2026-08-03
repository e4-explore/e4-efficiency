#!/usr/bin/env node
// Ingest an X Premium analytics CSV export into history.jsonl: match each row to
// a posted tweet, compute the ACTUAL engagement score, and write it back — then
// print predicted-vs-actual for everything now measured. This is the paired data
// the calibrator learns from.
//
//   node bin/ingest-analytics.mjs <analytics.csv> [path/to/history.jsonl]
//
// Requires a license (POST_SCORER_LICENSE_KEY) — the feedback loop is paid.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { parseAnalyticsCsv, mergeActuals } from '../src/metrics.mjs';
import { assertLicensed } from '../src/license.mjs';

function readJsonl(path) {
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}
function writeJsonl(path, records) {
  writeFileSync(path, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

async function main() {
  assertLicensed();
  const [csvPath, historyPath = '.github/auto-post/history.jsonl'] = process.argv.slice(2);
  if (!csvPath) { console.error('Usage: ingest-analytics.mjs <analytics.csv> [history.jsonl]'); process.exit(1); }
  if (!existsSync(csvPath)) { console.error(`No such CSV: ${csvPath}`); process.exit(1); }
  if (!existsSync(historyPath)) { console.error(`No history file: ${historyPath}`); process.exit(1); }

  const rows = parseAnalyticsCsv(readFileSync(csvPath, 'utf8'));
  const history = readJsonl(historyPath);
  const { records, matched, unmatched } = mergeActuals(history, rows);
  writeJsonl(historyPath, records);

  console.log(`Ingested ${rows.length} analytics rows: ${matched} matched to posts, ${unmatched} unmatched.`);

  const measured = records.filter((r) => r.actual?.score != null && r.predicted?.score != null);
  if (measured.length) {
    console.log(`\n  predicted → actual  (${measured.length} posts with both)`);
    let absErr = 0;
    for (const r of measured) {
      const p = r.predicted.score;
      const a = r.actual.score;
      absErr += Math.abs(p - a);
      console.log(`   ${String(p).padStart(3)} → ${String(a).padStart(3)}   ${(r.text || '').slice(0, 50)}`);
    }
    console.log(`\n  mean absolute error: ${(absErr / measured.length).toFixed(1)} points`);
    console.log('  (once ~20+ posts are measured, run the calibrator to tune the account model.)');
  } else {
    console.log('No posts yet have BOTH a prediction and measured actuals. Keep posting; predictions are recorded on each post.');
  }
}

main().catch((err) => {
  if (err.code === 'UNLICENSED') { console.error(err.message); process.exit(2); }
  console.error(err); process.exit(1);
});
