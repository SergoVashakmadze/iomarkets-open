// The corporate actions feed: dividends, splits, reverse splits and mergers of US-listed
// companies, read from their own SEC EDGAR filings (edgar.ts, extract.ts), each also written
// as an ISO 20022 seev.031 notification (seev031.ts) and keyed by FIGI, so a tokenized
// version of the security in the Asset Map can be found. Used by the /corporate-actions page,
// GET/POST /api/corporate-actions, the calendar subscription (ics.ts) and the MCP tools list_corporate_actions,
// get_corporate_action and holdings_calendar. Refreshed daily by scripts/ingest.ts.

import data from '../data/events.json' with { type: 'json' };
import meta from '../data/meta.json' with { type: 'json' };
import type { CorporateAction } from './types.ts';

export const EVENTS = data as unknown as CorporateAction[];
export const FEED_META = meta as { updated: string; from: string; to: string };

export { keyDate, parseQuery, query, weekOf, KEEP_DAYS, type Query } from './query.ts';
export { describe, eventForApi, tokenEffect, tokenizedVersions } from './describe.ts';
export { eventRef, toSeev031 } from './seev031.ts';
export { CALENDAR_PATH, calendarName, calendarUrl, eventUrl, toIcs, webcalUrl, type CalendarFilter } from './ics.ts';
export { EVENT_CODES, EVENT_NAMES, type CorporateAction, type EventType } from './types.ts';

export const eventById = (id: string) => EVENTS.find((e) => e.id === id);
