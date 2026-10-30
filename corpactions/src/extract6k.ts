// Reading corporate actions out of a foreign private issuer's 6-K (or the press release filed
// with it). Same rule as the 8-K reader (extract.ts): an event goes in only when the filing
// states every fact it needs, and each keeps the sentences it came from. 6-Ks are free-form and
// worldwide, so the reader asks for more before it believes a sentence:
//
// - the amount must name its currency ("US$", "€", "KRW", "pence"); a bare "$" or "cents" counts
//   only when the filing says which dollars it means, or names no market outside the US;
// - the amount and dates must be the ones for the security that trades in the US. If the filing
//   mentions American depositary shares, only an amount per ADS, with dates stated for ADS holders,
//   is read; otherwise the shares must be named on a US exchange ("NYSE: TAC"). ingest() then checks
//   the ticker's OpenFIGI security type agrees (fitsListing below);
// - proposed, recommended, expected and forecast dividends, scrip and other elections, and
//   distributions of capital (share premium, reserves) are left out;
// - splits only for issuers whose shares themselves trade in the US. When the US security is an
//   ADS, a change in the ADS ratio, or a split of the shares that the ratio absorbs, is not the
//   same event for the ADS holder as a split, so neither is read (README, "6-K filings");
// - a merger only when the filer says it was the company acquired, gives its terms per share or
//   per ADS with their currency, and states the date it took effect.
//
// tests/corpactions-6k.test.ts runs this on real 6-K filings (corpactions/fixtures/6-k/).

import { COMMON, COMPARED, NOT_YET, PREFERRED, splitRatio, type Filing } from './extract.ts';
import { addDays, clip, DATE_ANY, dateAfter, numberWord, sentences } from './text.ts';
import type { CorporateAction, EventType } from './types.ts';

const US_EXCHANGE = /\b(?:NYSE(?:\s+American|\s+Arca)?|NASDAQ|Nasdaq(?!\s+(?:Stockholm|Copenhagen|Helsinki|Iceland|Riga|Tallinn|Vilnius|Baltic|Nordic|First North))|New York Stock Exchange|XNYS|XNAS|XASE|Cboe)\b/;
const NON_US_EXCHANGE =
  /\b(?:TSX(?:V|\s+Venture)?|Toronto Stock Exchange|London Stock Exchange|LSE|XLON|Euronext|XAMS|XPAR|XBRU|Oslo|OSE|B[øo]rs|ASX|Australian Securities Exchange|Borsa|Bolsa|BME|Spanish Stock Exchanges|B3|Xetra|Frankfurt Stock Exchange|SIX Swiss|Korea Exchange|KRX|KOSPI|KOSDAQ|Tokyo Stock Exchange|Hong Kong Stock Exchange|Stock Exchange of Hong Kong|HKEX|SEHK|Johannesburg Stock Exchange|JSE|Tel Aviv Stock Exchange|TASE|Nasdaq\s+(?:Stockholm|Copenhagen|Helsinki|Iceland|Riga|Tallinn|Vilnius)|Bombay Stock Exchange|BSE|National Stock Exchange of India|Mexican Stock Exchange|BMV|Taiwan Stock Exchange|TWSE|Singapore Exchange|SGX|Bursa Malaysia|Philippine Stock Exchange|Santiago Stock Exchange)\b/;
const ADS = /\bAmerican Deposit[ao]ry (?:Shares?|Receipts?)\b|\bADSs?\b|\bADRs?\b/;
const ADS_UNIT = /^(?:ADSs?|ADRs?|American Deposit[ao]ry (?:Shares?|Receipts?))$/i;

// ---- money ------------------------------------------------------------------------------

