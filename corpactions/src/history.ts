// As-of records for the corporate actions feed (enterprise plan, module M3; HANDOVER section 17).
//
// Every event has two kinds of dates: when it happens (its record, ex and pay dates) and when the feed learned
// it. history.json keeps the second: for each event, every version the feed has published, when it was first
// seen, which code produced it, and what changed field by field. A record as it stood on a past day is the
// current one with the later changes undone; an event the feed has since dropped keeps its last state.
//
// Built from git (scripts/backfill-history.ts: every commit of data/events.json since the feed started on
// 2026-10-29) and kept up by scripts/ingest.ts on every refresh. Pure: no file or network access here.

import type { CorporateAction } from './types.ts';

export const HISTORY_FORMAT = 'iomarkets.corporate-action-history.v1';
/** The first day the feed published anything: nothing is known as of an earlier day. */
export const FEED_START = '2026-10-29';

export type Change = { path: string; from?: unknown; to?: unknown };
export type Version = {
  /** When the feed first published this version (the refresh's time, UTC). */
  recorded: string;
  /** The code that produced it: a git commit. */
  code: string;
  /** null for the first version; otherwise what changed since the one before. */
  changes: Change[] | null;
  /** Why, when a person changed the data by hand (the commit's subject). */
  note?: string;
};
export type Removal = { recorded: string; code: string; note?: string; last: CorporateAction };
/** A time the event was out of the feed before coming back: from its removal to its return. */
export type Gap = { from: string; to: string; note?: string };
export type EventHistory = { versions: Version[]; removed?: Removal; gaps?: Gap[] };
export type History = { format: typeof HISTORY_FORMAT; events: Record<string, EventHistory> };

export const emptyHistory = (): History => ({ format: HISTORY_FORMAT, events: {} });

/** An object as dotted paths to leaf values; arrays are leaves, compared whole. */
export function flatten(o: unknown, prefix = '', out: Record<string, unknown> = {}): Record<string, unknown> {
  if (o && typeof o === 'object' && !Array.isArray(o)) {
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
  } else if (prefix) out[prefix] = o;
  return out;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** What changed from one version of a record to the next, path by path. */
export function diff(prev: unknown, next: unknown): Change[] {
  const a = flatten(prev);
  const b = flatten(next);
  const out: Change[] = [];
  for (const path of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
    if (same(a[path], b[path])) continue;
    const c: Change = { path };
    if (path in a) c.from = a[path];
    if (path in b) c.to = b[path];
    out.push(c);
  }
  return out;
}

function setPath(o: Record<string, unknown>, path: string, value: unknown, present: boolean) {
  const keys = path.split('.');
  let cur = o;
  for (const k of keys.slice(0, -1)) {
    if (!cur[k] || typeof cur[k] !== 'object') {
      if (!present) return;
      cur[k] = {};
    }
    cur = cur[k] as Record<string, unknown>;
  }
  const last = keys[keys.length - 1];
  if (present) cur[last] = value;
  else delete cur[last];
}

/** Undoes changes: the record as it was before them. */
export function undo<T>(record: T, changes: Change[]): T {
  const out = structuredClone(record) as Record<string, unknown>;
  for (const c of changes) setPath(out, c.path, c.from, 'from' in c);
  // Drop objects emptied by the undo, so a field that did not exist then is absent, not {}.
  const prune = (o: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(o)) if (v && typeof v === 'object' && !Array.isArray(v)) {
      prune(v as Record<string, unknown>);
      if (!Object.keys(v as object).length) delete o[k];
    }
  };
  prune(out);
  return out as T;
}

