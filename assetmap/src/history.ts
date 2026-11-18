// As-of records for the Tokenized Asset Map (enterprise plan, module M3; HANDOVER section 17): every version of every
// entry, when the map first published it, which commit did, and what changed. Same mechanism as the corporate actions
// feed (corpactions/src/history.ts). Built from git by scripts/backfill-history.ts and kept up by
// scripts/record-history.ts after each signed change; tests/assetmap-history.test.ts fails when it falls behind.

import { eventAsOf, feedAsOf, type History } from '../../corpactions/src/history.ts';
import type { Entry } from './types.ts';

export const ASSET_MAP_HISTORY_FORMAT = 'iomarkets.asset-map-history.v1';
/** The first day the map was published. */
export const MAP_START = '2026-10-29';

export const mapAsOf = (h: History<Entry>, current: Entry[], day: string) => feedAsOf(h, current, day);
export const entryAsOf = (h: History<Entry>, current: Entry[], id: string, day: string) => eventAsOf(h, new Map(current.map((e) => [e.id, e])), id, day);

/** An entry's versions in W3C PROV terms: the issuer sources it was read from, and each version's time and commit. */
export function entryProvenance(h: History<Entry>, current: Entry[], id: string, repo = 'https://github.com/SergoVashakmadze/iomarkets-tech') {
  const eh = h.events[id];
  const rec = current.find((e) => e.id === id) ?? eh?.removed?.last;
  if (!eh || !rec) return null;
  return {
    entity: id,
    status: eh.removed ? 'removed' : 'current',
    'prov:wasDerivedFrom': rec.sources.map((s) => ({ url: s.url, publisher: s.publisher, kind: s.kind, checked: s.checked })),
    'prov:generatedAtTime': eh.versions[0].recorded,
    versions: eh.versions.map((v, i) => ({
      version: i + 1,
      'prov:generatedAtTime': v.recorded,
      'prov:wasGeneratedBy': { activity: v.note ?? 'Asset Map update', code: v.code.startsWith('local') ? v.code : `${repo}/commit/${v.code}` },
      // Signature changes are bookkeeping, not facts: they are left out of what a reader sees.
      changes: v.changes ? v.changes.filter((c) => !c.path.startsWith('attestations')) : null,
    })),
    ...(eh.removed ? { 'prov:invalidatedAtTime': eh.removed.recorded, removal: { code: eh.removed.code, ...(eh.removed.note ? { note: eh.removed.note } : {}) } } : {}),
  };
}
