// Fixed-window, in-memory per-key rate limiter. Best-effort: a Worker isolate is
// ephemeral and requests fan out across many isolates, so this trims abusive
// bursts within one isolate. The durable backstop is a Cloudflare WAF rate rule
// (see README). Pure factory so tests get isolated instances.
export function createRateLimiter({ windowMs, max, now = () => Date.now() }) {
  const hits = new Map(); // key -> { count, resetAt }
  return {
    check(key) {
      const t = now();
      const rec = hits.get(key);
      if (!rec || t >= rec.resetAt) {
        hits.set(key, { count: 1, resetAt: t + windowMs });
        return { allowed: true, retryAfter: 0 };
      }
      if (rec.count < max) {
        rec.count += 1;
        return { allowed: true, retryAfter: 0 };
      }
      return { allowed: false, retryAfter: Math.ceil((rec.resetAt - t) / 1000) };
    },
  };
}
