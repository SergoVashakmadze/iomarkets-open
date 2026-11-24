// The AI search engines the AI answer check asks, each through its own official API with web search on.
// Keys are the site's (Pages secrets, HANDOVER section 4); an engine without a key is listed as not set up.
// Google AI Overviews and Microsoft Copilot have no official API for this, so they are not asked.
// One OpenRouter key (OPENROUTER_API_KEY) can stand in for all three: each model is asked with OpenRouter's web plugin
// forced to engine "native", so the answer still comes from that provider's own search, which is what the check measures
// (Exa-backed search would be cheaper but would not be what ChatGPT, Gemini or Perplexity users see). A direct key wins.
// Perplexity is asked through its Agent API (POST /v1/agent): Sonar Chat Completions support ended 2026-09-27.
// Each call gets the same numbered prompt (check.ts promptFor) and returns the text and the URLs it cites.

export type EngineId = 'perplexity' | 'openai' | 'gemini';
export type EngineEnv = {
  PERPLEXITY_API_KEY?: string;
  OPENAI_API_KEY?: string;
  GEMINI_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
  /** Model overrides (plain variables), for when a provider renames or retires the default. */
  AI_CHECK_PERPLEXITY_MODEL?: string;
  AI_CHECK_OPENAI_MODEL?: string;
  AI_CHECK_GEMINI_MODEL?: string;
};
export type Fetch = (url: string, init: RequestInit) => Promise<Response>;
export type EngineAnswer = { engine: EngineId; name: string; model: string; via?: 'openrouter'; ok: true; text: string; citations: string[] } | { engine: EngineId; name: string; model: string; via?: 'openrouter'; ok: false; error: string };

export const ENGINES: Record<EngineId, { name: string; product: string; model: string; openrouter: string; key: keyof EngineEnv; modelVar: keyof EngineEnv }> = {
  perplexity: { name: 'Perplexity', product: 'Agent API with web search', model: 'perplexity/sonar', openrouter: 'perplexity/sonar', key: 'PERPLEXITY_API_KEY', modelVar: 'AI_CHECK_PERPLEXITY_MODEL' },
  openai: { name: 'ChatGPT search', product: 'OpenAI Responses API with web search', model: 'gpt-5-mini', openrouter: 'openai/gpt-5-mini', key: 'OPENAI_API_KEY', modelVar: 'AI_CHECK_OPENAI_MODEL' },
  gemini: { name: 'Gemini', product: 'Gemini API with Google Search grounding', model: 'gemini-2.5-flash', openrouter: 'google/gemini-3.5-flash', key: 'GEMINI_API_KEY', modelVar: 'AI_CHECK_GEMINI_MODEL' },
};
export const ENGINE_IDS = Object.keys(ENGINES) as EngineId[];
export const TIMEOUT_MS = 45_000;
const MAX_TEXT = 12_000;

const has = (v: unknown) => typeof v === 'string' && v.length > 8;
const direct = (env: EngineEnv, id: EngineId) => has(env[ENGINES[id].key]);
export const configured = (env: EngineEnv) => ENGINE_IDS.filter((id) => direct(env, id) || has(env.OPENROUTER_API_KEY));
/** The model override applies to whichever route is used: a provider/model slug for OpenRouter, the provider's own name otherwise. */
function modelOf(env: EngineEnv, id: EngineId, viaRouter: boolean): string {
  const o = env[ENGINES[id].modelVar] as string | undefined;
  if (viaRouter) return o?.includes('/') ? o : ENGINES[id].openrouter;
  return o && !(id !== 'perplexity' && o.includes('/')) ? o : ENGINES[id].model;
}

type Obj = Record<string, unknown>;
const arr = (v: unknown): Obj[] => (Array.isArray(v) ? (v as Obj[]) : []);
const str = (v: unknown) => (typeof v === 'string' ? v : '');

async function post(f: Fetch, url: string, headers: Record<string, string>, body: unknown): Promise<Obj> {
  const r = await f(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!r.ok) {
    // To the Pages log only (wrangler pages deployment tail), never to the visitor: the provider's own reason, cut short.
    const why = await r.text().catch(() => '');
    console.warn(`ai-check ${new URL(url).hostname} HTTP ${r.status}: ${why.slice(0, 400)}`);
  }
  if (!r.ok) throw new Error(r.status === 401 || r.status === 403 ? 'the key was refused' : r.status === 429 ? 'rate-limited or out of credit' : `HTTP ${r.status}`);
  return (await r.json()) as Obj;
}

