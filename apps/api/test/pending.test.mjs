import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.mjs';
import { fireDue } from '../src/pending.mjs';
import { req } from './api.test.mjs';

// In-memory KV mock. Enough for the two APIs pending.mjs uses: get/put/delete/list.
function memKV() {
  const store = new Map();
  return {
    _store: store,
    async get(key) { return store.has(key) ? store.get(key) : null; },
    async put(key, value, opts) { store.set(key, value); return; },
    async delete(key) { store.delete(key); },
    async list({ prefix = '' } = {}) {
      const keys = [...store.keys()].filter((k) => k.startsWith(prefix)).sort().map((name) => ({ name }));
      return { keys, list_complete: true };
    },
  };
}

const ORIGIN = 'https://scorer.example';
function envWithQueue(overrides = {}) {
  return {
    ALLOWED_ORIGINS: ORIGIN,
    ENQUEUE_TOKEN: 'test-token',
    PENDING: memKV(),
    X_API_KEY: 'k',
    X_API_SECRET: 's',
    X_ACCESS_TOKEN: 't',
    X_ACCESS_TOKEN_SECRET: 'ts',
    ...overrides,
  };
}

test('POST /api/v1/pending rejects missing bearer', async () => {
  const env = envWithQueue();
  const res = await worker.fetch(
    req('/api/v1/pending', { method: 'POST', body: { text: 'hi', run_at: '2099-01-01T00:00:00.000Z' } }),
    env,
  );
  assert.equal(res.status, 401);
});

test('POST /api/v1/pending rejects wrong bearer', async () => {
  const env = envWithQueue();
  const res = await worker.fetch(
    req('/api/v1/pending', {
      method: 'POST',
      headers: { authorization: 'Bearer nope' },
      body: { text: 'hi', run_at: new Date(Date.now() + 3600_000).toISOString() },
    }),
    env,
  );
  assert.equal(res.status, 401);
});

test('POST /api/v1/pending rejects payload missing text', async () => {
  const env = envWithQueue();
  const res = await worker.fetch(
    req('/api/v1/pending', {
      method: 'POST',
      headers: { authorization: 'Bearer test-token' },
      body: { run_at: new Date(Date.now() + 3600_000).toISOString() },
    }),
    env,
  );
  assert.equal(res.status, 400);
});

test('POST /api/v1/pending rejects run_at >48h out', async () => {
  const env = envWithQueue();
  const res = await worker.fetch(
    req('/api/v1/pending', {
      method: 'POST',
      headers: { authorization: 'Bearer test-token' },
      body: { text: 'hi', run_at: new Date(Date.now() + 72 * 3600_000).toISOString() },
    }),
    env,
  );
  assert.equal(res.status, 400);
});

test('POST /api/v1/pending 202s and writes a chronological KV key', async () => {
  const env = envWithQueue();
  const runAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  const res = await worker.fetch(
    req('/api/v1/pending', {
      method: 'POST',
      headers: { authorization: 'Bearer test-token' },
      body: { text: 'hello world', media_ids: ['123', '456'], run_at: runAt, sha: 'abcd', repo: 'me/proj' },
    }),
    env,
  );
  assert.equal(res.status, 202);
  const body = await res.json();
  assert.ok(body.id);
  assert.ok(body.key.startsWith(`pending:${runAt}:`));
  const stored = JSON.parse(await env.PENDING.get(body.key));
  assert.equal(stored.text, 'hello world');
  assert.deepEqual(stored.media_ids, ['123', '456']);
  assert.equal(stored.attempts, 0);
});

test('fireDue posts due items and deletes them on success', async () => {
  const env = envWithQueue();
  // Enqueue one due, one future.
  const dueRunAt = new Date(Date.now() - 60_000).toISOString();
  const futureRunAt = new Date(Date.now() + 60 * 60_000).toISOString();
  await env.PENDING.put(`pending:${dueRunAt}:aaa`, JSON.stringify({
    id: 'aaa', text: 'due one', media_ids: [], run_at: dueRunAt, attempts: 0,
  }));
  await env.PENDING.put(`pending:${futureRunAt}:bbb`, JSON.stringify({
    id: 'bbb', text: 'not yet', media_ids: [], run_at: futureRunAt, attempts: 0,
  }));

  // Stub global fetch (X API call) → success.
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ data: { id: 'tweet-1' } }), { status: 200 });
  try {
    await fireDue(env);
  } finally {
    globalThis.fetch = origFetch;
  }

  // Due one moved to done:, future one untouched.
  assert.equal(await env.PENDING.get(`pending:${dueRunAt}:aaa`), null);
  assert.ok(await env.PENDING.get('done:aaa'));
  assert.ok(await env.PENDING.get(`pending:${futureRunAt}:bbb`));
});

test('fireDue re-schedules with backoff on failure and eventually gives up', async () => {
  const env = envWithQueue();
  const dueRunAt = new Date(Date.now() - 60_000).toISOString();
  await env.PENDING.put(`pending:${dueRunAt}:ccc`, JSON.stringify({
    id: 'ccc', text: 'flaky', media_ids: [], run_at: dueRunAt, attempts: 4, // one more attempt left
  }));

  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('rate limited', { status: 429 });
  try {
    await fireDue(env);
  } finally {
    globalThis.fetch = origFetch;
  }

  // Should have hit MAX_ATTEMPTS (5) and moved to failed:.
  assert.equal(await env.PENDING.get(`pending:${dueRunAt}:ccc`), null);
  const failed = JSON.parse(await env.PENDING.get('failed:ccc'));
  assert.equal(failed.attempts, 5);
  assert.match(failed.last_error, /429/);
});
