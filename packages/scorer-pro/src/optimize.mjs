// Iterate-to-maximize loop. Score a post, have the LLM rewrite it to address the
// highest-impact suggestions (without breaking any voice/brand constraints you
// pass in), re-score, keep the best, repeat until it clears a target or stops
// improving. Returns the winning text plus a full trace of every attempt.
//
// Text is the only thing that changes — media flags carry through untouched, so
// the loop never invents attachments the post doesn't have.

const clampText = (t) => String(t ?? '').trim();

function rewritePrompt(current, evaluation, constraints) {
  const top = evaluation.suggestions.slice(0, 4).map((s, i) => `${i + 1}. ${s.text}`).join('\n');
  return `You are optimizing a social post for maximum reach and engagement on X, WITHOUT changing what it's about or breaking the rules below.

CURRENT POST:
"""
${current}
"""

CURRENT SCORE: ${evaluation.score}/100
Subscores: ${JSON.stringify(evaluation.subscores)}
${evaluation.critique ? `Biggest problem: ${evaluation.critique}\n` : ''}
Highest-impact fixes to apply:
${top || '(none flagged — tighten and sharpen the hook)'}

HARD CONSTRAINTS (never violate):
${constraints || '- Keep the same meaning and facts.\n- Sound like a real person, not a marketer.'}

Rewrite the post to score higher. Keep it truthful to the original meaning. Do not add hashtags or emoji unless they genuinely help. Do not fabricate media or links.

Any opinion, take, or question you use must be genuinely supported by the post and the constraints/context above, never invented to farm engagement, and never clickbait. If there's no honest, specific take to make, keep it a clean factual post rather than forcing a question.

Return ONLY JSON: { "post_text": string, "rationale": string }`;
}

// optimizePost(input, options)
//   input: string | { text, hasMedia, mediaType, hasLinkInReply }
//   options:
//     evaluate  (required) async (input, {llm}) => result   // e.g. x.evaluate
//     llm       (required) async (prompt) => object          // rewriter
//     constraints  string   voice/brand rules the rewrite must respect
//     targetScore  number   stop once reached (default 85)
//     maxIterations number  rewrite attempts (default 3)
//     minGain      number   stop if an attempt gains less than this (default 1)
export async function optimizePost(input, {
  evaluate,
  llm,
  constraints = '',
  targetScore = 85,
  maxIterations = 3,
  minGain = 1,
} = {}) {
  if (typeof evaluate !== 'function') throw new Error('optimizePost requires an `evaluate` function.');

  const base = typeof input === 'string' ? { text: input } : { ...input };
  let current = { ...base, text: clampText(base.text) };

  let evaluation = await evaluate(current, { llm });
  const trace = [{ iteration: 0, text: current.text, score: evaluation.score, subscores: evaluation.subscores, critique: evaluation.critique }];
  let best = { text: current.text, evaluation };

  if (!llm) {
    return { best, iterations: trace, improved: false, reason: 'no-llm', targetReached: evaluation.score >= targetScore };
  }

  let reason = 'max-iterations';
  for (let i = 1; i <= maxIterations; i++) {
    if (best.evaluation.score >= targetScore) { reason = 'target-reached'; break; }

    let rewritten;
    try {
      const reply = await llm(rewritePrompt(best.text, best.evaluation, constraints));
      rewritten = clampText(reply?.post_text);
    } catch (err) {
      reason = `rewrite-error: ${err?.message || err}`;
      break;
    }
    if (!rewritten || rewritten === best.text) { reason = 'no-change'; break; }

    const candidate = { ...base, text: rewritten };
    const candEval = await evaluate(candidate, { llm });
    const gain = candEval.score - best.evaluation.score;
    trace.push({ iteration: i, text: rewritten, score: candEval.score, subscores: candEval.subscores, critique: candEval.critique, gain });

    if (candEval.score > best.evaluation.score) best = { text: rewritten, evaluation: candEval };
    if (gain < minGain) { reason = 'plateau'; break; }
  }

  return {
    best,
    iterations: trace,
    improved: best.evaluation.score > trace[0].score,
    reason,
    targetReached: best.evaluation.score >= targetScore,
  };
}