/** Ask one engine. Never throws: a failure comes back as ok false with a short reason (no key, no body). */
export async function askEngine(id: EngineId, prompt: string, env: EngineEnv, f: Fetch = fetch): Promise<EngineAnswer> {
  const e = ENGINES[id];
  const viaRouter = !direct(env, id) && has(env.OPENROUTER_API_KEY);
  const model = modelOf(env, id, viaRouter);
  const key = (viaRouter ? env.OPENROUTER_API_KEY : env[e.key]) as string | undefined;
  const base = { engine: id, name: e.name, model, ...(viaRouter ? { via: 'openrouter' as const } : {}) };
  if (!key || !has(key)) return { ...base, ok: false, error: 'not set up' };
  try {
    let text = '';
    let citations: string[] = [];
    if (viaRouter) {
      // Chat Completions format; citations normalised to message.annotations[type=url_citation].url_citation.url.
      const j = await post(f, 'https://openrouter.ai/api/v1/chat/completions', { authorization: `Bearer ${key}`, 'x-title': 'IoMarkets AI answer check' }, {
        model,
        messages: [{ role: 'user', content: prompt }],
        // Perplexity models always search (search is their API), so they get no web plugin; OpenAI (GPT-5 and later) and
        // Gemini 3.x get the provider's own search. gemini-2.5-flash has none on OpenRouter (404), hence 3.5 Flash.
        ...(id === 'perplexity' ? {} : { plugins: [{ id: 'web', engine: 'native', max_results: 8 }] }),
        // Reasoning models spend output tokens thinking before they answer: keep that small and leave room for the answer.
        ...(id === 'perplexity' ? {} : { reasoning: { effort: 'low' } }),
        max_tokens: 2500,
      });
      const msg = (arr(j.choices)[0]?.message ?? {}) as Obj;
      text = str(msg.content);
      if (!text.trim()) console.warn(`ai-check openrouter ${model}: empty answer, finish_reason ${str(arr(j.choices)[0]?.finish_reason)}`);
      citations = arr(msg.annotations).filter((a) => a.type === 'url_citation').map((a) => str(((a.url_citation ?? {}) as Obj).url ?? a.url));
    } else if (id === 'perplexity') {
      // Agent API: answer text in output[type=message].content[type=output_text].text, sources in output[type=search_results].results[].url.
      // search_type "fast" is $1 per 1,000 searches (vs $2.50); service_tier "default" avoids priority pricing.
      const j = await post(f, 'https://api.perplexity.ai/v1/agent', { authorization: `Bearer ${key}` }, {
        model,
        input: prompt,
        tools: [{ type: 'web_search', search_type: 'fast', max_results: 8 }],
        max_output_tokens: 1500,
        service_tier: 'default',
      });
      const out = arr(j.output);
      text = out.filter((o) => o.type === 'message').flatMap((o) => arr(o.content)).filter((c) => c.type === 'output_text').map((c) => str(c.text)).join('\n');
      citations = out.filter((o) => o.type === 'search_results').flatMap((o) => arr(o.results)).map((r) => str(r.url));
    } else if (id === 'openai') {
      const j = await post(f, 'https://api.openai.com/v1/responses', { authorization: `Bearer ${key}` }, { model, tools: [{ type: 'web_search' }], input: prompt });
      const parts = arr(j.output).filter((o) => o.type === 'message').flatMap((o) => arr(o.content)).filter((c) => c.type === 'output_text');
      text = parts.map((p) => str(p.text)).join('\n');
      citations = parts.flatMap((p) => arr(p.annotations)).filter((a) => a.type === 'url_citation').map((a) => str(a.url));
    } else {
      const j = await post(f, `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, { 'x-goog-api-key': key }, {
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        tools: [{ google_search: {} }],
      });
      const c = arr(j.candidates)[0] ?? {};
      text = arr((c.content as Obj | undefined)?.parts).map((p) => str(p.text)).join('');
      // Grounding URIs are Google redirects; the chunk's title is the site's domain, which is what the check needs.
      citations = arr((c.groundingMetadata as Obj | undefined)?.groundingChunks).map((g) => {
        const w = (g.web ?? {}) as Obj;
        const t = str(w.title);
        return /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(t) ? t : str(w.uri);
      });
    }
    if (!text.trim()) return { ...base, ok: false, error: 'no answer came back' };
    return { ...base, ok: true, text: text.slice(0, MAX_TEXT), citations: [...new Set(citations.filter(Boolean))].slice(0, 20) };
  } catch (err) {
    const m = (err as Error).name === 'TimeoutError' ? 'took too long' : (err as Error).message;
    return { ...base, ok: false, error: m.startsWith('the key') || m.startsWith('rate') || m.startsWith('HTTP') || m === 'took too long' ? m : 'could not be reached' };
  }
}
