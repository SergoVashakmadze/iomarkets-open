// Events as an iCalendar file (RFC 5545): one all-day entry per day that matters to a holder (a
// dividend's ex-date, the record date, the payment date, the day a split or merger takes effect), so
// holdings' corporate actions show up in any calendar app. The same file is the page's download and,
// filtered by URL, the calendar subscription at /api/corporate-actions/calendar (calendarUrl).

import { describe } from './describe.ts';
import { EVENT_NAMES, type CorporateAction, type EventType } from './types.ts';

const ORIGIN = 'https://iomarkets.tech';
/** Where calendar apps subscribe. Its query string is the only one the site's middleware keeps. */
export const CALENDAR_PATH = '/api/corporate-actions/calendar';

const KINDS: [keyof CorporateAction['dates'], string][] = [
  ['ex', 'ex-date'],
  ['record', 'record date'],
  ['pay', 'pay date'],
  ['effective', 'effective'],
];

/** Escape a TEXT value (RFC 5545 3.3.11): backslash, semicolon, comma and line breaks. */
export const icsText = (s: string) =>
  s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r\n|\r|\n/g, '\\n');

/** Fold a content line at 75 octets (RFC 5545 3.1), never inside a UTF-8 character. */
export function fold(line: string): string {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;
  const out: string[] = [];
  let cur = '';
  let n = 0;
  for (const ch of line) {
    const len = enc.encode(ch).length;
    // The first line holds 75 octets; each continuation starts with a space, so 74 more.
    if (n + len > (out.length ? 74 : 75)) {
      out.push(cur);
      cur = '';
      n = 0;
    }
    cur += ch;
    n += len;
  }
  out.push(cur);
  return out.join('\r\n ');
}

const day = (d: string) => d.replace(/-/g, '');
const nextDay = (d: string) => {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + 1);
  return day(t.toISOString().slice(0, 10));
};

/** What happens, in a calendar entry's few words: "SNDK stock split 8:1", "POOL cash dividend $1.30". */
export function headline(e: CorporateAction): string {
  const who = e.company.ticker ?? e.company.name;
  if (e.type === 'dividend') return `${who} cash dividend $${e.cash!.amount}`;
  if (e.type === 'split' || e.type === 'reverse-split') return `${who} ${e.type === 'split' ? 'stock split' : 'reverse split'} ${e.ratio!.new}:${e.ratio!.old}`;
  return e.acquirer ? `${who} acquired by ${e.acquirer}` : `${who} merger`;
}

/** The event on iomarkets.tech: the page opens with a search for the company and scrolls to it. */
export const eventUrl = (e: CorporateAction) =>
  `${ORIGIN}/corporate-actions#for=${encodeURIComponent(e.company.ticker ?? e.company.cik)}&event=${encodeURIComponent(e.id)}`;

/** One entry per day, naming every date the event has that day: "(ex-date, record date)". */
function entries(e: CorporateAction): { date: string; kind: string; labels: string[] }[] {
  const out: { date: string; kind: string; labels: string[] }[] = [];
  for (const [k, label] of KINDS) {
    const d = e.dates[k];
    // Only a dividend has an ex-date of its own: a split's is the day it takes effect.
    if (!d || (k === 'ex' && e.type !== 'dividend')) continue;
    const same = out.find((x) => x.date === d);
    if (same) same.labels.push(label);
    else out.push({ date: d, kind: k, labels: [label] });
  }
  return out;
}

export type IcsOptions = {
  /** DTSTAMP of every entry. The feed's update time keeps the file the same until the feed changes. */
  stamp?: Date;
  /** The calendar's name in the calendar app. */
  name?: string;
};

export function toIcs(events: CorporateAction[], opts: IcsOptions = {}): string {
  const dtstamp = (opts.stamp ?? new Date()).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const name = opts.name ?? 'Corporate actions (IoMarkets.tech)';
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//IoMarkets//Corporate actions feed//EN',
    'CALSCALE:GREGORIAN',
    // No METHOD: a subscription is not an iTIP message (RFC 5546 would then ask for an ORGANIZER on every entry).
    `NAME:${icsText(name)}`,
    `X-WR-CALNAME:${icsText(name)}`,
    `X-WR-CALDESC:${icsText('Dividends, splits and mergers of US-listed companies, from their own SEC filings. Free, from iomarkets.tech. Not investment advice: check the filing.')}`,
    // The feed is refreshed once a weekday: asking twice a day is plenty (RFC 7986, and Outlook's own name for it).
    'REFRESH-INTERVAL;VALUE=DURATION:PT12H',
    'X-PUBLISHED-TTL:PT12H',
  ];
  for (const e of events) {
    for (const { date, kind, labels } of entries(e)) {
      lines.push(
        'BEGIN:VEVENT',
        `UID:${e.id}-${kind}@iomarkets.tech`,
        `DTSTAMP:${dtstamp}`,
        `DTSTART;VALUE=DATE:${day(date)}`,
        `DTEND;VALUE=DATE:${nextDay(date)}`,
        `SUMMARY:${icsText(`${headline(e)} (${labels.join(', ')})`)}`,
        `DESCRIPTION:${icsText([describe(e), `From the filing: "${e.source.quote}"`, `On iomarkets.tech: ${eventUrl(e)}`, `SEC ${e.source.form}, filed ${e.source.filed}: ${e.source.url}`].join('\n\n'))}`,
        `URL:${eventUrl(e)}`,
        `CATEGORIES:${icsText(EVENT_NAMES[e.type])}`,
        'TRANSP:TRANSPARENT',
        'END:VEVENT',
      );
    }
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}

export type CalendarFilter = { holdings?: string[]; types?: EventType[] };

const ALL_TYPES: EventType[] = ['dividend', 'split', 'reverse-split', 'merger'];

/**
 * The subscription address for these holdings and kinds of event, as https://…; swap the scheme for
 * webcal:// to have the calendar app open it. No holdings: every company. Every kind: no types.
 */
export function calendarUrl(f: CalendarFilter = {}, origin = ORIGIN): string {
  const holdings = [...new Set((f.holdings ?? []).map((h) => h.trim().toUpperCase()).filter(Boolean))];
  const types = ALL_TYPES.filter((t) => f.types?.includes(t));
  const q = [
    holdings.length ? `holdings=${holdings.map(encodeURIComponent).join(',')}` : '',
    types.length && types.length < ALL_TYPES.length ? `types=${types.join(',')}` : '',
  ].filter(Boolean);
  return `${origin}${CALENDAR_PATH}${q.length ? `?${q.join('&')}` : ''}`;
}

export const webcalUrl = (https: string) => https.replace(/^https?:\/\//, 'webcal://');

/** The calendar's name for a filter: "Corporate actions: SNDK, POOL (IoMarkets.tech)". */
export function calendarName(f: CalendarFilter): string {
  const h = f.holdings ?? [];
  const who = h.length ? (h.length > 4 ? `${h.slice(0, 4).join(', ')} and ${h.length - 4} more` : h.join(', ')) : '';
  return `Corporate actions${who ? `: ${who}` : ''} (IoMarkets.tech)`;
}
