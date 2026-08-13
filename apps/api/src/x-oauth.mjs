// OAuth 1.0a request signing for the X (Twitter) API. Web Crypto only —
// no Node built-ins, runs in Cloudflare Workers.
//
// Only signs the shape we need: POST https://api.x.com/2/tweets with a JSON
// body. Per RFC 5849, request-body params are only included in the signature
// base string when Content-Type is application/x-www-form-urlencoded, so a
// JSON body contributes nothing to the signature — only the OAuth params do.

function percentEncode(s) {
  return encodeURIComponent(s).replace(/[!*'()]/g, (c) =>
    '%' + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

function randomNonce() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function hmacSha1Base64(key, message) {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(key),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(message));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

// Build the OAuth 1.0a Authorization header for a signed request.
// `params` are the OAuth params to sign; extra query params would go here too
// but /2/tweets takes none. The JSON body is not part of the signature.
async function buildAuthHeader({ method, url, oauthParams, consumerSecret, tokenSecret }) {
  const sortedKeys = Object.keys(oauthParams).sort();
  const paramString = sortedKeys
    .map((k) => `${percentEncode(k)}=${percentEncode(oauthParams[k])}`)
    .join('&');
  const baseString = [
    method.toUpperCase(),
    percentEncode(url),
    percentEncode(paramString),
  ].join('&');
  const signingKey = `${percentEncode(consumerSecret)}&${percentEncode(tokenSecret)}`;
  const signature = await hmacSha1Base64(signingKey, baseString);

  const headerParams = { ...oauthParams, oauth_signature: signature };
  const headerString = Object.keys(headerParams)
    .sort()
    .map((k) => `${percentEncode(k)}="${percentEncode(headerParams[k])}"`)
    .join(', ');
  return `OAuth ${headerString}`;
}

// POST a tweet. Returns the parsed response body on success; throws on failure.
export async function postTweet({ env, text, mediaIds }) {
  const url = 'https://api.x.com/2/tweets';
  const oauthParams = {
    oauth_consumer_key: env.X_API_KEY,
    oauth_nonce: randomNonce(),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_token: env.X_ACCESS_TOKEN,
    oauth_version: '1.0',
  };
  const authHeader = await buildAuthHeader({
    method: 'POST',
    url,
    oauthParams,
    consumerSecret: env.X_API_SECRET,
    tokenSecret: env.X_ACCESS_TOKEN_SECRET,
  });

  const body = mediaIds && mediaIds.length
    ? { text, media: { media_ids: mediaIds } }
    : { text };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: authHeader,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const responseText = await res.text();
  if (!res.ok) {
    const err = new Error(`X API ${res.status}: ${responseText}`);
    err.status = res.status;
    err.body = responseText;
    throw err;
  }
  return JSON.parse(responseText);
}
