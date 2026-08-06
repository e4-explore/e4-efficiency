// Shared HTTP helpers for the post-scorer Worker API. Zero dependencies.

const CORS_METHODS = 'GET, POST, OPTIONS';
const CORS_HEADERS = 'content-type, authorization';

// Parse the comma-separated ALLOWED_ORIGINS env var into a trimmed list.
export function allowedOrigins(env) {
  return String(env?.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// CORS headers for a response, given the request Origin. Returns {} when the
// origin isn't allowlisted — the browser then blocks the cross-origin read.
export function corsHeaders(origin, env) {
  const list = allowedOrigins(env);
  if (!origin || !list.includes(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': CORS_METHODS,
    'Access-Control-Allow-Headers': CORS_HEADERS,
    Vary: 'Origin',
  };
}

// JSON response with CORS applied.
export function json(body, { status = 200, origin, env, headers = {} } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...corsHeaders(origin, env),
      ...headers,
    },
  });
}

// Consistent error body: { error, code }.
export function error(code, message, opts) {
  return json({ error: message, code }, opts);
}
