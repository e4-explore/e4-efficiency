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
// PRODUCTION: replace PUBLIC_KEY_DER_B64 with your own key. Generate a keypair,
// keep the private key in your signing service's secret store, and embed only
// the public half here.

import { createPublicKey, verify as edVerify } from 'node:crypto';

// Dev public key (ed25519, SPKI DER, base64). Swap for your production key.
const PUBLIC_KEY_DER_B64 = 'MCowBQYDK2VwAyEAiwbPg8e+eLWs2Ai48Oeuh85qRdDSEkSistmxGICIBqU=';

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
