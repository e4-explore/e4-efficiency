// Pluggable LLM interface. The scorer never talks to a specific model vendor —
// the caller injects an adapter so the same evaluator works with Gemini (what
// the auto-poster already uses), Claude, Grok, or a local model.
//
// An adapter is just: async (prompt: string) => object
//   - takes a single prompt string
//   - returns the model's reply already parsed as a JSON object
//
// If no adapter is passed, the scorer degrades gracefully to feature-only
// priors (deterministic, no network) — still useful, just blind to semantics.

// Wrap the auto-poster's gemini(parts, opts) — which takes an array of
// { text } parts and returns parsed JSON — into the (prompt) => object shape.
export function fromGeminiFn(geminiFn, opts = {}) {
  // A per-call temperature (scoring vs rewriting) overrides the adapter default.
  return async (prompt, callOpts = {}) => geminiFn([{ text: prompt }], { ...opts, ...callOpts });
}

// Wrap an Anthropic Messages-style client. `create` should be a function like
// anthropic.messages.create; we ask for JSON and parse the first text block.
export function fromAnthropic(create, { model = 'claude-opus-4-8', maxTokens = 1024 } = {}) {
  return async (prompt, { temperature } = {}) => {
    const res = await create({
      model,
      max_tokens: maxTokens,
      ...(temperature != null ? { temperature } : {}),
      messages: [{ role: 'user', content: `${prompt}\n\nReturn ONLY minified JSON.` }],
    });
    const text = res?.content?.find?.((b) => b.type === 'text')?.text ?? res?.content?.[0]?.text ?? '';
    return JSON.parse(extractFirstJsonObject(text));
  };
}

// Wrap an OpenAI/Grok-compatible chat.completions.create.
export function fromOpenAICompatible(create, { model = 'grok-2-latest', maxTokens = 1024 } = {}) {
  return async (prompt, { temperature } = {}) => {
    const res = await create({
      model,
      max_tokens: maxTokens,
      ...(temperature != null ? { temperature } : {}),
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: prompt }],
    });
    const text = res?.choices?.[0]?.message?.content ?? '';
    return JSON.parse(extractFirstJsonObject(text));
  };
}

// Tolerant JSON extraction: pull the first balanced {...} out of a reply that
// may have prose or code fences around it. (Mirrors the poster's own helper so
// this package stays dependency-free.)
export function extractFirstJsonObject(text) {
  const s = String(text);
  const start = s.indexOf('{');
  if (start === -1) throw new Error('No JSON object in model reply.');
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return s.slice(start, i + 1);
  }
  throw new Error('Unbalanced JSON object in model reply.');
}
