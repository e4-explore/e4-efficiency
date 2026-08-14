// POST /api/v1/score — the GRADER. Identical for everyone, no plan required:
// an LLM-informed score + subscores + named issues + one-line critique, run
// server-side with the operator's Gemini key. When no key is configured (or the
// model call fails) it degrades to the deterministic heuristic grade, so the
// endpoint never hard-depends on the LLM. The paid tier is the WRITTEN fixes +
// the rewriter (see pro.mjs) — not the grade.
import { gradeWithLlm, fromGeminiKey } from '../../../packages/scorer-pro/src/index.mjs';
import { VERSION } from '../../../packages/scorer/src/index.mjs';
import { json, error } from './http.mjs';

const MEDIA_TYPES = new Set([null, 'image', 'video']);
const MAX_BODY = 8192; // bytes; X posts are tiny.

// Shared body parse/validate for the scoring-shaped endpoints. Returns either
// { input } or { response } (an error Response ready to return).
export async function parsePostBody(request, origin, env) {
  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > MAX_BODY) return { response: error('PAYLOAD_TOO_LARGE', 'Body too large.', { status: 413, origin, env }) };

  const raw = await request.text();
  if (raw.length > MAX_BODY) return { response: error('PAYLOAD_TOO_LARGE', 'Body too large.', { status: 413, origin, env }) };

  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return { response: error('BAD_REQUEST', 'Invalid JSON.', { status: 400, origin, env }) };
  }

  const text = typeof body?.text === 'string' ? body.text.trim() : '';
  if (!text) return { response: error('BAD_REQUEST', 'Field "text" is required.', { status: 400, origin, env }) };

  const mediaType = body?.mediaType ?? null;
  if (!MEDIA_TYPES.has(mediaType)) return { response: error('BAD_REQUEST', 'Invalid "mediaType".', { status: 400, origin, env }) };

  return { input: { text, hasMedia: Boolean(body?.hasMedia), mediaType, hasLinkInReply: Boolean(body?.hasLinkInReply) }, body };
}

// Build the operator LLM adapter, or null when no key is configured (the grade
// then falls back to deterministic heuristics inside gradeWithLlm/predict).
export function operatorLlm(env) {
  return env?.GEMINI_API_KEY ? fromGeminiKey(env.GEMINI_API_KEY, { model: env.GEMINI_MODEL }) : null;
}

export async function handleScore(request, env, origin) {
  const parsed = await parsePostBody(request, origin, env);
  if (parsed.response) return parsed.response;

  const r = await gradeWithLlm(parsed.input, { platform: 'x', llm: operatorLlm(env) });

  return json(
    {
      score: r.score,
      subscores: r.subscores,
      issues: r.issues,
      critique: r.critique,
      fixesAvailable: r.fixesAvailable,
      tier: 'free',
      predictionSource: r.predictionSource,
      version: VERSION,
    },
    { origin, env },
  );
}
