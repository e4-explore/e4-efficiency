// Offline license-key verification for the paid tier.
//
// A license key is `v1.<payloadB64url>.<sigB64url>` where payload is JSON
// { sub, plan, iat, exp? } (sub = customer id, plan = tier, exp = unix seconds).
// The signature is ed25519 over the payload segment's bytes, made server-side
// with the PRIVATE key (never in this repo — see scripts/sign-license.mjs). Here
// we only VERIFY, against the embedded PUBLIC key. Offline verification means no
// phone-home and no runtime dependency on our servers; the tradeoff is that a
// determined user could patch this check out. That's acceptable — the moat is
// the private pro code plus the continuously recalibrated weights/prompts that
// ship on the moving v1 tag; a bypassed snapshot goes stale.
//
// PRODUCTION KEY. The matching private key lives ONLY in the owner's secret
// store (was written to .secrets/post-scorer-signing-private.pem at setup, which
// is gitignored and must be moved to a real secret manager). To rotate: generate
// a new ed25519 keypair, replace the base64 below with the new public half, and
// re-sign any embedded test license.

import { createPublicKey, verify as edVerify } from 'node:crypto';

// Production public key (ed25519, SPKI DER, base64).
const PUBLIC_KEY_DER_B64 = 'MCowBQYDK2VwAyEAn9AlPjFC0224cz+2T1EMRRUCL+uuAhP3+KGZX2ieSyA=';

const PUBLIC_KEY = createPublicKey({
  key: Buffer.from(PUBLIC_KEY_DER_B64, 'base64'),
  format: 'der',
  type: 'spki',
});

const b64urlToBuf = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

// Verify a license key. Returns { valid, plan, sub, reason }.
export function verifyLicenseKey(key) {
  if (!key || typeof key !== 'string') return { valid: false, reason: 'missing' };
  const parts = key.trim().split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return { valid: false, reason: 'malformed' };
  const [, payloadB64, sigB64] = parts;

  let ok = false;
  try {
    ok = edVerify(null, Buffer.from(payloadB64), PUBLIC_KEY, b64urlToBuf(sigB64));
  } catch {
    return { valid: false, reason: 'bad-signature' };
  }
  if (!ok) return { valid: false, reason: 'bad-signature' };

  let payload;
  try {
    payload = JSON.parse(b64urlToBuf(payloadB64).toString('utf8'));
  } catch {
    return { valid: false, reason: 'bad-payload' };
  }
  if (payload.exp && Date.now() / 1000 > payload.exp) {
    return { valid: false, reason: 'expired', plan: payload.plan, sub: payload.sub };
  }
  return { valid: true, plan: payload.plan || 'pro', sub: payload.sub };
}

// Worker-safe verification. The sync `verifyLicenseKey` above uses node:crypto,
// which the Cloudflare Worker can't rely on; this variant uses WebCrypto
// (globalThis.crypto.subtle), which both Node 20+ and workerd support natively
// with the same embedded Ed25519 public key. Returns the same shape as the sync
// version. Use this on the server; the CLI keeps the sync path.
export async function verifyLicenseKeyWebCrypto(key) {
  if (!key || typeof key !== 'string') return { valid: false, reason: 'missing' };
  const parts = key.trim().split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return { valid: false, reason: 'malformed' };
  const [, payloadB64, sigB64] = parts;

  let ok = false;
  try {
    const pub = await crypto.subtle.importKey(
      'spki',
      Buffer.from(PUBLIC_KEY_DER_B64, 'base64'),
      { name: 'Ed25519' },
      false,
      ['verify'],
    );
    ok = await crypto.subtle.verify({ name: 'Ed25519' }, pub, b64urlToBuf(sigB64), Buffer.from(payloadB64));
  } catch {
    return { valid: false, reason: 'bad-signature' };
  }
  if (!ok) return { valid: false, reason: 'bad-signature' };

  let payload;
  try {
    payload = JSON.parse(b64urlToBuf(payloadB64).toString('utf8'));
  } catch {
    return { valid: false, reason: 'bad-payload' };
  }
  if (payload.exp && Date.now() / 1000 > payload.exp) {
    return { valid: false, reason: 'expired', plan: payload.plan, sub: payload.sub };
  }
  return { valid: true, plan: payload.plan || 'pro', sub: payload.sub };
}

// Resolve the key from an explicit value or the standard env var.
export function resolveLicenseKey(explicit) {
  return explicit || process.env.POST_SCORER_LICENSE_KEY || '';
}

// Throw a clear, actionable error if unlicensed. Called at the top of every paid
// entry point.
export function assertLicensed(explicitKey) {
  const key = resolveLicenseKey(explicitKey);
  const res = verifyLicenseKey(key);
  if (!res.valid) {
    const err = new Error(
      `@e4/post-scorer-pro requires a valid license (reason: ${res.reason}). ` +
      'Set POST_SCORER_LICENSE_KEY or pass { licenseKey }. The free @e4/post-scorer ' +
      'still gives you the score, subscores, and named issues.',
    );
    err.code = 'UNLICENSED';
    err.reason = res.reason;
    throw err;
  }
  return res;
}
