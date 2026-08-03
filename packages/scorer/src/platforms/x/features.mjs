// Deterministic feature extraction from a post's text. Pure, dependency-free,
// and unit-tested — no network, no LLM. Everything here is something we can read
// straight off the string; the fuzzy semantic judgments (is the hook good, is
// this reply-bait, is it risky) live in the LLM predictor, not here.

const URL_RE = /\bhttps?:\/\/[^\s]+/gi;
// A hashtag: # followed by a letter then word chars. Excludes a bare "#" and
// "#1" style numbering, which aren't topical tags.
const HASHTAG_RE = /(^|\s)#[A-Za-z]\w*/g;
// An @mention: @ followed by a handle. Excludes an email's "@" (preceded by a
// word char).
const MENTION_RE = /(^|\s)@\w{1,15}/g;
// Emoji: broad coverage of the pictographic ranges. Not exhaustive, but enough
// to catch emoji spam.
const EMOJI_RE = /\p{Extended_Pictographic}/gu;

const countMatches = (text, re) => {
  const m = text.match(re);
  return m ? m.length : 0;
};

// Fraction of the LETTERS in the text that are uppercase — a proxy for
// SHOUTING. Ignores non-letters so numbers/punctuation don't skew it.
function capsRatio(text) {
  const letters = text.replace(/[^A-Za-z]/g, '');
  if (letters.length < 8) return 0; // too short to judge; "OK"/"API" aren't shouting.
  const upper = letters.replace(/[^A-Z]/g, '').length;
  return upper / letters.length;
}

// Does the post invite a reply? Replies are the highest-weighted engagement, so
// this is a strong lever. Deterministic heuristics only (a question mark, an
// explicit ask); the LLM refines the actual reply *probability*.
function invitesReply(text) {
  const hasQuestion = /\?\s*$/m.test(text) || /\?/.test(text);
  const asksOpinion =
    /\b(what do you think|thoughts|agree\??|am i wrong|change my mind|which (one|would)|how do you|what would you|drop|reply|tell me|your (take|move|pick))\b/i.test(
      text,
    );
  return hasQuestion || asksOpinion;
}

// The hook is what has to stop the scroll. We surface the first line/sentence so
// the LLM can judge it and so length rules can weight it.
function firstLine(text) {
  const line = text.split(/\n/).find((l) => l.trim().length) || '';
  return line.trim();
}

// Extract structured, deterministic features from a post.
//
// `input` may be a string, or an object { text, hasMedia, mediaType,
// hasLinkInReply }. hasMedia/mediaType describe attachments the scorer can't see
// in the text; hasLinkInReply tells us a link lives in a reply (not penalized)
// rather than the body (penalized).
export function extractFeatures(input) {
  const post = typeof input === 'string' ? { text: input } : { ...input };
  const text = String(post.text ?? '');
  const trimmed = text.trim();

  const links = trimmed.match(URL_RE) || [];
  const hashtags = countMatches(trimmed, HASHTAG_RE);
  const mentions = countMatches(trimmed, MENTION_RE);
  const emoji = countMatches(trimmed, EMOJI_RE);
  const lines = trimmed.split(/\n/).map((l) => l.trim()).filter(Boolean);

  return {
    text: trimmed,
    length: trimmed.length,
    wordCount: trimmed ? trimmed.split(/\s+/).length : 0,
    lineCount: lines.length,
    firstLine: firstLine(trimmed),

    linkCount: links.length,
    hasBodyLink: links.length > 0,
    hasLinkInReply: Boolean(post.hasLinkInReply),

    hashtags,
    mentions,
    emoji,

    capsRatio: capsRatio(trimmed),
    // Runs of !!! or ??? or a mix — a low-quality punctuation tell.
    hasPunctuationSpam: /[!?]{3,}/.test(trimmed),
    exclamations: countMatches(trimmed, /!/g),

    invitesReply: invitesReply(trimmed),
    // A leading number or an obvious list opener reads as scannable/thread-y.
    looksLikeList: /(^|\n)\s*(\d+[.)]|[-•])\s/.test(trimmed) || /\b\d+\s+(ways|things|reasons|lessons|tips)\b/i.test(trimmed),

    hasMedia: Boolean(post.hasMedia),
    mediaType: post.mediaType || (post.hasMedia ? 'image' : null),
  };
}
