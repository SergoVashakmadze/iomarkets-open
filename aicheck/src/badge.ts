// A small embeddable SVG badge, in the flat two-part style: a label on the left, a value on the right.
// Pure: the function in functions/api/badge/accuracy.svg.ts reads the scoreboard and passes the numbers in.
// Every string that reaches the SVG is escaped, and the subject is never echoed unless it passed SUBJECT_RE.
import type { ResultRow } from './scoreboard.ts';
import { tally } from './scoreboard.ts';

export const SUBJECT_RE = /^[A-Za-z0-9][A-Za-z0-9 .\-]{0,29}$/;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
/** Rough Verdana 11px width: good enough to size the two halves. */
const width = (s: string) => Math.round(s.length * 6.4 + 12);

export type Tone = 'good' | 'ok' | 'bad' | 'neutral';
const COLOR: Record<Tone, string> = { good: '#2e8b57', ok: '#b8860b', bad: '#b3412e', neutral: '#6b7280' };

export function badgeSvg(label: string, value: string, tone: Tone): string {
  const lw = width(label);
  const vw = width(value);
  const w = lw + vw;
  const title = esc(`${label}: ${value}`);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="20" role="img" aria-label="${title}">` +
    `<title>${title}</title>` +
    `<clipPath id="r"><rect width="${w}" height="20" rx="3"/></clipPath>` +
    `<g clip-path="url(#r)"><rect width="${lw}" height="20" fill="#24212e"/><rect x="${lw}" width="${vw}" height="20" fill="${COLOR[tone]}"/></g>` +
    `<g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">` +
    `<text x="${lw / 2}" y="14">${esc(label)}</text><text x="${lw + vw / 2}" y="14">${esc(value)}</text></g></svg>`
  );
}

export const NOT_MEASURED = 'not yet measured';

/**
 * The badge for a set of results from one finished week: the share of judged facts the AI engines got right
 * (the scoreboard's accuracy, all engines pooled), or "not yet measured" when no engine answered or nothing was judged.
 */
export function accuracyBadge(rows: ResultRow[], week: string | null, subjectLabel?: string): string {
  const label = subjectLabel ? `AI accuracy · ${subjectLabel}` : 'AI accuracy';
  const t = tally(rows);
  if (!week || t.accuracy === null) return badgeSvg(label, NOT_MEASURED, 'neutral');
  return badgeSvg(label, `${t.accuracy}% right · ${week}`, t.accuracy >= 80 ? 'good' : t.accuracy >= 50 ? 'ok' : 'bad');
}
