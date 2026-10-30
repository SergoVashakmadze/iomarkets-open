// Add xStocks (tokenized US stocks and ETFs issued by Backed) to the Asset Map, from the
// issuer's own public API at api.xstocks.fi: its asset list, proof of reserves and prices.
// Takes the N US-listed xStocks with the most value held in reserve (shares held times the
// issuer's price), replaces any xstocks-* entries, and leaves the rest of the map alone.
// Then sign: node assetmap/scripts/sign.ts.
//
//   node assetmap/scripts/import-xstocks.ts [N]      (default 30)
//
// The underlying's FIGI comes from OpenFIGI (cached with the feed's, corpactions/data/figi.json).
// Its US ISIN, which the API also gives, is not copied: US ISINs are built on licensed CUSIPs.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lookupFigis, type FigiCache } from '../../corpactions/src/figi.ts';
import type { Chain, Entry, Token } from '../src/types.ts';

const API = 'https://api.xstocks.fi/api/v2/public';
const UA = 'IoMarkets Asset Map info@iomarkets.org';
const N = Number(process.argv[2] ?? 30);
const today = new Date().toISOString().slice(0, 10);
const here = dirname(fileURLToPath(import.meta.url));
const entriesFile = join(here, '..', 'data', 'entries.json');
const figiFile = join(here, '..', '..', 'corpactions', 'data', 'figi.json');

const NETWORKS: Record<string, Chain> = {
  Ethereum: 'ethereum', Arbitrum: 'arbitrum', BinanceSmartChain: 'bnb', Mantle: 'mantle', Optimism: 'optimism', Ink: 'ink',
  Monad: 'monad', HyperEVM: 'hyperevm', XLayer: 'xlayer', Solana: 'solana', Ton: 'ton', Tron: 'tron',
};

type Asset = {
  name: string; symbol: string; isin: string;
  underlying: { symbol: string; exchange?: { mic: string; country: string } } | null;
  deployments: { network: string; address: string }[];
};

async function get<T>(path: string): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    await new Promise((r) => setTimeout(r, 300));
    const r = await fetch(`${API}${path}`, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
    if (r.ok) return (await r.json()) as T;
    if (attempt >= 3) throw new Error(`${path}: ${r.status}`);
    await new Promise((res) => setTimeout(res, 2000 * 2 ** attempt));
  }
}
async function all<T>(path: string): Promise<T[]> {
  const out: T[] = [];
  for (let p = 0; p < 60; p++) {
    const page = await get<{ nodes: T[]; page: { hasNextPage: boolean } }>(`${path}${path.includes('?') ? '&' : '?'}pageSize=100&page=${p}`);
    out.push(...page.nodes);
    if (!page.page.hasNextPage) break;
  }
  return out;
}

const assets = (await all<Asset>('/assets')).filter((a) => a.underlying?.exchange?.country === 'US');
const held = new Map((await all<{ symbol: string; sharesHeld: string | null }>('/proof-of-reserves')).map((r) => [r.symbol, Number(r.sharesHeld ?? 0)]));
console.log(`${assets.length} US-listed xStocks; pricing the 150 with the most shares held.`);
const priced: { a: Asset; value: number }[] = [];
for (const a of assets.filter((x) => (held.get(x.symbol) ?? 0) > 0).sort((x, y) => held.get(y.symbol)! - held.get(x.symbol)!).slice(0, 150)) {
  const { quote } = await get<{ quote: number }>(`/assets/${encodeURIComponent(a.symbol)}/price-data`);
  priced.push({ a, value: quote * held.get(a.symbol)! });
}
const chosen = priced.sort((x, y) => y.value - x.value).slice(0, N);

const figis = await lookupFigis(chosen.map((c) => c.a.underlying!.symbol), existsSync(figiFile) ? (JSON.parse(readFileSync(figiFile, 'utf8')) as FigiCache) : {});
writeFileSync(figiFile, JSON.stringify(Object.fromEntries(Object.entries(figis).sort()), null, 2) + '\n');

const fresh: Entry[] = [];
for (const { a } of chosen) {
  // The entry cites the per-asset answer, which lists every deployment, so the issuer check can re-read it.
  const one = await get<Asset>(`/assets/${encodeURIComponent(a.symbol)}`);
  const tokens: Token[] = one.deployments
    .filter((d) => NETWORKS[d.network] && d.address)
    .map((d) => ({ chain: NETWORKS[d.network], address: d.address, symbol: one.symbol, source: 0 }))
    .sort((x, y) => x.chain.localeCompare(y.chain));
  const u = one.underlying!;
  fresh.push({
    id: `xstocks-${one.symbol.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    security: {
      name: one.name,
      issuer: 'Backed (xStocks)',
      kind: 'tokenized-stock',
      isin: one.isin,
      ticker: one.symbol,
      token: `1 ${one.symbol} is backed 1:1 by ${u.symbol} held in custody, times a multiplier that rises as dividends are reinvested and moves with splits; not offered to US persons.`,
      underlying: { ticker: u.symbol, ...(figis[u.symbol] ? { figi: figis[u.symbol]! } : {}), exchange: u.exchange!.mic },
    },
    tokens,
    sources: [{ url: `${API}/assets/${encodeURIComponent(one.symbol)}`, publisher: 'xStocks', kind: 'issuer-api', checked: today }],
    updated: today,
    attestations: [],
  });
}

const kept = (JSON.parse(readFileSync(entriesFile, 'utf8')) as Entry[]).filter((e) => !e.id.startsWith('xstocks-'));
writeFileSync(entriesFile, JSON.stringify([...kept, ...fresh], null, 2) + '\n');
console.log(`Wrote ${fresh.length} xStocks entries (${fresh.reduce((n, e) => n + e.tokens.length, 0)} contracts): ${fresh.map((e) => e.security.ticker).join(', ')}. Now sign: node assetmap/scripts/sign.ts`);
