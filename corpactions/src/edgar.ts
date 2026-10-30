// Finding corporate action filings on SEC EDGAR. EDGAR full-text search finds the 8-Ks (and
// the press releases filed with them) whose words announce an action; each matching document
// is fetched and handed to extract(). SEC's fair-access rules: a User-Agent naming who is
// asking, and at most 10 requests a second (this keeps well under).

import { extract, type Filing } from './extract.ts';
import { htmlToText } from './text.ts';
import type { CorporateAction } from './types.ts';

export const USER_AGENT = 'IoMarkets corporate actions feed info@iomarkets.org';
const SEARCH = 'https://efts.sec.gov/LATEST/search-index';

/** The searches that find each kind of action. Every hit is still read in full by extract(). */
export const QUERIES: { kind: string; q: string; items?: (items: string[]) => boolean }[] = [
  { kind: 'dividend', q: '"dividend" "of record" "payable"' },
  { kind: 'split', q: '"stock split" "split-adjusted"' },
  { kind: 'split', q: '"reverse stock split" "effective"', items: (i) => i.some((x) => ['3.03', '5.03', '7.01', '8.01'].includes(x)) },
  { kind: 'split', q: '"stock split" "of record" "distributed"' },
  { kind: 'merger', q: '"right to receive" "completed" "merger"', items: (i) => i.includes('2.01') && (i.includes('3.01') || i.includes('5.01')) },
];

export type Hit = {
  _id: string;
  _source: { ciks: string[]; display_names: string[]; form: string; root_forms: string[]; file_date: string; adsh: string; items?: string[] | null; file_type?: string };
};

export type Get = (url: string) => Promise<{ status: number; text: string }>;

/** fetch, paced and retried, with SEC's required User-Agent. */
export function politeGet(minGapMs = 150): Get {
  let last = 0;
  return async (url) => {
    for (let attempt = 0; ; attempt++) {
      const wait = last + minGapMs - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      last = Date.now();
      const r = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json, text/html, */*' } }).catch(() => null);
      if (r && r.status !== 429 && r.status < 500) return { status: r.status, text: await r.text() };
      if (attempt >= 3) return { status: r?.status ?? 0, text: '' };
      await new Promise((res) => setTimeout(res, 2000 * 2 ** attempt));
    }
  };
}

/** "POOL CORP  (POOL)  (CIK 0000945841)" → name, tickers. */
export function parseDisplayName(d: string): { name: string; tickers: string[] } {
  const parts = [...d.matchAll(/\(([^)]*)\)/g)].map((m) => m[1]);
  const tickers = parts.filter((p) => !/^CIK\b/.test(p)).flatMap((p) => p.split(',').map((t) => t.trim())).filter((t) => /^[A-Z][A-Z0-9.\-]{0,9}$/.test(t));
  // EDGAR adds a state of incorporation to some names: "HUNTINGTON BANCSHARES INC /MD/".
  const name = d.replace(/\s*\([^)]*\)/g, '').replace(/\s*\/[A-Z]{2,3}\/?\s*$/, '').replace(/\s+/g, ' ').trim();
  return { name, tickers };
}

export const documentUrl = (cik: string, adsh: string, file: string) =>
  `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${adsh.replace(/-/g, '')}/${file}`;

/** Every search hit between two days (YYYY-MM-DD, inclusive) for one query, 8-Ks only. */
export async function search(get: Get, q: string, from: string, to: string): Promise<Hit[]> {
  const hits: Hit[] = [];
  for (let at = 0; at < 2000; at += 100) {
    const url = `${SEARCH}?q=${encodeURIComponent(q)}&forms=8-K&dateRange=custom&startdt=${from}&enddt=${to}&from=${at}`;
    const r = await get(url);
    if (r.status !== 200) throw new Error(`EDGAR search answered ${r.status} for ${url}`);
    const page = JSON.parse(r.text) as { hits: { hits: Hit[]; total: { value: number } } };
    hits.push(...page.hits.hits);
    if (page.hits.hits.length < 100 || hits.length >= page.hits.total.value) break;
  }
  return hits;
}

export type IngestLog = { searched: number; documents: number; events: number; failed: string[] };

/** Search EDGAR for every kind of action between two days and extract the events. */
export async function ingest(get: Get, from: string, to: string, log: (s: string) => void = () => {}): Promise<{ events: CorporateAction[]; stats: IngestLog }> {
  const seen = new Set<string>();
  const byId = new Map<string, CorporateAction>();
  const stats: IngestLog = { searched: 0, documents: 0, events: 0, failed: [] };
  for (const query of QUERIES) {
    const hits = await search(get, query.q, from, to);
    stats.searched += hits.length;
    log(`${query.kind}: ${hits.length} documents match ${query.q}`);
    for (const h of hits) {
      const src = h._source;
      if (!src.root_forms?.includes('8-K') || seen.has(h._id)) continue;
      const items = src.items ?? [];
      if (query.items && !query.items(items)) continue;
      seen.add(h._id);
      const file = h._id.split(':')[1];
      const cik = src.ciks[0].padStart(10, '0');
      const url = documentUrl(cik, src.adsh, file);
      const r = await get(url);
      if (r.status !== 200) {
        stats.failed.push(url);
        continue;
      }
      stats.documents++;
      const { name, tickers } = parseDisplayName(src.display_names[0] ?? '');
      const filing: Filing = { company: { name, cik }, tickers, form: src.form, accession: src.adsh, filed: src.file_date, url, items, text: htmlToText(r.text) };
      for (const e of extract(filing)) if (!byId.has(e.id)) byId.set(e.id, e);
    }
  }
  stats.events = byId.size;
  return { events: [...byId.values()], stats };
}
