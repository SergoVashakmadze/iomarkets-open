// Reading corporate actions out of a filing's text. Precision over recall: an event goes in
// only when the filing states every fact it needs (a dividend's amount, record and payment
// dates; a split's ratio and date; a merger's terms and closing date). Anything vaguer is
// left out rather than guessed. Each event keeps the sentences it came from.
// tests/corpactions-extract.test.ts runs this on sentences from real filings.

import { addDays, clip, DATE, dateAfter, dollars, numberWord, parseDate, sentences } from './text.ts';
import type { Company, CorporateAction, EventType, Ratio } from './types.ts';

export type Filing = {
  company: Company;
  /** Every ticker EDGAR lists for the filer, common stock usually first. For a 6-K, only those on a US exchange (edgar.ts). */
  tickers: string[];
  form: string;
  accession: string;
  filed: string;
  url: string;
  /** The 8-K items the filing reports, e.g. ["2.01", "3.01", "9.01"]. None for a 6-K. */
  items: string[];
  text: string;
};

const mentions = (s: string, w: RegExp) => w.test(s);
export const PREFERRED = /\bpreferred\b|\bseries [a-z]\b|\bdepositary shares\b/i;
export const COMMON = /\bcommon\b|\bclass [ab] (?:shares|stock)\b|\bordinary shares\b/i;

function eventId(type: EventType, cik: string, date: string) {
  return `${type}-${cik}-${date}`;
}

