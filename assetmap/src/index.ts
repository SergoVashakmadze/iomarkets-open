// The Tokenized Asset Map: a signed, open list linking securities (FIGI, and ISIN where
// the issuer gives it) to their token contracts, chain by chain. Used by the /asset-map
// page, GET/POST /api/asset-map and the MCP tools check_token_contract,
// list_tokenized_assets, get_tokenized_asset and verify_asset_with_issuer.

import data from '../data/entries.json' with { type: 'json' };
import historyData from '../data/history.json' with { type: 'json' };
import type { History } from '../../corpactions/src/history.ts';
import { entryAsOf, entryProvenance, MAP_START, mapAsOf } from './history.ts';
import type { Entry } from './types.ts';

export const ENTRIES = data as unknown as Entry[];

export { checkContract, normalize, search, type CheckResult, type Verdict } from './check.ts';
export { checkWithIssuer, checkIssuerSignature, stellarCurrencies, type Fetcher, type IssuerCheck } from './issuer.ts';
export { ASSET_MAP_KEYS, canonical, checkAttestations, signEntry, type PublishedKey } from './sign.ts';
export { CHAINS, isChain, type Chain, type Entry, type Security, type Source, type Token } from './types.ts';

export const entryById = (id: string) => ENTRIES.find((e) => e.id === id);

// As-of records (history.ts): the map as it stood on a past day, and each entry's versions.
export const MAP_HISTORY = historyData as unknown as History<Entry>;
export { MAP_START };
export const entriesAsOf = (day: string) => mapAsOf(MAP_HISTORY, ENTRIES, day);
export const entryByIdAsOf = (id: string, day: string) => entryAsOf(MAP_HISTORY, ENTRIES, id, day);
export const entryHistory = (id: string) => entryProvenance(MAP_HISTORY, ENTRIES, id);

/** Private deployment only (deploy/private/bundle.ts): swaps in a newer map from a verified, signed data bundle, in place. */
export function replaceMap(entries: Entry[], history: History<Entry>) {
  ENTRIES.splice(0, ENTRIES.length, ...entries);
  MAP_HISTORY.format = history.format;
  for (const k of Object.keys(MAP_HISTORY.events)) delete MAP_HISTORY.events[k];
  Object.assign(MAP_HISTORY.events, history.events);
}
/** Checks an "as of" day: from the map's first day to today. */
export function checkMapAsOf(day: unknown, today = new Date().toISOString().slice(0, 10)): string | { error: string } {
  if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return { error: 'asOf is a day, YYYY-MM-DD.' };
  if (day < MAP_START) return { error: `The map was first published on ${MAP_START}; nothing is known as of an earlier day.` };
  if (day > today) return { error: 'asOf cannot be in the future.' };
  return day;
}
