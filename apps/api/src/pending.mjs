// Deferred-post queue for the auto-poster.
//
// Storage: Cloudflare KV, binding `PENDING`. Keys are
//   pending:<run_at_iso>:<id>
// so a prefix list returns keys in chronological order. The value is the
// enqueued payload plus retry bookkeeping.
//
// Flow:
//   - Action calls POST /api/v1/pending with { text, media_ids, run_at, sha }.
//   - handleEnqueue validates auth + payload and writes one KV entry.
//   - Cron (*/5 min) invokes fireDue, which lists entries with run_at <= now
//     and posts each via OAuth 1.0a. Success → delete. Transient failure →
//     re-write with attempts++ and a backed-off run_at. attempts >= MAX → move
//     to failed:<...> for manual review.

import { json, error } from './http.mjs';
import { postTweet } from './x-oauth.mjs';

const MAX_ATTEMPTS = 5;
const BACKOFF_MINUTES = [5, 15, 45, 120, 360]; // per-attempt next delay
const MAX_TEXT_LEN = 4000; // permissive; X's own limit varies by tier

function isIsoTimestamp(s) {
  if (typeof s !== 'string') return false;
  const d = new Date(s);
  return Number.isFinite(d.getTime()) && d.toISOString().startsWith(s.slice(0, 19));
}

function makeId() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function handleEnqueue(request, env, origin) {
  if (!env.PENDING) {
    return error('NOT_CONFIGURED', 'PENDING KV binding not configured.', { status: 501, origin, env });
  }
  if (!env.ENQUEUE_TOKEN) {
    return error('NOT_CONFIGURED', 'ENQUEUE_TOKEN secret not set on the Worker.', { status: 501, origin, env });
  }
  const auth = request.headers.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token || token !== env.ENQUEUE_TOKEN) {
    return error('UNAUTHENTICATED', 'Bad or missing bearer token.', { status: 401, origin, env });
  }

  let payload;
  try { payload = await request.json(); } catch { return error('BAD_REQUEST', 'Body must be JSON.', { status: 400, origin, env }); }
  const { text, media_ids, run_at, sha, repo } = payload || {};

  if (typeof text !== 'string' || text.length === 0 || text.length > MAX_TEXT_LEN) {
    return error('BAD_REQUEST', `text must be a 1..${MAX_TEXT_LEN}-char string.`, { status: 400, origin, env });
  }
  if (media_ids !== undefined && (!Array.isArray(media_ids) || media_ids.length > 4 || !media_ids.every((x) => typeof x === 'string'))) {
    return error('BAD_REQUEST', 'media_ids must be 0..4 strings.', { status: 400, origin, env });
  }
  if (!isIsoTimestamp(run_at)) {
    return error('BAD_REQUEST', 'run_at must be an ISO 8601 timestamp.', { status: 400, origin, env });
  }
  const runAtMs = new Date(run_at).getTime();
  // Reject far-future to avoid a poisoned key sitting in KV forever. Media
  // uploads expire ~24h anyway; cap at 48h to be safe.
  if (runAtMs > Date.now() + 48 * 3600 * 1000) {
    return error('BAD_REQUEST', 'run_at is more than 48h in the future.', { status: 400, origin, env });
  }

  const id = makeId();
  const key = `pending:${new Date(runAtMs).toISOString()}:${id}`;
  const value = {
    id,
    text,
    media_ids: media_ids || [],
    run_at: new Date(runAtMs).toISOString(),
    sha: sha || null,
    repo: repo || null,
    attempts: 0,
    enqueued_at: new Date().toISOString(),
  };
  await env.PENDING.put(key, JSON.stringify(value));
  return json({ id, key, run_at: value.run_at }, { status: 202, origin, env });
}

// Called by the cron trigger (see scheduled() in index.mjs). Non-throwing:
// per-item errors are logged and the item is either re-scheduled or moved to
// the failed bucket; the loop always finishes.
export async function fireDue(env) {
  if (!env.PENDING) {
    console.warn('fireDue: PENDING KV binding not configured; skipping.');
    return;
  }
  const nowIso = new Date().toISOString();
  const list = await env.PENDING.list({ prefix: 'pending:' });
  const dueKeys = list.keys
    .map((k) => k.name)
    .filter((name) => {
      // Extract the ISO timestamp between the two colons of `pending:<iso>:<id>`.
      // `iso` itself contains colons (e.g. 2026-08-11T15:02:00.000Z), so split on the
      // marker `:<id>` at the end instead by finding the last `:`.
      const lastColon = name.lastIndexOf(':');
      const iso = name.slice('pending:'.length, lastColon);
      return iso <= nowIso;
    });

  for (const key of dueKeys) {
    const raw = await env.PENDING.get(key);
    if (!raw) continue; // deleted concurrently
    let item;
    try { item = JSON.parse(raw); } catch {
      console.error(`fireDue: unparseable value at ${key}, moving to malformed:`);
      await env.PENDING.put(`malformed:${key}`, raw);
      await env.PENDING.delete(key);
      continue;
    }

    try {
      const res = await postTweet({ env, text: item.text, mediaIds: item.media_ids });
      const tweetId = res?.data?.id || null;
      console.log(`fireDue: posted queue=${item.id} tweet=${tweetId} sha=${item.sha}`);
      // Move to done: for observability. TTL 7d; KV expires it automatically.
      await env.PENDING.put(
        `done:${item.id}`,
        JSON.stringify({ ...item, tweet_id: tweetId, posted_at: new Date().toISOString() }),
        { expirationTtl: 7 * 24 * 3600 },
      );
      await env.PENDING.delete(key);
    } catch (err) {
      const nextAttempts = (item.attempts || 0) + 1;
      if (nextAttempts >= MAX_ATTEMPTS) {
        console.error(`fireDue: giving up on ${item.id} after ${nextAttempts} attempts: ${err.message}`);
        await env.PENDING.put(
          `failed:${item.id}`,
          JSON.stringify({ ...item, attempts: nextAttempts, last_error: String(err.message).slice(0, 500), failed_at: new Date().toISOString() }),
        );
        await env.PENDING.delete(key);
        continue;
      }
      const delayMin = BACKOFF_MINUTES[Math.min(nextAttempts - 1, BACKOFF_MINUTES.length - 1)];
      const nextRunAt = new Date(Date.now() + delayMin * 60 * 1000).toISOString();
      const newKey = `pending:${nextRunAt}:${item.id}`;
      console.warn(`fireDue: attempt ${nextAttempts} failed for ${item.id}: ${err.message}; retrying at ${nextRunAt}`);
      await env.PENDING.put(newKey, JSON.stringify({ ...item, attempts: nextAttempts, run_at: nextRunAt, last_error: String(err.message).slice(0, 500) }));
      await env.PENDING.delete(key);
    }
  }
}