const SYMBOL: [RegExp, string][] = [
  [/^(?:US\$|U\.S\.\s?\$|USD|U\.S\. dollars?|US dollars?)$/i, 'USD'],
  [/^(?:€|EUR|euros?)$/i, 'EUR'],
  [/^(?:£|GBP)$/i, 'GBP'],
  [/^(?:¥|JPY|yen)$/i, 'JPY'],
  [/^(?:KRW|₩|won)$/i, 'KRW'],
  [/^(?:C\$|CAD|CDN\$|Cdn\$|Canadian dollars?)$/i, 'CAD'],
  [/^(?:R\$|BRL)$/i, 'BRL'],
  [/^(?:A\$|AUD)$/i, 'AUD'],
  [/^(?:HK\$|HKD)$/i, 'HKD'],
  [/^(?:NT\$|TWD)$/i, 'TWD'],
  [/^(?:S\$|SGD)$/i, 'SGD'],
  [/^(?:NZ\$|NZD)$/i, 'NZD'],
  [/^(?:RMB|CNY)$/i, 'CNY'],
  [/^(?:CHF|SEK|NOK|DKK|MXN|INR|ILS|ZAR)$/i, ''],
];
const BEFORE = String.raw`US\$|U\.S\.\s?\$|USD|EUR|€|euros?|GBP|£|JPY|¥|KRW|₩|C\$|CAD|CDN\$|Cdn\$|R\$|BRL|A\$|AUD|HK\$|HKD|NT\$|TWD|S\$|SGD|NZ\$|NZD|RMB|CNY|CHF|SEK|NOK|DKK|MXN|INR|ILS|ZAR|\$`;
const AFTER = String.raw`USD|EUR|GBP|JPY|KRW|CAD|BRL|AUD|HKD|TWD|SGD|NZD|CNY|RMB|CHF|SEK|NOK|DKK|MXN|INR|ILS|ZAR|euros?|euro cents|cents?|pence|yen|won|U\.S\. dollars?|US dollars?`;
const NUM = String.raw`\d{1,7}(?:,\d{3})*(?:\.\d+)?`;
/** An amount and what it is per: "US$0.75 per common share", "€ 0.54 per ADR", "0.40 EUR per share", "10.5 pence per ordinary share". */
const PER_UNIT = new RegExp(
  String.raw`(?:(${BEFORE})\s?(${NUM})|(${NUM})\s?(${AFTER})\b)\s*(?:\((?:gross|net)\)\s*)?(?:per|for each|a|/)\s*(?:(?:[A-Z][\w.&'-]*|ordinary|common|outstanding|issued)\s+){0,4}?(shares?|ADSs?|ADRs?|American Deposit[ao]ry (?:Shares?|Receipts?))\b`,
  'g',
);

/** Which currency an amount is in, or undefined when the filing doesn't say. */
function currencyOf(token: string, doc: string): string | undefined {
  const t = token.trim();
  if (t === '$' || /^cents?$/i.test(t)) {
    // A bare dollar sign: the filing's own statement of which dollars ("All currency is expressed in Canadian dollars"), else US
    // dollars when the filing names no market outside the US and no other dollar.
    const said = [...doc.matchAll(/\b(?:amounts?|figures|currency|dollar amounts|monetary amounts)\b[^.]{0,40}?\b(?:expressed|stated|presented|reported|are)\s+in\s+(U\.?S\.? dollars|United States dollars|Canadian dollars)/gi)].map((m) => (/canad/i.test(m[1]) ? 'CAD' : 'USD'));
    if (new Set(said).size === 1) return said[0];
    if (said.length) return undefined;
    if (NON_US_EXCHANGE.test(doc) || /\b(?:C\$|CDN\$|Cdn\$|A\$|HK\$|NT\$|S\$|NZ\$|R\$|Canadian dollars?|Australian dollars?|Hong Kong dollars?|Singapore dollars?|New Taiwan dollars?)/i.test(doc)) return undefined;
    return 'USD';
  }
  if (/^pence$/i.test(t)) return 'GBP';
  if (/^euro cents$/i.test(t)) return 'EUR';
  for (const [re, code] of SYMBOL) if (re.test(t)) return code || t.toUpperCase();
  return undefined;
}

