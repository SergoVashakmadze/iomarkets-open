// FIGIs for the feed's tickers, from OpenFIGI's open mapping API (no key: 25 requests a
// minute, 10 tickers each). The composite FIGI of the US common stock, so events can be
// matched to the Tokenized Asset Map and to any system keyed by FIGI.

export type FigiCache = Record<string, string | null>;

const MAPPING = 'https://api.openfigi.com/v3/mapping';

type Post = (url: string, body: string) => Promise<{ status: number; text: string }>;

export const postJson: Post = async (url, body) => {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body }).catch(() => null);
  return { status: r?.status ?? 0, text: r ? await r.text() : '' };
};

/** Look up tickers not yet in the cache; null records "OpenFIGI has none", so it isn't asked again. */
export async function lookupFigis(tickers: string[], cache: FigiCache, post: Post = postJson, gapMs = 2600): Promise<FigiCache> {
  const todo = [...new Set(tickers)].filter((t) => !(t in cache));
  for (let i = 0; i < todo.length; i += 10) {
    const batch = todo.slice(i, i + 10);
    // OpenFIGI writes share classes with a slash: BRK/B, not BRK-B or BRK.B.
    const body = JSON.stringify(batch.map((t) => ({ idType: 'TICKER', idValue: t.replace(/[-.]/g, '/'), exchCode: 'US', marketSecDes: 'Equity' })));
    let r = await post(MAPPING, body);
    if (r.status === 429) {
      await new Promise((res) => setTimeout(res, 61_000));
      r = await post(MAPPING, body);
    }
    if (r.status !== 200) break; // try the rest next run
    const rows = JSON.parse(r.text) as { data?: { compositeFIGI?: string; figi: string; securityType?: string }[] }[];
    batch.forEach((t, k) => {
      const d = rows[k]?.data ?? [];
      const pick = d.find((x) => /common|ordinary|reit|adr|depositary/i.test(x.securityType ?? '')) ?? d[0];
      cache[t] = pick ? (pick.compositeFIGI ?? pick.figi) : null;
    });
    if (i + 10 < todo.length) await new Promise((res) => setTimeout(res, gapMs));
  }
  return cache;
}
