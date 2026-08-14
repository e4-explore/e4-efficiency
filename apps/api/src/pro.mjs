// POST /api/v1/pro/fixes and /api/v1/pro/optimize — the PAID tools. The grade
// is free everywhere (see score.mjs); what's gated here is turning the grade
// into WRITTEN fixes and auto-rewriting the post to a higher score.
//
// Auth: `Authorization: Bearer <license-key>`, verified offline with WebCrypto
// (Ed25519) — no accounts service needed. When Stripe/accounts land, mint these
// keys on subscribe; nothing here changes. The LLM uses the operator's Gemini
// key (same as the free grader); without it, fixes still return the
// deterministic guidance and optimize reports it can't rewrite (no-llm).
import {
  suggestFixesUnchecked,
  optimizeUnchecked,
  verifyLicenseKeyWebCrypto,
} from '../../../packages/scorer-pro/src/index.mjs';
import { json, error } from './http.mjs';
import { parsePostBody, operatorLlm } from './score.mjs';

function bearer(request) {
  const h = request.headers.get('authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1].trim() : '';
}

// Verify the license or return an error Response. Returns { license } on success.
async function requireLicense(request, origin, env) {
  const key = bearer(request);
  if (!key) return { response: error('UNAUTHENTICATED', 'Missing bearer license.', { status: 401, origin, env }) };
  const res = await verifyLicenseKeyWebCrypto(key);
  if (!res.valid) return { response: error('UNLICENSED', `Invalid license (${res.reason}).`, { status: 401, origin, env }) };
  return { license: res };
}

// Clamp optimizer knobs to server-safe bounds so a request can't ask for a
// hundred LLM round-trips.
function optimizeOpts(body) {
  const num = (v, d, lo, hi) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d;
  };
  return {
    targetScore: num(body?.targetScore, 85, 1, 100),
    maxIterations: num(body?.maxIterations, 3, 1, 5),
    constraints: typeof body?.constraints === 'string' ? body.constraints.slice(0, 2000) : '',
  };
}

export async function handlePro(request, env, origin, action) {
  const auth = await requireLicense(request, origin, env);
  if (auth.response) return auth.response;

  const parsed = await parsePostBody(request, origin, env);
  if (parsed.response) return parsed.response;

  const llm = operatorLlm(env);

  if (action === 'fixes') {
    const r = await suggestFixesUnchecked(parsed.input, { platform: 'x', llm });
    return json(
      { score: r.score, subscores: r.subscores, issues: r.issues, critique: r.critique, suggestions: r.suggestions, tier: 'pro', predictionSource: r.predictionSource },
      { origin, env },
    );
  }

  if (action === 'optimize') {
    const r = await optimizeUnchecked(parsed.input, { platform: 'x', llm, ...optimizeOpts(parsed.body) });
    return json(
      { best: { text: r.best.text, evaluation: r.best.evaluation }, iterations: r.iterations, improved: r.improved, reason: r.reason, targetReached: r.targetReached, tier: 'pro' },
      { origin, env },
    );
  }

  return error('NOT_FOUND', 'Unknown pro action.', { status: 404, origin, env });
}