type Amount = { amount: string; currency: string; ads: boolean; at: number; text: string };

/** Every amount per share or per ADS in a sentence, with its currency, skipping comparisons and approximations. */
function amounts(s: string, doc: string): Amount[] {
  const out: Amount[] = [];
  for (const m of s.matchAll(PER_UNIT)) {
    const before = s.slice(Math.max(0, m.index! - 70), m.index!);
    if (COMPARED.test(before.slice(-60)) || /(?:~|\bapproximately|\babout|\bca\.|\baround|\bup to|\bat least|\bequivalent of)\s*$/i.test(before)) continue;
    if (/^[^.]{0,40}(annualized|annual basis|annual rate|on an annual)/i.test(s.slice(m.index! + m[0].length))) continue;
    const token = m[1] ?? m[4];
    const raw = (m[2] ?? m[3]).replace(/,/g, '');
    const currency = currencyOf(token, doc);
    if (!currency) continue;
    const amount = /^(?:cents?|pence|euro cents)$/i.test(token.trim()) ? hundredth(raw) : raw;
    if (!(Number(amount) > 0)) continue;
    out.push({ amount, currency, ads: ADS_UNIT.test(m[5]), at: m.index!, text: m[0] });
  }
  return out;
}

/** "50" cents as "0.50", "10.5" pence as "0.105": the decimal point moved, no floating point. */
function hundredth(raw: string): string {
  const [whole, frac = ''] = raw.split('.');
  const digits = whole.padStart(3, '0') + frac;
  const at = digits.length - frac.length - 2;
  return `${digits.slice(0, at).replace(/^0+(?=\d)/, '')}.${digits.slice(at)}`.replace(/(\.\d{2}\d*?)0+$/, '$1');
}

// ---- the security that trades in the US ------------------------------------------------

type Doc = { f: Filing; ss: string[]; text: string; ads: boolean; usNamed: boolean; nonUs: boolean };

