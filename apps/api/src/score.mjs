// POST /api/v1/score — free tier. Validates input, runs the deterministic free
// scorer server-side, returns score + subscores + named issues. No paid code.
import { evaluatePost, VERSION } from '../../../packages/scorer/src/index.mjs';
import { json, error } from './http.mjs';

const MEDIA_TYPES = new Set([null, 'image', 'video']);
const MAX_BODY = 8192; // bytes; X posts are tiny.

export async function handleScore(request, env, origin) {
  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > MAX_BODY) return error('PAYLOAD_TOO_LARGE', 'Body too large.', { status: 413, origin, env });

  const raw = await request.text();
  if (raw.length > MAX_BODY) return error('PAYLOAD_TOO_LARGE', 'Body too large.', { status: 413, origin, env });

  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return error('BAD_REQUEST', 'Invalid JSON.', { status: 400, origin, env });
  }

  const text = typeof body?.text === 'string' ? body.text.trim() : '';
  if (!text) return error('BAD_REQUEST', 'Field "text" is required.', { status: 400, origin, env });

  const mediaType = body?.mediaType ?? null;
  if (!MEDIA_TYPES.has(mediaType)) return error('BAD_REQUEST', 'Invalid "mediaType".', { status: 400, origin, env });

  const r = await evaluatePost(
    { text, hasMedia: Boolean(body?.hasMedia), mediaType, hasLinkInReply: Boolean(body?.hasLinkInReply) },
    { platform: 'x' },
  );

  return json(
    { score: r.score, subscores: r.subscores, issues: r.issues, fixesAvailable: r.fixesAvailable, tier: 'free', version: VERSION },
    { origin, env },
  );
}
