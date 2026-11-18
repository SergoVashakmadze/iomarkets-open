// The corporate actions feed: dividends, splits, reverse splits and mergers of US-listed
// companies, read from their own SEC EDGAR filings (edgar.ts, extract.ts), each also written
// as an ISO 20022 seev.031 notification (seev031.ts) and keyed by FIGI, so a tokenized
// version of the security in the Asset Map can be found. Used by the /corporate-actions page,
// GET/POST /api/corporate-actions, the calendar subscription (ics.ts) and the MCP tools list_corporate_actions,
// get_corporate_action and holdings_calendar. Refreshed daily by scripts/ingest.ts.

import data from '../data/events.json' with { type: 'json' };
import meta from '../data/meta.json' with { type: 'json' };
import history from '../data/history.json' with { type: 'json' };
import { eventAsOf, FEED_START, feedAsOf, provenance, type History } from './history.ts';
import type { CorporateAction } from './types.ts';

export const EVENTS = data as unknown as CorporateAction[];
export const FEED_META = meta as { updated: string; from: string; to: string };

export { keyDate, parseQuery, query, weekOf, KEEP_DAYS, type Query } from './query.ts';
export { describe, eventForApi, tokenEffect, tokenizedVersions } from './describe.ts';
export { eventRef, toSeev031 } from './seev031.ts';
export { CALENDAR_PATH, calendarName, calendarUrl, eventUrl, toIcs, webcalUrl, type CalendarFilter } from './ics.ts';
export { EVENT_CODES, EVENT_NAMES, type CorporateAction, type EventType } from './types.ts';

export const eventById = (id: string) => EVENTS.find((e) => e.id === id);

// As-of records (history.ts): what the feed showed on a past day, and how each event changed.
export const HISTORY = history as unknown as History;
const CURRENT = new Map(EVENTS.map((e) => [e.id, e]));
export { FEED_START };
/** Checks an "as of" day: a YYYY-MM-DD from the feed's first day to today. */
export function checkAsOf(day: unknown, today = new Date().toISOString().slice(0, 10)): string | { error: string } {
  if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return { error: 'asOf is a day, YYYY-MM-DD.' };
  if (day < FEED_START) return { error: `The feed started on ${FEED_START}; nothing is known as of an earlier day.` };
  if (day > today) return { error: 'asOf cannot be in the future.' };
  return day;
}
export const eventsAsOf = (day: string) => feedAsOf(HISTORY, EVENTS, day);
export const eventByIdAsOf = (id: string, day: string) => eventAsOf(HISTORY, CURRENT, id, day);
export const eventHistory = (id: string) => provenance(HISTORY, CURRENT, id);

/**
 * Private deployment only (deploy/private/bundle.ts): swaps in a newer feed from a verified, signed data bundle, in
 * place, so every route and MCP tool that holds these objects sees it.
 */
export function replaceFeed(events: CorporateAction[], meta: { updated: string; from: string; to: string }, history: History) {
  EVENTS.splice(0, EVENTS.length, ...events);
  Object.assign(FEED_META, meta);
  HISTORY.format = history.format;
  for (const k of Object.keys(HISTORY.events)) delete HISTORY.events[k];
  Object.assign(HISTORY.events, history.events);
  CURRENT.clear();
  for (const e of EVENTS) CURRENT.set(e.id, e);
}
