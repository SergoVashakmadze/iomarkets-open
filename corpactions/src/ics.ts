// Events as an iCalendar file (RFC 5545): one all-day entry per ex-date, record date, payment
// date or effective date, so holdings' corporate actions show up in any calendar app.

import { describe } from './describe.ts';
import type { CorporateAction } from './types.ts';

const KINDS: [keyof CorporateAction['dates'], string][] = [
  ['ex', 'ex-date'],
  ['record', 'record date'],
  ['pay', 'payment'],
  ['effective', 'takes effect'],
];

/** Escape TEXT values and fold lines at 75 octets, as RFC 5545 asks. */
const text = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
function fold(line: string): string {
  const bytes = new TextEncoder().encode(line);
  if (bytes.length <= 75) return line;
  const out: string[] = [];
  let cur = '';
  for (const ch of line) {
    if (new TextEncoder().encode(cur + ch).length > (out.length ? 74 : 75)) {
      out.push(cur);
      cur = '';
    }
    cur += ch;
  }
  out.push(cur);
  return out.join('\r\n ');
}

export function toIcs(events: CorporateAction[], stamp = new Date()): string {
  const dtstamp = stamp.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const next = (d: string) => {
    const t = new Date(`${d}T00:00:00Z`);
    t.setUTCDate(t.getUTCDate() + 1);
    return t.toISOString().slice(0, 10).replace(/-/g, '');
  };
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//IoMarkets//Corporate actions feed//EN', 'CALSCALE:GREGORIAN', 'X-WR-CALNAME:Corporate actions (IoMarkets.tech)'];
  for (const e of events) {
    const seen = new Set<string>();
    for (const [k, label] of KINDS) {
      const d = e.dates[k];
      // A split's ex-date is the day it trades split-adjusted: the same day as it takes effect, usually.
      if (!d || seen.has(d) || (k === 'ex' && e.type !== 'dividend')) continue;
      seen.add(d);
      lines.push(
        'BEGIN:VEVENT',
        `UID:${e.id}-${k}@iomarkets.tech`,
        `DTSTAMP:${dtstamp}`,
        `DTSTART;VALUE=DATE:${d.replace(/-/g, '')}`,
        `DTEND;VALUE=DATE:${next(d)}`,
        fold(`SUMMARY:${text(`${e.company.ticker ?? e.company.name} ${label}`)}`),
        fold(`DESCRIPTION:${text(`${describe(e)}\nSource: ${e.source.url}`)}`),
        fold(`URL:${e.source.url}`),
        'TRANSP:TRANSPARENT',
        'END:VEVENT',
      );
    }
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}
