// PAID: turn the free tier's named issues (lever ids) into written, actionable
// fixes, and fold in the LLM's semantic suggestions + critique. This is the
// "how" the free tier withholds.

// Lever id -> guidance. A value may be a string or a function of the issue
// (some levers carry a count / overBy for a sharper line).
const LEVER_TEXT = {
  'body-link': 'Move the link into a reply. A bare link in the post body suppresses reach; the same link as a first reply keeps the post clean and still reachable.',
  'no-media': 'Attach an image or short video. Native media lifts dwell and engagement, and a post with visuals out-reaches a text-only one.',
  hashtags: (i) => `Drop ${i.count} hashtag${i.count > 1 ? 's' : ''}. The model reads meaning, not tags now — past one or two, hashtags only read as spammy and get down-weighted.`,
  mentions: (i) => `Trim the @mentions${i.count ? ` (about ${i.count} too many)` : ''}. Cramming accounts in looks like reach-hacking and gets filtered.`,
  'all-caps': 'Ease off the ALL-CAPS. Sustained shouting reads as low quality.',
  punctuation: 'Cut the !!!/??? runs down to a single mark.',
  emoji: 'Thin out the emoji. A wall of them is a spam signal.',
  'length-thin': 'Too thin to say much. Add the specific detail or the "why it matters" so there\'s something to engage with.',
  'length-crammed': "Getting crammed near the limit. Cut anything that isn't the one idea.",
  'length-over': (i) => `Over the 280-char limit${i.overBy ? ` by ${i.overBy}` : ''}. Tighten it or split into a thread.`,
  'reply-bait': 'Give people a reason to reply — an open question or a take worth arguing with. Replies (and your reply back to them) are the highest-weighted signal by far.',
};

function textFor(issue) {
  const t = LEVER_TEXT[issue.lever];
  return typeof t === 'function' ? t(issue) : t || null;
}

// Build the ranked, written suggestions from free-tier issues + LLM notes.
export function buildSuggestions(issues = [], notes = {}) {
  const out = [];
  for (const issue of issues) {
    const text = textFor(issue);
    if (text) out.push({ lever: issue.lever, severity: issue.severity, impact: issue.impact, text });
  }
  // The LLM's semantic ideas (hook, originality, what to actually say) — the
  // hardest-to-copy value. Slot them in as high-impact craft suggestions.
  for (const s of notes.suggestions || []) {
    if (typeof s === 'string' && s.trim()) out.push({ lever: 'craft', severity: 'medium', impact: 0.15, text: s.trim() });
  }
  out.sort((a, b) => b.impact - a.impact);
  return out.map(({ lever, severity, text }) => ({ lever, severity, text }));
}
