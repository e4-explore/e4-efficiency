// Cloudflare Worker entry for the post-scorer API. Routes everything under
// /api/v1/. Zero dependencies; the free scorer is bundled by wrangler.
import { json, error, corsHeaders } from './http.mjs';
import { VERSION } from '../../../packages/scorer/src/index.mjs';
import { handleScore } from './score.mjs';
import { createRateLimiter } from './ratelimit.mjs';

const limiter = createRateLimiter({ windowMs: 60_000, max: 30 });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('origin');
    const { pathname } = url;

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin, env) });
    }

    if (pathname === '/api/v1/health' && request.method === 'GET') {
      return json({ ok: true, version: VERSION }, { origin, env });
    }

    if (pathname === '/api/v1/score') {
      if (request.method !== 'POST') return error('METHOD_NOT_ALLOWED', 'Use POST.', { status: 405, origin, env });
      const ip = request.headers.get('cf-connecting-ip') || 'unknown';
      const rl = limiter.check(ip);
      if (!rl.allowed) {
        return error('RATE_LIMITED', 'Too many requests.', { status: 429, origin, env, headers: { 'Retry-After': String(rl.retryAfter) } });
      }
      return handleScore(request, env, origin);
    }

    return error('NOT_FOUND', 'Unknown route.', { status: 404, origin, env });
  },
};
