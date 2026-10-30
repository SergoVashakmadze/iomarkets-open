// Turning a filed document into sentences and reading dates and amounts out of them.

const ENTITIES: Record<string, string> = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"',
  ndash: '-', mdash: '-', hellip: '...', bull: ' ', middot: ' ', reg: '', trade: '', copy: '',
};

/** A filed HTML or text document as plain text: tags gone, entities decoded, quotes and dashes plain, one space between words. */
export function htmlToText(html: string): string {
  return html
    .replace(/^[\s\S]*?<TEXT>/i, '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m)
    .replace(/[\u2018\u2019\u2032]/g, "'")
    .replace(/[\u201c\u201d\u2033]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/[\u00a0\u2000-\u200b\ufeff]/g, ' ')
    .replace(/\s*[\u2022\u25cf\u25e6\u25aa\u25a0\u2023\u2043\u00b7]\s*/g, '. ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Abbreviations a sentence doesn't end at.
// A company suffix still ends a sentence when a new one plainly starts after it ("...Merger Sub, Inc. On October 26, ...").
const ABBREV = /\b(Inc|Corp|Co|Ltd|No|Nos|Mr|Ms|Mrs|Dr|St|Jr|Sr|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec|vs|approx|U\.S|N\.A|L\.P|L\.L\.C|p\.m|a\.m|i\.e|e\.g)\.(?=\s)(?!\s+(?:On|The|This|Each|At|In|As|Pursuant|Under|Effective|Following)\b)/g;

export function sentences(text: string): string[] {
  return text
    .replace(ABBREV, '$1\u0000')
    .split(/(?<=[.!?])\s+(?=["(]?[A-Z0-9])/)
    .map((s) => s.replace(/\u0000/g, '.').trim())
    .filter(Boolean);
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
/** A date as filings write it: "January 4, 2027", "Jan. 4, 2027", "December 18th, 2026", "December 1" (year inferred). */
export const DATE = String.raw`(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan\.?|Feb\.?|Mar\.?|Apr\.?|Jun\.?|Jul\.?|Aug\.?|Sept?\.?|Oct\.?|Nov\.?|Dec\.?)\s+\d{1,2}(?:st|nd|rd|th)?(?:\s*,\s*\d{4}|\s+\d{4})?`;

const iso = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const real = (y: number, m: number, d: number) => {
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
};

/**
 * One date matched by DATE, as YYYY-MM-DD. With no year, the first such day on or after a month
 * before the filing (a release in December saying "payable January 4" means next year).
 */
export function parseDate(s: string, filed: string): string | undefined {
  const m = /^([A-Za-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:\s*,?\s*(\d{4}))?$/.exec(s.trim());
  if (!m) return undefined;
  const mon = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()) + 1;
  const day = Number(m[2]);
  if (!mon) return undefined;
  let year = m[3] ? Number(m[3]) : Number(filed.slice(0, 4));
  if (!m[3] && iso(year, mon, day) < addDays(filed, -31)) year += 1;
  return real(year, mon, day) ? iso(year, mon, day) : undefined;
}

export function addDays(d: string, n: number): string {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}

/**
 * The first date after a phrase, within `gap` characters of it and with no `avoid` word between,
 * e.g. dateAfter(s, /payable/, filed, 50, /record/) skips "payable to holders of record on <date>".
 */
export function dateAfter(s: string, phrase: RegExp, filed: string, gap = 60, avoid?: RegExp): string | undefined {
  const between = avoid ? `(?:(?!${avoid.source})[^.;]){0,${gap}}?` : `[^.;]{0,${gap}}?`;
  const re = new RegExp(`(?:${phrase.source})${between}(${DATE})`, 'i');
  const m = re.exec(s.replace(/\b([ap])\.m\./gi, '$1m'));
  return m ? parseDate(m[1], filed) : undefined;
}

const WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
  thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100,
};

/** "35", "thirty-five", "one hundred" as a number. */
export function numberWord(w: string): number | undefined {
  const s = w.toLowerCase().trim();
  if (/^\d+$/.test(s)) return Number(s);
  if (s === 'one hundred' || s === 'a hundred') return 100;
  const parts = s.split(/[-\s]+/);
  if (parts.length === 1) return WORDS[parts[0]];
  if (parts.length === 2 && WORDS[parts[0]] >= 20 && WORDS[parts[0]] % 10 === 0 && WORDS[parts[1]] < 10) return WORDS[parts[0]] + WORDS[parts[1]];
  return undefined;
}

/** A dollar amount: "$0.155", "$1.30", "15 cents". As a decimal string, or undefined. */
export function dollars(s: string): string | undefined {
  const d = /\$\s?(\d{1,6}(?:,\d{3})*(?:\.\d+)?)/.exec(s);
  if (d) return d[1].replace(/,/g, '');
  const c = /(\d+(?:\.\d+)?)\s+cents?\b/i.exec(s);
  if (c) return (Number(c[1]) / 100).toFixed(Math.max(2, (c[1].split('.')[1]?.length ?? 0) + 2)).replace(/(\.\d{2}\d*?)0+$/, '$1');
  return undefined;
}

/** At most `max` characters of a quote, starting a little before its anchor word. */
export function clip(s: string, anchor: RegExp, max = 600): string {
  if (s.length <= max) return s;
  const at = Math.max(0, s.search(anchor));
  let start = Math.max(0, at - Math.min(160, Math.floor(max / 3)));
  if (start > 0) start = s.indexOf(' ', start) + 1;
  const out = s.slice(start, start + max);
  return `${start > 0 ? '...' : ''}${out.length < s.length - start ? out.replace(/\s+\S*$/, '') + '...' : out}`;
}
