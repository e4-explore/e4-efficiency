import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.mjs';

const ORIGIN = 'https://scorer.example';
const env = { ALLOWED_ORIGINS: ORIGIN };

export function req(path, { method = 'GET', body, origin = ORIGIN, headers = {} } = {}) {
  const h = { origin, ...headers };
  let payload;
  if (body !== undefined) {
    payload = typeof body === 'string' ? body : JSON.stringify(body);
    h['content-type'] = 'application/json';
    h['content-length'] = String(payload.length);
  }
  return new Request(`https://api.local${path}`, { method, headers: h, body: payload });
}

test('GET /api/v1/health returns ok + version, with CORS for an allowed origin', async () => {
  const res = await worker.fetch(req('/api/v1/health'), env);
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.ok, true);
  assert.equal(typeof j.version, 'string');
  assert.equal(res.headers.get('access-control-allow-origin'), ORIGIN);
});

test('OPTIONS preflight returns 204 with CORS for an allowed origin', async () => {
  const res = await worker.fetch(req('/api/v1/score', { method: 'OPTIONS' }), env);
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-methods'), 'GET, POST, OPTIONS');
});

test('disallowed origin gets no CORS header', async () => {
  const res = await worker.fetch(req('/api/v1/health', { origin: 'https://evil.example' }), env);
  assert.equal(res.headers.get('access-control-allow-origin'), null);
});

test('unknown route returns 404 with error shape', async () => {
  const res = await worker.fetch(req('/nope'), env);
  assert.equal(res.status, 404);
  assert.equal((await res.json()).code, 'NOT_FOUND');
});

test('POST /api/v1/score returns the score shape for a real draft', async () => {
  const res = await worker.fetch(
    req('/api/v1/score', { method: 'POST', body: { text: 'what would you build first?', hasMedia: false, mediaType: null, hasLinkInReply: false } }),
    env,
  );
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(typeof j.score, 'number');
  for (const k of ['engagement', 'safety', 'reach', 'hook', 'clarity']) assert.equal(typeof j.subscores[k], 'number');
  assert.ok(Array.isArray(j.issues));
  assert.equal(j.tier, 'free');
  assert.equal(typeof j.version, 'string');
  assert.equal(res.headers.get('access-control-allow-origin'), ORIGIN);
});

test('score rejects empty text with 400', async () => {
  const res = await worker.fetch(req('/api/v1/score', { method: 'POST', body: { text: '  ' } }), env);
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, 'BAD_REQUEST');
});

test('score rejects invalid JSON with 400', async () => {
  const res = await worker.fetch(req('/api/v1/score', { method: 'POST', body: '{not json' }), env);
  assert.equal(res.status, 400);
});

test('score rejects invalid mediaType with 400', async () => {
  const res = await worker.fetch(req('/api/v1/score', { method: 'POST', body: { text: 'hi', mediaType: 'gif' } }), env);
  assert.equal(res.status, 400);
});

test('score rejects an oversize body with 413', async () => {
  const res = await worker.fetch(req('/api/v1/score', { method: 'POST', body: { text: 'x'.repeat(9000) } }), env);
  assert.equal(res.status, 413);
});

test('score rejects GET with 405', async () => {
  const res = await worker.fetch(req('/api/v1/score', { method: 'GET' }), env);
  assert.equal(res.status, 405);
});
