// Cloudflare Worker entry for the post-scorer API. Routes everything under
// /api/v1/. Zero dependencies; the free scorer is bundled by wrangler.
import { json, error, corsHeaders } from './http.mjs';
import { VERSION } from '../../../packages/scorer/src/index.mjs';

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

    return error('NOT_FOUND', 'Unknown route.', { status: 404, origin, env });
  },
};
