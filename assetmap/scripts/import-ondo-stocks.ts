// Add Ondo Stocks (tokenized US stocks and ETFs issued by Ondo Global Markets) to the Asset Map, from
// the issuer's own token registry at docs.ondo.finance/partner-docs/tokens, which lists every token's
// contract on Ethereum, BNB Chain, Solana, HyperEVM and Robinhood Chain. The registry gives no holdings,
// so the selection follows the xStocks entries already in the map: the Ondo token for each stock or ETF
// they track, so both issuers' tokens of one stock sit side by side and link to the same feed events.
// Replaces any ondo-stocks-* entries and leaves the rest of the map alone. Run it after
// import-xstocks.ts, then sign: node assetmap/scripts/sign.ts.
//
//   node assetmap/scripts/import-ondo-stocks.ts
//
// The underlying's FIGI comes from OpenFIGI (cached with the feed's, corpactions/data/figi.json) and its
// exchange (MIC) from the xStocks entry for the same ticker. The registry's ISIN column is the
// underlying's US ISIN, which is not copied: US ISINs are built on licensed CUSIPs.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { lookupFigis, type FigiCache } from '../../corpactions/src/figi.ts';
import type { Chain, Entry, Token } from '../src/types.ts';

export const REGISTRY = 'https://docs.ondo.finance/partner-docs/tokens';
const UA = 'IoMarkets Asset Map info@iomarkets.org';
const today = new Date().toISOString().slice(0, 10);
const here = dirname(fileURLToPath(import.meta.url));
const entriesFile = join(here, '..', 'data', 'entries.json');
const figiFile = join(here, '..', '..', 'corpactions', 'data', 'figi.json');

const COLUMNS: [string, Chain][] = [['ethAddr', 'ethereum'], ['bscAddr', 'bnb'], ['solAddr', 'solana'], ['hyperAddr', 'hyperevm'], ['rhAddr', 'robinhood']];

export type Row = Record<string, string>;

/** The registry's rows, as the page embeds them: {symbol:`AAPLon`,name:`…`,ticker:`AAPL`,ethAddr:`0x…`,…}. */
export function registryRows(html: string): Row[] {
  const start = html.indexOf('const tokenRows=[');
  if (start < 0) throw new Error('The registry page no longer embeds tokenRows: look at it by hand.');
  const body = html.slice(start, html.indexOf('];', start));
  const unescape = (s: string) => s.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  return [...body.matchAll(/\{(symbol:`[^`]*`.*?)\}(?=,\{symbol:|$)/g)].map((m) =>
    Object.fromEntries([...m[1].matchAll(/(\w+):`([^`]*)`/g)].map(([, k, v]) => [k, unescape(v)])),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const r = await fetch(REGISTRY, { headers: { 'User-Agent': UA, Accept: 'text/html' } });
  if (!r.ok) throw new Error(`${REGISTRY}: ${r.status}`);
  const rows = registryRows(await r.text());
  const map = JSON.parse(readFileSync(entriesFile, 'utf8')) as Entry[];
  const xstocks = new Map(map.filter((e) => e.id.startsWith('xstocks-') && e.security.underlying).map((e) => [e.security.underlying!.ticker, e.security.underlying!]));
  const chosen = rows.filter((x) => (x.type === 'Stock' || x.type === 'ETF') && xstocks.has(x.ticker));
  console.log(`${rows.length} tokens in Ondo's registry; ${chosen.length} track a stock or ETF the map's xStocks track.`);

  const figis = await lookupFigis(chosen.map((x) => x.ticker), existsSync(figiFile) ? (JSON.parse(readFileSync(figiFile, 'utf8')) as FigiCache) : {});
  writeFileSync(figiFile, JSON.stringify(Object.fromEntries(Object.entries(figis).sort()), null, 2) + '\n');

  const fresh: Entry[] = chosen.map((x) => {
    const tokens: Token[] = COLUMNS.filter(([k]) => x[k]).map(([k, chain]) => ({ chain, address: x[k], symbol: x.symbol, source: 0 }))
      .sort((a, b) => a.chain.localeCompare(b.chain));
    const u = xstocks.get(x.ticker)!;
    return {
      id: `ondo-stocks-${x.symbol.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
      security: {
        name: x.name,
        issuer: 'Ondo Global Markets',
        kind: 'tokenized-stock',
        ticker: x.symbol,
        token: `${x.symbol} is fully backed by ${x.ticker} and tracks its total return: dividends are reinvested, so the shares behind each token (the issuer's multiplier) rise; not offered in the US.`,
        underlying: { ticker: x.ticker, ...(figis[x.ticker] ? { figi: figis[x.ticker]! } : {}), exchange: u.exchange },
      },
      tokens,
      sources: [{ url: REGISTRY, publisher: 'Ondo Finance', kind: 'issuer-page', checked: today }],
      updated: today,
      attestations: [],
    } satisfies Entry;
  });

  const kept = map.filter((e) => !e.id.startsWith('ondo-stocks-'));
  writeFileSync(entriesFile, JSON.stringify([...kept, ...fresh], null, 2) + '\n');
  console.log(`Wrote ${fresh.length} Ondo Stocks entries (${fresh.reduce((n, e) => n + e.tokens.length, 0)} contracts). Now sign: node assetmap/scripts/sign.ts`);
}