/** Records one published state of the feed: new events, changed ones and dropped ones. */
export function record(h: History, prev: CorporateAction[], next: CorporateAction[], at: { recorded: string; code: string; note?: string }): { added: number; changed: number; removed: number } {
  const before = new Map(prev.map((e) => [e.id, e]));
  const after = new Map(next.map((e) => [e.id, e]));
  const meta = { recorded: at.recorded, code: at.code, ...(at.note ? { note: at.note } : {}) };
  let added = 0, changed = 0, removed = 0;
  for (const [id, e] of after) {
    const old = before.get(id);
    const eh = h.events[id];
    if (!old) {
      if (eh?.removed) {
        // Back after being dropped: the absence is kept as a gap, and a new version against its last known state.
        (eh.gaps ??= []).push({ from: eh.removed.recorded, to: at.recorded, ...(eh.removed.note ? { note: eh.removed.note } : {}) });
        eh.versions.push({ ...meta, changes: diff(eh.removed.last, e) });
        delete eh.removed;
      } else if (!eh) h.events[id] = { versions: [{ ...meta, changes: null }] };
      added++;
    } else {
      const d = diff(old, e);
      if (d.length) {
        (h.events[id] ??= { versions: [{ ...meta, changes: null }] }).versions.push({ ...meta, changes: d });
        changed++;
      }
    }
  }
  for (const [id, e] of before) {
    if (after.has(id)) continue;
    (h.events[id] ??= { versions: [{ ...meta, changes: null }] }).removed = { ...meta, last: e };
    removed++;
  }
  return { added, changed, removed };
}

const endOf = (day: string) => `${day}T23:59:59.999Z`;

/** One event as the feed showed it at the end of `day` (UTC), or null if the feed did not show it then. */
export function eventAsOf(h: History, current: Map<string, CorporateAction>, id: string, day: string): CorporateAction | null {
  const eh = h.events[id];
  const now = current.get(id);
  if (!eh) return null;
  const cut = endOf(day);
  if (!eh.versions.length || eh.versions[0].recorded > cut) return null;
  if (eh.removed && eh.removed.recorded <= cut) return null;
  if (eh.gaps?.some((g) => g.from <= cut && cut < g.to)) return null;
  let rec: CorporateAction | undefined = now ?? eh.removed?.last;
  if (!rec) return null;
  for (const v of [...eh.versions].reverse()) {
    if (v.recorded <= cut) break;
    if (v.changes) rec = undo(rec, v.changes);
  }
  return rec;
}

/** The whole feed as it stood at the end of `day` (UTC). */
export function feedAsOf(h: History, current: CorporateAction[], day: string): CorporateAction[] {
  const map = new Map(current.map((e) => [e.id, e]));
  const out: CorporateAction[] = [];
  for (const id of Object.keys(h.events)) {
    const e = eventAsOf(h, map, id, day);
    if (e) out.push(e);
  }
  return out;
}

/** An event's history in W3C PROV terms: what it was derived from, and each version with its time and code. */
export function provenance(h: History, current: Map<string, CorporateAction>, id: string, repo = 'https://github.com/SergoVashakmadze/iomarkets-tech') {
  const eh = h.events[id];
  const rec = current.get(id) ?? eh?.removed?.last;
  if (!eh || !rec) return null;
  return {
    entity: id,
    status: eh.removed ? 'removed' : 'current',
    'prov:wasDerivedFrom': { url: rec.source.url, form: rec.source.form, accession: rec.source.accession, filed: rec.source.filed },
    'prov:generatedAtTime': eh.versions[0].recorded,
    versions: eh.versions.map((v, i) => ({
      version: i + 1,
      'prov:generatedAtTime': v.recorded,
      'prov:wasGeneratedBy': { activity: v.note ? 'manual correction' : 'corpactions/scripts/ingest.ts', code: v.code.startsWith('local') ? v.code : `${repo}/commit/${v.code}` },
      ...(v.note ? { note: v.note } : {}),
      changes: v.changes,
    })),
    ...(eh.gaps?.length ? { gaps: eh.gaps } : {}),
    ...(eh.removed
      ? { 'prov:invalidatedAtTime': eh.removed.recorded, removal: { code: eh.removed.code, ...(eh.removed.note ? { note: eh.removed.note } : {}) } }
      : {}),
  };
}
