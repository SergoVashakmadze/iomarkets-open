// Asking the feed questions: which events touch these holdings between two days?

import { addDays } from './text.ts';
import type { CorporateAction, EventType } from './types.ts';

/** The day that matters most to a holder: the ex-date, else when it takes effect, else payment. */
export const keyDate = (e: CorporateAction) => e.dates.ex ?? e.dates.effective ?? e.dates.pay ?? e.dates.record ?? e.dates.announced;

const datesOf = (e: CorporateAction) => [e.dates.ex, e.dates.record, e.dates.pay, e.dates.effective].filter((d): d is string => !!d);

/** How long events stay in the feed after their last date. */
export const KEEP_DAYS = 30;

/** Drop events whose last date is more than KEEP_DAYS ago. */
export const prune = (events: CorporateAction[], today: string) => {
  const cut = addDays(today, -KEEP_DAYS);
  return events.filter((e) => [e.dates.announced, ...datesOf(e)].some((d) => d >= cut));
};

/**
 * One event per action. A split reported twice (the charter amendment's effective time, then the first
 * split-adjusted trading day) is kept once, at the later date, which is when holders see it.
 */
export function dedupe(events: CorporateAction[]): CorporateAction[] {
  const out: CorporateAction[] = [];
  for (const e of [...events].sort((a, b) => keyDate(b).localeCompare(keyDate(a)))) {
    const twin = out.find(
      (x) => x.type === e.type && x.company.cik === e.company.cik && (e.type === 'split' || e.type === 'reverse-split') &&
        x.ratio?.new === e.ratio?.new && x.ratio?.old === e.ratio?.old && Math.abs(Date.parse(keyDate(x)) - Date.parse(keyDate(e))) <= 14 * 864e5,
    );
    if (!twin) out.push(e);
  }
  return out;
}

export type Query = {
  /** Tickers, CIKs or FIGIs, in any mix. Empty: every company. */
  holdings?: string[];
  /** YYYY-MM-DD, inclusive: an event matches if any of its dates (ex, record, pay, effective) falls in it. */
  from?: string;
  to?: string;
  types?: EventType[];
};

const ident = (s: string) => s.trim().toUpperCase().replace(/^0+(?=\d)/, '');

export function query(events: CorporateAction[], q: Query): CorporateAction[] {
  const want = new Set((q.holdings ?? []).map(ident).filter(Boolean));
  return events
    .filter((e) => !q.types?.length || q.types.includes(e.type))
    .filter((e) => !want.size || [e.company.ticker, e.company.cik, e.company.figi].some((x) => x && want.has(ident(x))))
    .filter((e) => {
      if (!q.from && !q.to) return true;
      const ds = datesOf(e).length ? datesOf(e) : [e.dates.announced];
      return ds.some((d) => (!q.from || d >= q.from) && (!q.to || d <= q.to));
    })
    .sort((a, b) => keyDate(a).localeCompare(keyDate(b)) || a.id.localeCompare(b.id));
}

/** Monday to Sunday of the week holding `day`. */
export function weekOf(day: string): { from: string; to: string } {
  const d = new Date(`${day}T00:00:00Z`).getUTCDay();
  const from = addDays(day, -((d + 6) % 7));
  return { from, to: addDays(from, 6) };
}

const TYPES: EventType[] = ['dividend', 'split', 'reverse-split', 'merger'];
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A query from JSON (the HTTP API, the MCP tools), checked. */
export function parseQuery(b: Record<string, unknown>): Query | { error: string } {
  const list = (v: unknown) => (Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[\s,;]+/).filter(Boolean) : v == null ? [] : null);
  const holdings = list(b.holdings);
  if (!holdings || holdings.some((h) => typeof h !== 'string')) return { error: 'holdings is a list of tickers, CIKs or FIGIs, e.g. ["AAPL", "BBG000BCVG28"].' };
  if (holdings.length > 500) return { error: 'At most 500 holdings at a time.' };
  const types = list(b.types);
  if (!types || types.some((t) => !TYPES.includes(t as EventType))) return { error: `types are any of ${TYPES.join(', ')}.` };
  for (const k of ['from', 'to'] as const) if (b[k] != null && (typeof b[k] !== 'string' || !DAY.test(b[k] as string))) return { error: `${k} is a day, YYYY-MM-DD.` };
  return {
    holdings: (holdings as string[]).map((h) => h.trim()).filter(Boolean),
    types: types as EventType[],
    ...(b.from ? { from: b.from as string } : {}),
    ...(b.to ? { to: b.to as string } : {}),
  };
}
