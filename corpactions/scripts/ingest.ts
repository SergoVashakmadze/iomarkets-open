// Refresh the corporate actions feed from SEC EDGAR: search the last few days of 8-Ks,
// extract the events, add FIGIs from OpenFIGI, merge them into corpactions/data/events.json
// and drop events that are long over. Run daily by .github/workflows/corporate-actions.yml.
//
//   node corpactions/scripts/ingest.ts [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--out file] [--cache dir]
//
// Default window: the last 4 days, so a missed run is caught up by the next one. --cache keeps
// every EDGAR answer in a folder, so working on extract.ts can re-run without asking EDGAR again.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ingest, politeGet, type Get } from '../src/edgar.ts';
import { lookupFigis, type FigiCache } from '../src/figi.ts';
import { dedupe, keyDate, prune } from '../src/query.ts';
import { addDays } from '../src/text.ts';
import type { CorporateAction } from '../src/types.ts';

const arg = (k: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const today = new Date().toISOString().slice(0, 10);
const to = arg('to') ?? today;
const from = arg('from') ?? addDays(to, -4);
const dataDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
const out = arg('out') ?? join(dataDir, 'events.json');
const figiFile = join(dataDir, 'figi.json');

const read = <T>(f: string, empty: T): T => (existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as T) : empty);

const cacheDir = arg('cache');
const live = politeGet();
const get: Get = !cacheDir
  ? live
  : async (url) => {
      mkdirSync(cacheDir, { recursive: true });
      const f = join(cacheDir, createHash('sha256').update(url).digest('hex').slice(0, 32));
      if (existsSync(f)) return { status: 200, text: readFileSync(f, 'utf8') };
      const r = await live(url);
      if (r.status === 200) writeFileSync(f, r.text);
      return r;
    };

const { events, stats } = await ingest(get, from, to, (s) => console.log(s));
console.log(`${stats.documents} documents read, ${stats.events} events found, ${stats.failed.length} could not be fetched.`);

const figis = await lookupFigis(events.map((e) => e.company.ticker).filter((t): t is string => !!t), read<FigiCache>(figiFile, {}));
writeFileSync(figiFile, JSON.stringify(Object.fromEntries(Object.entries(figis).sort()), null, 2) + '\n');
for (const e of events) {
  const f = e.company.ticker ? figis[e.company.ticker] : undefined;
  if (f) e.company.figi = f;
}

const merged = new Map(read<CorporateAction[]>(out, []).map((e) => [e.id, e]));
for (const e of events) merged.set(e.id, e);
const kept = dedupe(prune([...merged.values()], today)).sort((a, b) => keyDate(a).localeCompare(keyDate(b)) || a.id.localeCompare(b.id));
writeFileSync(out, JSON.stringify(kept, null, 2) + '\n');
if (!arg('out')) writeFileSync(join(dataDir, 'meta.json'), JSON.stringify({ updated: new Date().toISOString(), from, to }, null, 2) + '\n');
console.log(`${kept.length} events in ${out} (window ${from} to ${to}).`);