/** The ticker the release itself gives ("(NYSE: PVH)"), if EDGAR lists it, else EDGAR's first. */
function tickerOf(f: Filing): string | undefined {
  const m = /\((?:NYSE|NASDAQ|Nasdaq|NYSE American|NYSE Arca|Cboe|NASDAQ\s?GS|Nasdaq\s?GS)\s*:\s*([A-Z][A-Z.\-]{0,6})/.exec(f.text);
  if (m && f.tickers.includes(m[1])) return m[1];
  return f.tickers[0];
}

function base(f: Filing, type: EventType, key: string, quote: string, anchor?: RegExp): Pick<CorporateAction, 'id' | 'type' | 'company' | 'source'> {
  const ticker = tickerOf(f);
  return {
    id: eventId(type, f.company.cik, key),
    type,
    company: { ...f.company, ...(ticker ? { ticker } : {}) },
    source: { url: f.url, form: f.form, accession: f.accession, filed: f.filed, quote: anchor ? clip(quote, anchor) : quote },
  };
}

// "compared to a cash dividend of $0.37 per share declared in the prior quarter": not this one.
export const COMPARED = /(?:compared (?:to|with)|\bfrom\b|\bprior\b|\bprevious(?:ly)?\b|\blast\b|\bversus\b|\bvs\.?|\bup\b|\bhigher than\b|\bover\b)[^$]{0,45}$/i;

// ---- dividends -------------------------------------------------------------------------

const FREQ: [RegExp, CorporateAction['frequency']][] = [
  [/\bspecial\b|\bextra\b|\bone-time\b/i, 'special'],
  [/\bmonthly\b/i, 'monthly'],
  [/\bquarterly\b/i, 'quarterly'],
  [/\bsemi-?annual\b|\binterim\b|\bfinal\b/i, 'semi-annual'],
  [/\bannual\b/i, 'annual'],
];

/** The per-share amount for the common stock in a sentence that may also price preferred stock. */
function commonAmount(s: string): string | undefined {
  const amounts = [...s.matchAll(/(\$\s?\d{1,6}(?:\.\d+)?|\d+(?:\.\d+)?\s+cents?)\s+(?:per|a|for each)\s+(?:common\s+|ordinary\s+|outstanding\s+)?share/gi)].filter(
    (m) =>
      !/^[^.]{0,40}(annualized|annual basis|annual rate|on an annual)/i.test(s.slice(m.index! + m[0].length)) &&
      !COMPARED.test(s.slice(Math.max(0, m.index! - 60), m.index!)),
  );
  if (!amounts.length) return undefined;
  if (!mentions(s, PREFERRED)) return dollars(amounts[0][1]);
  const near = (re: RegExp, at: number) => Math.min(...[...s.matchAll(new RegExp(re.source, 'gi'))].map((x) => Math.abs(x.index! - at)), Infinity);
  const best = amounts
    .map((m) => ({ m, c: near(COMMON, m.index!), p: near(PREFERRED, m.index!) }))
    .filter((x) => x.c < x.p)
    .sort((a, b) => a.c - b.c)[0];
  return best ? dollars(best.m[1]) : undefined;
}

const DECLARED = /\b(?:declare[ds]?|approved|authorized)\b/i;

function dividends(f: Filing, ss: string[]): CorporateAction[] {
  const out: CorporateAction[] = [];
  for (let i = 0; i < ss.length; i++) {
    const s = ss[i];
    if (!DECLARED.test(s) || !/\bdividends?\b/i.test(s)) continue;
    if (/\bstock dividend\b|\bdividend (?:payable )?in (?:the form of )?(?:shares|stock)\b|\bin-kind\b/i.test(s)) continue;
    if (mentions(s, PREFERRED) && !mentions(s, COMMON)) continue;
    const amount = commonAmount(s);
    if (!amount || Number(amount) <= 0) continue;
    // The payment and record dates are in this sentence or the next two, up to a sentence about preferred stock only.
    const win = [s];
    for (const n of ss.slice(i + 1, i + 4)) {
      if (mentions(n, PREFERRED) && !mentions(n, COMMON)) break;
      if (DECLARED.test(n) && /\bdividends?\b/i.test(n) && commonAmount(n)) break;
      win.push(n);
    }
    const w = win.join(' ');
    const pay = dateAfter(w, /\b(?:payable|to be paid|will be paid|paid|payment date)\b(?:\s+(?:on|or about|on or about|beginning))?/, f.filed, 50, /record/);
    const record = dateAfter(w, /\b(?:of record|record date|record holders)\b/, f.filed, 70, /payable|paid\b/);
    if (!pay || !record || record > pay) continue;
    if (pay < addDays(f.filed, -5) || pay > addDays(f.filed, 400)) continue;
    const stated = dateAfter(w, /\bex-dividend date\b/, f.filed, 30);
    const frequency = FREQ.find(([re]) => re.test(s))?.[1] ?? 'other';
    // Quote up to the sentence that completes the dates, not the paragraph after.
    const upto = win.findIndex((_, k) => dateAfter(win.slice(0, k + 1).join(' '), /\b(?:of record|record date|record holders)\b/, f.filed, 70, /payable|paid\b/) && dateAfter(win.slice(0, k + 1).join(' '), /\b(?:payable|to be paid|will be paid|paid|payment date)\b/, f.filed, 50, /record/));
    const e: CorporateAction = {
      ...base(f, 'dividend', pay, win.slice(0, upto + 1).join(' '), DECLARED),
      dates: { announced: f.filed, record, ex: stated ?? record, pay },
      ...(stated ? {} : { exDateRule: true }),
      cash: { amount, currency: 'USD' },
      frequency,
    };
    if (frequency === 'special') e.id = `${e.id}-special`;
    if (!out.some((x) => x.id === e.id)) out.push(e);
  }
  return out;
}

// ---- splits ----------------------------------------------------------------------------

const RATIO_WORD = String.raw`(\d{1,4}|(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?:-(?:one|two|three|four|five|six|seven|eight|nine))?|one hundred)`;

/** Shares after : shares before, from "1-for-10", "one-for-ten", "1:35", "three (3) for one (1)". */
export function splitRatio(s: string): Ratio | undefined {
  const digits = /\b(\d{1,4})\s*-?\s*for\s*-?\s*(\d{1,4})\b/i.exec(s) ?? /\(\s*(\d{1,4})\s*:\s*(\d{1,4})\s*\)/.exec(s);
  const words = new RegExp(`\\b${RATIO_WORD}\\s*(?:\\(\\d+\\)\\s*)?-?\\s*for\\s*-?\\s*${RATIO_WORD}\\b`, 'i').exec(s);
  const m = digits ?? words;
  if (!m) return undefined;
  const a = numberWord(m[1]), b = numberWord(m[2]);
  if (!a || !b || a === b) return undefined;
  // "1-for-10" means 1 new share for 10 old ones.
  return { new: a, old: b };
}

export const NOT_YET = /\bpropos|\bseek(?:s|ing)?\b|\bintends? to\b|\bmay effect\b|\bat the discretion\b|\brange of\b|\bwithin a range\b|\bproxy\b|\bsubject to (?:stockholder|shareholder) approval\b|\bin the event\b|\badjust(?:ed|ment)? for\b|\bif approved\b|\bto approve\b|\bwould\b/i;

function splits(f: Filing, ss: string[]): CorporateAction[] {
  for (let i = 0; i < ss.length; i++) {
    const s = ss[i];
    if (!/\b(?:stock|share) split\b|\bsplit of (?:its|the company's)\b/i.test(s)) continue;
    if (NOT_YET.test(s)) continue;
    if (mentions(s, PREFERRED) && !mentions(s, COMMON)) continue;
    const ratio = splitRatio(s);
    if (!ratio) continue;
    const reverse = /\breverse\b/i.test(s);
    if (reverse !== ratio.new < ratio.old) continue;
    const w = [s, ...ss.slice(i + 1, i + 3).filter((n) => !NOT_YET.test(n))].join(' ');
    const adjusted = dateAfter(w, /\bsplit-adjusted basis\b/, f.filed, 60);
    const effective = dateAfter(w, /\b(?:effective|become effective|became effective|will be effective|effective time|take effect|went into effect)\b/, f.filed, 80);
    const pay = reverse ? undefined : dateAfter(w, /\b(?:distributed|payable|paid|distribution date)\b(?:\s+(?:on|or about|on or about))?/, f.filed, 50, /record/);
    const record = dateAfter(w, /\b(?:of record|record date)\b/, f.filed, 70, /payable|paid\b|distributed/);
    const when = effective ?? adjusted ?? pay;
    if (!when || when < addDays(f.filed, -10) || when > addDays(f.filed, 180)) continue;
    const type: EventType = reverse ? 'reverse-split' : 'split';
    return [
      {
        ...base(f, type, when, w, /split/i),
        dates: { announced: f.filed, effective: when, ...(adjusted ? { ex: adjusted } : {}), ...(record ? { record } : {}), ...(pay ? { pay } : {}) },
        ratio,
      },
    ];
  }
  return [];
}

// ---- mergers ---------------------------------------------------------------------------

/** The closing date: a date in a sentence about completing or closing, but not "dated" (the agreement's date). */
function closingDate(f: Filing, ss: string[]): { date: string; idx: number } | undefined {
  for (let i = 0; i < ss.length; i++) {
    const s = ss[i];
    if (!/\b(?:completed|consummated|closing date|became effective|effective time)\b/i.test(s) || /\bwill\b|\bexpected\b/i.test(s)) continue;
    for (const m of s.matchAll(new RegExp(DATE, 'g'))) {
      if (/\bdated(?: as of)?\s*$/i.test(s.slice(Math.max(0, m.index! - 15), m.index!))) continue;
      const d = parseDate(m[0], f.filed);
      if (d && d >= addDays(f.filed, -10) && d <= addDays(f.filed, 3)) return { date: d, idx: i };
    }
  }
  return undefined;
}

export const CASH_TERMS = /\bright to receive\b[^;]{0,80}?(?:\$\s?(\d{1,6}(?:,\d{3})*(?:\.\d+)?)(?:\s+per share)?\s+in cash|an amount in cash(?: equal to)?\s+\$\s?(\d{1,6}(?:\.\d+)?))/i;
export const STOCK_TERMS = /\bright to receive\b[^;$]{0,80}?\b(\d+(?:\.\d+)?)\s+(?:fully paid[^,]*,\s*)?(?:validly issued\s+)?(?:shares?|of a share)\s+of\b/i;

function mergers(f: Filing, ss: string[]): CorporateAction[] {
  // The company being acquired reports the closing (2.01) with its delisting (3.01) or change in control (5.01).
  if (!f.items.includes('2.01') || !(f.items.includes('3.01') || f.items.includes('5.01'))) return [];
  const closing = closingDate(f, ss);
  if (!closing) return [];
  // The terms for the company's own common stock: the first sentence that states them.
  const termsIdx = ss.findIndex((s) => COMMON.test(s) && !/\boption|\bwarrant|\brestricted stock unit|\bRSU\b/i.test(s.slice(0, s.search(/right to receive/i) + 1)) && (CASH_TERMS.test(s) || STOCK_TERMS.test(s)));
  if (termsIdx < 0) return [];
  const terms = ss[termsIdx];
  if (/\belect(?:ion|ed|s)?\b|\bat the option of\b/i.test(terms)) return []; // cash-or-stock elections have options this feed doesn't fill in
  const c = CASH_TERMS.exec(terms);
  const cash = c ? (c[1] ?? c[2]).replace(/,/g, '') : undefined;
  const st = STOCK_TERMS.exec(terms);
  const per = st ? Number(st[1]) : undefined;
  const around = ss.slice(Math.max(0, closing.idx - 2), closing.idx + 3).join(' ');
  const before = ss.slice(0, closing.idx + 3).join(' ');
  const acq = [
    // "On October 19, 2026 (the "Closing Date"), Prysmian S.p.A., a company organized under ... ("Buyer"), completed the previously announced acquisition of"
    /\b(?:Closing Date\s*"?\s*\)\s*,|On\s+[A-Z][a-z]+\.?\s+\d{1,2}\s*,\s*\d{4}\s*,)\s*([A-Z][A-Za-z0-9&.,' -]{2,80}?)(?:\s*\(f\/k\/a[^)]*\))?,\s*(?:an?|the)\s+[^"]{0,120}?\(\s*(?:the\s*)?"[^"]{1,30}"\s*\)\s*,?\s*completed\s+(?:the|its)\s+(?:previously announced\s+)?(?:acquisition|merger)\b/.exec(before)?.[1],
    /\bwholly[- ]owned subsidiary of ([A-Z][A-Za-z0-9&.,' -]{2,80}?)(?:\s*\(|,|\.|;| and\b)/.exec(around)?.[1],
    /\b(?:by and among|among)\b[\s\S]{0,200}?\),\s*([A-Z][A-Za-z0-9&.' -]{2,80}?(?:,\s*(?:Inc|LLC|L\.P|Ltd|Corp|Co)\.?)?),\s*an?\s+[A-Z][a-z]+\s+(?:corporation|limited liability company|limited partnership|company)\s*\(\s*(?:the\s*)?"\s*Parent/.exec(before)?.[1],
  ]
    .map((x) => x?.trim())
    // Not a defined term ("Parent", "Buyer", "SKYD"): those name the role, not the company.
    .find((x) => x && !/^(?:the|its|Parent|Merger Sub|Buyer|Purchaser|Acquir[eo]r)\b/i.test(x) && !/^[A-Z]{2,6}$/.test(x));
  const quote = closing.idx === termsIdx ? clip(terms, /right to receive/i, 700) : `${clip(ss[closing.idx], new RegExp(DATE), 300)} ${clip(terms, /right to receive/i, 420)}`;
  return [
    {
      ...base(f, 'merger', closing.date, quote),
      dates: { announced: f.filed, effective: closing.date },
      ...(cash ? { cash: { amount: cash, currency: 'USD' as const } } : {}),
      ...(per ? { ratio: { new: per, old: 1 } } : {}),
      ...(acq ? { acquirer: acq } : {}),
    },
  ];
}

/** Every corporate action a filing states in full. */
export function extract(f: Filing): CorporateAction[] {
  // The feed covers listed companies: a filer with no ticker (a non-traded fund, a co-registrant subsidiary) is left out.
  if (!f.tickers.length) return [];
  const ss = sentences(f.text);
  return [...dividends(f, ss), ...splits(f, ss), ...mergers(f, ss)];
}
