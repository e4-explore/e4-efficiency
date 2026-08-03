#!/usr/bin/env node
// SERVER-SIDE license signer. Run this in your billing/fulfillment backend when
// a customer subscribes — NOT shipped to customers. Reads the ed25519 PRIVATE
// key from POST_SCORER_SIGNING_KEY (PEM) and prints a license key.
//
//   POST_SCORER_SIGNING_KEY="$(cat private.pem)" \
//     node scripts/sign-license.mjs --sub cust_123 --plan pro --days 365
//
// Keep the private key in a secret store. The matching PUBLIC key is embedded in
// src/license.mjs, which is what customers use to verify offline.

import { createPrivateKey, sign as edSign } from 'node:crypto';

function parseArgs(argv) {
  const o = { plan: 'pro' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--sub') o.sub = argv[++i];
    else if (argv[i] === '--plan') o.plan = argv[++i];
    else if (argv[i] === '--days') o.days = Number(argv[++i]);
  }
  return o;
}

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const args = parseArgs(process.argv.slice(2));
if (!args.sub) {
  console.error('Usage: sign-license.mjs --sub <customer-id> [--plan pro] [--days N]');
  process.exit(1);
}
const pem = process.env.POST_SCORER_SIGNING_KEY;
if (!pem) {
  console.error('Set POST_SCORER_SIGNING_KEY to the ed25519 private key (PEM).');
  process.exit(1);
}

const payload = {
  sub: args.sub,
  plan: args.plan,
  iat: Math.floor(Date.now() / 1000),
  ...(args.days ? { exp: Math.floor(Date.now() / 1000) + args.days * 86400 } : {}),
};
const payloadB64 = b64url(JSON.stringify(payload));
const key = createPrivateKey({ key: pem });
const sig = edSign(null, Buffer.from(payloadB64), key);
console.log(`v1.${payloadB64}.${b64url(sig)}`);
