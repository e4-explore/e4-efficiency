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

// Currently generate-capable Gemini models, cheap → more capable. Verified
// against :generateContent (not the models.list catalog, which lists ids that
// 404 for newer accounts). The adapter skips any that 404, so a stale entry
// degrades instead of breaking — but keep this list current.
const GEMINI_MODELS = ['gemini-2.5-flash', 'gemini-flash-lite-latest', 'gemini-3.5-flash'];

// Build a Gemini adapter from a raw API key. Used by the Pro CLI (Node) and the
// API Worker (workerd) alike — both have global `fetch`, so this stays runtime
// -agnostic and is the single place the model list / token budget live.
//
//   const llm = fromGeminiKey(key, { model: env.GEMINI_MODEL });
//   await llm(prompt, { temperature: 0.1 });  // per-call temperature
//
// `model` (optional) is tried first, then the verified fallback list. Honors a
// per-call `temperature` (scoring runs cool, rewriting warm). maxOutputTokens is
// 8192 so thinking models have room to reason AND emit the JSON — at 2048 they
// intermittently truncate (MAX_TOKENS) and the reply won't parse.
export function fromGeminiKey(key, { model } = {}) {
  const models = [model, ...GEMINI_MODELS].filter(Boolean);
  return async (prompt, { temperature = 0.6 } = {}) => {
    let lastErr = '';
    for (const m of models) {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${encodeURIComponent(key)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: { responseMimeType: 'application/json', temperature, maxOutputTokens: 8192 },
          }),
        },
      );
      if (!res.ok) { lastErr = `${res.status} ${await res.text()}`; continue; }
      const body = await res.json();
      const text = body?.candidates?.[0]?.content?.parts?.map((p) => p.text).filter(Boolean).join('');
      if (text) return JSON.parse(extractFirstJsonObject(text));
    }
    throw new Error(`Gemini call failed: ${lastErr}`);
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