/** The ticker the release gives on a US exchange ("(NYSE: TAC)"), if it is one of the filer's US tickers, else the first. */
function tickerOf(f: Filing): string | undefined {
  for (const m of f.text.matchAll(/\b(?:NYSE(?:\s+American)?|NASDAQ(?:\s?GS|\s?GM|\s?CM)?|Nasdaq(?:\s?GS|\s?GM|\s?CM)?|XNYS|XNAS)\s*:\s*"?([A-Z][A-Z.\-]{0,6})\b/g)) if (f.tickers.includes(m[1])) return m[1];
  return f.tickers[0];
}

function base(d: Doc, type: EventType, key: string, quote: string, anchor: RegExp | undefined, ads: boolean): Pick<CorporateAction, 'id' | 'type' | 'company' | 'source' | 'instrument'> {
  const ticker = tickerOf(d.f);
  return {
    id: `${type}-${d.f.company.cik}-${key}`,
    type,
    company: { ...d.f.company, ...(ticker ? { ticker } : {}) },
    ...(ads ? { instrument: 'ADS' as const } : {}),
    source: { url: d.f.url, form: d.f.form, accession: d.f.accession, filed: d.f.filed, quote: anchor ? clip(quote, anchor) : quote },
  };
}

// ---- dividends --------------------------------------------------------------------------

const DECLARED = /\b(?:declare[ds]?|approved|resolved|authori[sz]ed|determined|decided)\b/i;
const NOT_DECIDED = /\bpropos|\brecommend|\bsubject to\b[^.]{0,60}\bapprov|\bannual general meeting\b|\bAGM\b|\bforecast|\bguidance\b|\bexpected dividend|\bintends? to\b|\bplans? to\b|\bpolicy\b|\banticipated\b|\btarget/i;
const NOT_CASH = /\bscrip\b|\bstock dividend\b|\bdividend (?:payable )?in (?:the form of )?(?:new |additional )?(?:shares|stock)\b|\bin-kind\b|\belect(?:ion)? to receive (?:new |additional )?shares\b|\beither cash or\b|\bcash or (?:the company's |its )?(?:common |ordinary )?shares\b|\bin cash or (?:in )?shares\b/i;
const CAPITAL = /\bshare premium\b|\breturn of capital\b|\bcapital (?:repayment|reduction|distribution)\b|\bin place of (?:the )?dividend\b|\b(?:from|out of) (?:the )?(?:available |distributable )?reserves\b|\breserve for invested unrestricted equity\b/i;
const NOT_FIRM = /\b(?:expected|anticipated|estimated|tentative|indicative|provisional)\s+(?:dividend\s+)?(?:payment|record|ex-dividend|pay)\b|\bexpected to be paid\b|\b(?:is|are) expected to be\b|\bon or around\b|\bto be (?:determined|announced|confirmed)\b|\bin due course\b|\brespectively\b/i;
const PAY = /\b(?:payable|to be paid|will be paid|be paid|paid|payment date|with a payment date of)\b(?:\s+(?:on|or about|on or about|beginning))?/;
const RECORD = /\b(?:of record|record date|record holders|holders on the register)\b/;
const US_EX = /\bex-?(?:dividend\s+)?date\s*(?:for\s+(?:the\s+)?(?:ADSs?|ADRs?|American Deposit[ao]ry \w+)|(?:on\s+(?:the\s+)?)?(?:New York Stock Exchange|NYSE|Nasdaq))|\b(?:US|U\.S\.|NYSE|Nasdaq|ADSs?|ADRs?)\s+ex-?(?:dividend\s+)?date\b/i;

const FREQ6: [RegExp, CorporateAction['frequency']][] = [
  [/\bspecial\b|\bextra(?:ordinary)?\b|\bone-time\b/i, 'special'],
  [/\bmonthly\b/i, 'monthly'],
  [/\bquarterly\b/i, 'quarterly'],
  [/\bsemi-?annual\b|\bhalf[- ]year(?:ly)?\b/i, 'semi-annual'],
  [/\bannual\b/i, 'annual'],
];

function dividends(d: Doc): CorporateAction[] {
  const out: CorporateAction[] = [];
  const { f, ss } = d;
  for (let i = 0; i < ss.length; i++) {
    const s = ss[i];
    if (!DECLARED.test(s) || !/\bdividends?\b/i.test(s)) continue;
    if (NOT_DECIDED.test(s) || NOT_CASH.test(s)) continue;
    if (PREFERRED.test(s.replace(/\bdepositary shares\b/gi, '')) && !COMMON.test(s)) continue;
    // This sentence and the next three (seven when the ADS terms may follow the shares'), up to a sentence about preferred
    // shares only or the next declaration.
    const win = [s];
    for (const n of ss.slice(i + 1, i + (d.ads ? 8 : 4))) {
      if (PREFERRED.test(n.replace(/\bdepositary shares\b/gi, '')) && !COMMON.test(n) && !ADS.test(n)) break;
      if (DECLARED.test(n) && /\bdividends?\b/i.test(n) && amounts(n, d.text).length) break;
      win.push(n);
    }
    const w = win.join(' ');
    if (CAPITAL.test(w) || NOT_CASH.test(w) || NOT_FIRM.test(w)) continue;
    let amount: Amount | undefined;
    let dated: string[];
    if (d.ads) {
      // The US security is the ADS: the amount per ADS, and dates from the sentences that speak of ADS holders.
      const at = win.findIndex((x) => amounts(x, d.text).some((a) => a.ads));
      if (at < 0) continue;
      amount = amounts(win[at], d.text).find((a) => a.ads);
      // The sentences that speak of ADS holders, and one that goes on about the same thing ("It will be paid on ...").
      dated = win.filter((x, k) => k === at || ADS.test(x) || (k === at + 1 && /^(?:It|This|These|They|Such)\b/.test(x)));
      // One sentence giving the shares' dates and the ADSs' ("... for holders of ordinary shares and ... for holders of ADSs"): left out.
      if (dated.some((x) => /\bholders of (?:its |the company's )?(?:ordinary|common) shares\b/i.test(x) && (x.match(new RegExp(DATE_ANY, 'g')) ?? []).length > 1)) continue;
    } else {
      // The shares trade in the US themselves: the amount per share in the declaring sentence.
      if (!d.usNamed) continue;
      // A sentence that also prices preferred shares: only an amount written per common or ordinary share.
      amount = amounts(s, d.text).find((a) => !a.ads && (!PREFERRED.test(s) || /\b(?:common|ordinary)\b/i.test(a.text)));
      dated = win;
    }
    if (!amount) continue;
    // A timetable for two markets ("Euronext NYSE Ex-dividend date ... Payment date ..."): which date is whose is not said in words.
    const after = dated.join(' ').slice(dated.join(' ').indexOf(amount.text) + amount.text.length);
    if (US_EXCHANGE.test(after) && NON_US_EXCHANGE.test(after)) continue;
    const dw = dated.join(' ');
    const pay = dateAfter(dw, PAY, f.filed, 50, /record/, DATE_ANY);
    const record = dateAfter(dw, RECORD, f.filed, 70, /payable|paid\b/, DATE_ANY);
    if (!pay || !record || record > pay) continue;
    if (pay < addDays(f.filed, -5) || pay > addDays(f.filed, 400)) continue;
    // An ex-date only when stated for the US market, or when the filing names no market outside the US; else the T+1 rule.
    const stated = dateAfter(dw, US_EX, f.filed, 40, undefined, DATE_ANY) ?? (d.nonUs ? undefined : dateAfter(dw, /\bex-dividend date\b/, f.filed, 30, undefined, DATE_ANY));
    const frequency = FREQ6.find(([re]) => re.test(s))?.[1] ?? 'other';
    const upto = dated.findIndex((_, k) => {
      const part = dated.slice(0, k + 1).join(' ');
      return dateAfter(part, PAY, f.filed, 50, /record/, DATE_ANY) && dateAfter(part, RECORD, f.filed, 70, /payable|paid\b/, DATE_ANY);
    });
    const quoted = d.ads && !dated.includes(s) ? [s, ...dated.slice(0, upto + 1)] : dated.slice(0, upto + 1);
    const e: CorporateAction = {
      ...base(d, 'dividend', pay, joinQuote(quoted, ss), DECLARED, !!amount.ads),
      dates: { announced: f.filed, record, ex: stated ?? record, pay },
      ...(stated ? {} : { exDateRule: true }),
      cash: { amount: amount.amount, currency: amount.currency },
      frequency,
    };
    if (frequency === 'special') e.id = `${e.id}-special`;
    if (!out.some((x) => x.id === e.id)) out.push(e);
  }
  return out;
}

/** Sentences as one quote, with "..." where the filing has others between them. */
function joinQuote(parts: string[], ss: string[]): string {
  const at = parts.map((p) => ss.indexOf(p));
  return parts.map((p, k) => (k && at[k] !== at[k - 1] + 1 ? `... ${p}` : p)).join(' ');
}

// ---- splits -----------------------------------------------------------------------------

const SPLIT = /\b(?:stock|share) (?:split|consolidation|subdivision)\b|\b(?:reverse|forward) split\b|\bconsolidation of (?:its|the company's|our)\b|\bsubdivision of (?:its|the company's|our)\b/i;
const NOT_YET_6K = /\bexpects? to\b|\bplans? to\b|\bintends? to\b|\bwill seek\b|\bup to\b|\bauthori[sz]ed? the board\b|\bno later than\b|\bat a ratio of not\b|\bpending\b/i;

/** "every five (5) shares ... combined into one (1)": shares after : before. */
function combinedRatio(s: string) {
  const W = String.raw`(\d{1,4}|[a-z]+(?:-[a-z]+)?)(?:\s*\(\d+\))?`;
  const m = new RegExp(String.raw`\bevery\s+${W}\s+(?:\(\d+\)\s+)?(?:[\w-]+\s+){0,8}?(?:shares?|ordinary shares?)\b[^.]{0,120}?\b(?:combined|consolidated|converted|reclassified|subdivided|split)\s+into\s+${W}`, 'i').exec(s);
  if (!m) return undefined;
  const a = numberWord(m[2]), b = numberWord(m[1]);
  return a && b && a !== b ? { new: a, old: b } : undefined;
}

function splits(d: Doc): CorporateAction[] {
  // Only when the shares themselves trade in the US (see the top of this file).
  if (d.ads || !d.usNamed) return [];
  const { f, ss } = d;
  // A split the company only "expects to" or "plans to" make, anywhere it speaks of it: none (a later sentence about the same split doesn't make it firmer).
  if (ss.some((s) => SPLIT.test(s) && /\b(?:expects?|plans?|intends?) to (?:implement|effect|undertake|carry out|complete|proceed|conduct|make)\b/i.test(s))) return [];
  for (let i = 0; i < ss.length; i++) {
    const s = ss[i];
    if (!SPLIT.test(s) || NOT_YET.test(s) || NOT_YET_6K.test(s)) continue;
    if (PREFERRED.test(s) && !COMMON.test(s)) continue;
    const next = ss.slice(i + 1, i + 3).filter((n) => !NOT_YET.test(n) && !NOT_YET_6K.test(n));
    const ratio = splitRatio(s) ?? combinedRatio(s) ?? next.map(combinedRatio).find(Boolean);
    if (!ratio) continue;
    const reverse = /\breverse\b|\bconsolidat/i.test(s);
    if (reverse !== ratio.new < ratio.old) continue;
    const w = [s, ...next].join(' ');
    const begins = dateAfter(w, /\b(?:on|to) a (?:post-split|split[- ]adjusted|reverse[- ]split[- ]adjusted|consolidated|post-consolidation) basis\b|\b(?:opening of trading|market opens|start of trading|commencement of trading)\b(?:\s+on)?/, f.filed, 90, undefined, DATE_ANY);
    const effective = dateAfter(w, /\b(?:effective|become effective|became effective|will be effective|effective date|effective time|take effect|took effect|went into effect)\b/, f.filed, 80, undefined, DATE_ANY);
    const when = begins ?? effective;
    if (!when || when < addDays(f.filed, -10) || when > addDays(f.filed, 180)) continue;
    const type: EventType = reverse ? 'reverse-split' : 'split';
    return [{ ...base(d, type, when, w, SPLIT, false), dates: { announced: f.filed, effective: when }, ratio }];
  }
  return [];
}

// ---- mergers ----------------------------------------------------------------------------

const ACQUIRED = /\b(?:became|has become|is now|was) (?:a |an )?(?:indirect |direct )?wholly[- ]owned subsidiary\b|\bcease[sd]? to be (?:a )?publicly traded\b|\bceased to be publicly traded\b|\bsurviving (?:the merger )?as (?:the surviving company|a wholly[- ]owned)/i;
const DONE = /\b(?:announced the completion of|has completed|completed|completion of|consummated|has been completed)\b/i;
const CASH6 = new RegExp(String.raw`\bright to receive\b[^;]{0,120}?(?:(${BEFORE})\s?(${NUM})|(${NUM})\s?(${AFTER})\b)\s+in cash\s+(?:per|for each)\s+(?:[\w-]+\s+){0,3}?(shares?|ADSs?|ADRs?|American Deposit[ao]ry (?:Shares?|Receipts?))\b`, 'gi');

function mergers(d: Doc): CorporateAction[] {
  const { f, ss } = d;
  if (!ACQUIRED.test(d.text)) return [];
  const doneIdx = ss.findIndex((s) => DONE.test(s) && /\b(?:merger|amalgamation|arrangement|going private|business combination)\b/i.test(s) && !/\b(?:expected|anticipated|will (?:be )?(?:close|complete|consummate)|subject to|if completed)\b/i.test(s));
  if (doneIdx < 0) return [];
  // The day it took effect, stated as such (not the agreement's date, nor the shareholders' meeting).
  let effective: { date: string; idx: number } | undefined;
  for (let i = 0; i < ss.length && !effective; i++) {
    const s = ss[i];
    if (/\bwill\b[^.]{0,40}\beffective\b|\bexpected\b/i.test(s)) continue;
    const at = dateAfter(s, /\beffective time of the (?:merger|arrangement|amalgamation)\b|\bclosing date\b|\b(?:was|were|has been) completed on\b|\bbecame effective on\b|\beffective as of\b/i, f.filed, 60, /\bdated\b|\bmeeting\b/, DATE_ANY);
    if (at && at >= addDays(f.filed, -10) && at <= addDays(f.filed, 3)) effective = { date: at, idx: i };
  }
  if (!effective) return [];
  const termsIdx = ss.findIndex((s) => /\bright to receive\b/i.test(s) && !/\boption|\bwarrant|\brestricted (?:share|stock) unit|\bRSU\b/i.test(s.slice(0, s.search(/right to receive/i) + 1)));
  if (termsIdx < 0) return [];
  const terms = ss[termsIdx];
  if (/\belect(?:ion|ed|s)?\b|\bat the option of\b/i.test(terms)) return [];
  const cash = [...terms.matchAll(CASH6)]
    .map((m) => ({ token: m[1] ?? m[4], raw: (m[2] ?? m[3]).replace(/,/g, ''), ads: ADS_UNIT.test(m[5]) }))
    .map((x) => ({ ...x, currency: currencyOf(x.token, d.text) }))
    .find((x) => x.currency && x.ads === d.ads);
  if (!cash || !(Number(cash.raw) > 0)) return [];
  if (!d.ads && !d.usNamed) return [];
  // One sentence with both: from the effective time to the terms.
  const quote = termsIdx === effective.idx ? clip(terms, /effective time|closing date|completed on|effective as of|became effective/i, 800) : `${clip(ss[effective.idx], new RegExp(DATE_ANY), 300)} ${clip(terms, /right to receive/i, 420)}`;
  return [
    {
      ...base(d, 'merger', effective.date, quote, undefined, d.ads),
      dates: { announced: f.filed, effective: effective.date },
      cash: { amount: cash.raw, currency: cash.currency! },
    },
  ];
}

/** Every corporate action a 6-K states in full, for the security that trades in the US. */
export function extract6k(f: Filing): CorporateAction[] {
  // As for 8-Ks, a filer with no ticker on a US exchange is left out.
  if (!f.tickers.length) return [];
  const ss = sentences(f.text);
  const d: Doc = { f, ss, text: f.text, ads: ADS.test(f.text), usNamed: US_EXCHANGE.test(f.text), nonUs: NON_US_EXCHANGE.test(f.text) };
  return [...dividends(d), ...splits(d), ...mergers(d)];
}

/**
 * Whether an event read from a 6-K is for what trades in the US under its ticker, by OpenFIGI's
 * security type for it ("Depositary Receipt", "Common Stock", ...): an amount per share is not
 * what an ADS holder gets, nor the other way round. Unknown type: the filing's own wording stands.
 */
export function fitsListing(e: CorporateAction, securityType: string | null | undefined): boolean {
  if (!/^6-K/.test(e.source.form) || !securityType) return true;
  const receipt = /depositary|\bADR\b|\bGDR\b/i.test(securityType);
  return e.instrument === 'ADS' ? receipt : !receipt;
}

