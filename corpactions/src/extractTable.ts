// Dividends stated only in a table: "Record Date | Payment Date | Amount" rows in an 8-K, or a 6-K's
// "Ex-dividend date | Record date | Payment date" timetable. Read from the filing's own HTML <table>
// markup (tables.ts), never from images or PDFs, with the same rule as the sentence readers: an event
// goes in only when the table states its amount (with its currency, per share or per ADS), its record
// date and its payment date, each in exactly one cell, for the security that trades in the US. The
// amount may instead come from the one sentence that introduces the table, or from the one small
// table of amounts in the document, when that is the only amount it could be. Left out as well:
//
// - estimates and anything not yet firm ("expected", "anticipated", "provisional", "on or about",
//   "proposed", "subject to approval", "forecast"), and dates without a year or written as numbers;
// - scrip dividends, elections between cash and shares, distributions of capital, interest on capital;
// - tables of dividends already paid (any row paid before the filing), or that "were declared" in a period;
// - tables for more than one class, series or market that don't say which row or column is the US
//   security (a "NYSE" or "ADS" column or row says it); preferred stock; another of the filer's tickers;
// - for a 6-K, everything extract6k.ts leaves out: an amount per share when the US security is the ADS
//   (and the other way round), dates the table doesn't give for ADS holders, a currency it doesn't state.
//
// Each event quotes the table: its heading, then the rows it was read from, each in [brackets] with the
// cells joined by " | ", as the filing renders them, and sets source.table. tests/corpactions-tables.test.ts
// runs this on real filings (corpactions/fixtures/tables/) and on the 6-K fixtures.

import { COMMON, commonAmount, DECLARED as DECLARED_8K, extract, FREQ, PREFERRED, tickerOf as tickerOf8k, type Filing } from './extract.ts';
import { ADS, AFTER, amounts, mentionsAds, BEFORE, CAPITAL, currencyOf, DECLARED as DECLARED_6K, extract6k, FREQ6, hundredth, NON_US_EXCHANGE, NOT_CASH, NUM, tickerOf as tickerOf6k, US_EXCHANGE } from './extract6k.ts';
import { addDays, DATE_ANY, parseDate, sentences } from './text.ts';
import { readCells, rowText, tables, type Cell, type Row, type Table } from './tables.ts';
import type { CorporateAction } from './types.ts';

type Kind = 'ex' | 'record' | 'pay' | 'amount';
type Scope = 'us' | 'all' | 'other';
type Money = { amount: string; currency: string; unit?: 'share' | 'ADS' };
type Ctx = { f: Filing; six: boolean; ads: boolean; usNamed: boolean; nonUs: boolean; ticker?: string };

// ---- what a label says --------------------------------------------------------------------

const EX_L = /\bex[-\s]*(?:dividend|distribution|div\b|date\b)/i;
const RECORD_L = /\brecord\b/i;
const PAY_L = /\bpay(?:ment|able)?\s+date\b|\bdate\s+(?:of\s+)?payment\b|\bdate (?:the )?(?:dividend|distribution) is (?:payable|paid)\b|\bpaid on\b/i;
const AMOUNT_L = /\bper\s+(?:common\s+|ordinary\s+)?(?:share|ADS|ADR)|\/\s*share\b|\bdividends?\b|\bdistributions?\b|\bamount\b|\bvalue\b/i;
/** Columns of totals, rates and counts, not an amount per share: "Total Amount", "Dividend yield (%)", "In cash (millions)". */
const NOT_PER_UNIT = /\btotal\b|\baggregate\b|\bmillions?\b|\bthousands?\b|\byield\b|\brate\b|%|\bin cash\b|\bannuali[sz]ed\b|\bnumber\b|\bshares issued\b/i;
const PER_L = /\bper\s+(?:common\s+|ordinary\s+|outstanding\s+)?(?:shares?|ADSs?|ADRs?|American Deposit[ao]ry \w+)\b|\/\s*(?:share|ADS)\b/i;

function kindsOf(label: string): Kind[] {
  const out: Kind[] = [];
  if (EX_L.test(label)) out.push('ex');
  if (RECORD_L.test(label)) out.push('record');
  if (PAY_L.test(label)) out.push('pay');
  // "Dividend dates", "Declaration date": a column of dates or names, not of amounts.
  if (!out.length && AMOUNT_L.test(label) && !/\bdates?\b/i.test(label) && (PER_L.test(label) || !NOT_PER_UNIT.test(label))) out.push('amount');
  return out;
}

/** Whose a label or a row is: the US security's ("ADS", "NYSE"), every holder's, or another market's or class's. */
function scopeOf(s: string, c: Ctx): Scope {
  const usMarket = /\bNYSE\b|\bNasdaq\b|\bNASDAQ\b|New York Stock Exchange|\bU\.?S\.?(?!\s*(?:\$|dollars?|cents))\b/.test(s);
  const adsWord = ADS.test(s);
  const classWord = /\bpreferred\b|\bpreference\b|\bseries\b|\bclass\b|\brestricted\b/i.test(s);
  const otherMarket = NON_US_EXCHANGE.test(s) || /\bAIM\b|\bVFEX\b|\bMEXBOL\b|\bregister\b/.test(s);
  if (!c.six) return classWord ? 'other' : 'all';
  // A 6-K: the US security is the ADS (ads) or the shares named on a US exchange.
  const us = c.ads ? adsWord || usMarket : usMarket;
  const other = classWord || otherMarket || (c.ads ? /\bordinary shares?\b|\bORD\b/i.test(s) : adsWord);
  return us && other ? 'all' : us ? 'us' : other ? 'other' : 'all';
}

const PERIOD = /\b(?:Q|FQ|H)[1-4]\b|\b[1-4]\s*Q\b|\b[1-4](?:st|nd|rd|th)?\s*quarter\b|\b(?:first|second|third|fourth|interim|final|monthly|quarterly)\b|\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\b|(?:19|20)\d{2}|\bFY|\bfiscal\b|\bpayment no\b|^(?:date|dates|value|amount|event)$/i;

/** A row's or column's name: the US security, a period (one dividend of several), or another class or market. */
function identityOf(s: string, c: Ctx): 'us' | 'neutral' | 'other' {
  if (!s.trim()) return 'neutral';
  const sc = scopeOf(s, c);
  if (sc === 'other') return 'other';
  if (c.six && sc === 'us') return 'us';
  return PERIOD.test(s) || /^[\d\s,.]+$/.test(s) ? 'neutral' : 'other';
}

// ---- what a cell says ---------------------------------------------------------------------

const DATE_CELL = new RegExp(String.raw`^(?:(?:Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day,?\s+)?(${DATE_ANY})\s*(?:\(\d\)|\d|\*+)?$`, 'i');

/** A cell that is one date with its year ("November 13, 2026", "Friday, 9 October 2026"); nothing else in it. */
export function dateCell(t: string, filed: string): string | undefined {
  const m = DATE_CELL.exec(t.trim());
  if (!m || !/\d{4}/.test(m[1])) return undefined;
  return parseDate(m[1].replace(/\s+/g, ' '), filed);
}

const AMOUNT_CELL = new RegExp(String.raw`^(?:(${BEFORE})\s?)?(${NUM})(?:\s?(${AFTER}|p)(?![a-z]))?(?:\s+(?:per|a|for each)\s+((?:[A-Za-z]+\s+){0,3}?(?:shares?|ADSs?|ADRs?)))?\s*(?:\(\d\)|\*+)?$`, 'i');

type CellAmount = { raw: string; token?: string; unit?: 'share' | 'ADS' };
function amountCell(t: string): CellAmount | undefined {
  const m = AMOUNT_CELL.exec(t.trim());
  if (!m) return undefined;
  const raw = m[2].replace(/,/g, '');
  if (!(Number(raw) > 0)) return undefined;
  return { raw, token: m[1] ?? m[3], unit: m[4] ? unitOf(m[4]) : undefined };
}

function unitOf(s: string): 'share' | 'ADS' | undefined {
  if (ADS.test(s)) return 'ADS';
  if (/\bshares?\b|\/\s*share\b|\bcommon stock\b/i.test(s)) return 'share';
  return undefined;
}

const LABEL_CCY = new RegExp(String.raw`(?:^|[\s(/])(US cents|U\.S\. cents|${BEFORE}|${AFTER}|dollars?)(?=$|[\s)/,:])`, 'i');

/** The currency of an amount from its cell's symbol or, failing that, the label's "(US$)", "(yen)", "US cents per share". */
function moneyOf(a: CellAmount, hints: string[], c: Ctx): { amount: string; currency: string } | undefined {
  const token = a.token ?? hints.map((h) => LABEL_CCY.exec(h)?.[1]).find(Boolean);
  if (!token) return undefined;
  const t = token.trim();
  const cents = /^(?:U\.?S\.? cents|cents?|pence|p|euro cents)$/i.test(t);
  let currency: string | undefined;
  if (!c.six) currency = /^(?:\$|US\$|U\.S\.\s?\$|USD|dollars?|U\.?S\.? cents|cents?|US dollars?|U\.S\. dollars?)$/i.test(t) ? 'USD' : undefined;
  else if (/^U\.?S\.? cents$/i.test(t)) currency = 'USD';
  else if (/^p$/i.test(t)) currency = 'GBP';
  else if (/^dollars?$/i.test(t)) currency = currencyOf('$', c.f.text);
  else currency = currencyOf(t, c.f.text);
  if (!currency) return undefined;
  return { amount: cents ? hundredth(a.raw) : a.raw, currency };
}

// ---- a table as series of dividends -------------------------------------------------------

type Slot = { kind: Kind; label: string; scope: Scope; date?: string; amount?: CellAmount; row: Row };
type Series = { identity: string; slots: Slot[]; rows: Row[] };
type Shape = { series: Series[]; header: Row[]; hints: string[]; labels: string[] };

/** A row's cells as read, with a lone "Label: value" cell split in two. */
function cellsOf(r: Row): Cell[] {
  const cs = readCells(r);
  if (cs.length === 1) {
    const m = /^(.{3,90}?):\s+(.{4,40})$/.exec(cs[0].text);
    if (m) return [{ text: m[1], col: cs[0].col, span: 1 }, { text: m[2], col: cs[0].col + 1, span: 1 }];
  }
  return cs;
}

const isValue = (t: string, filed: string) => !!dateCell(t, filed) || !!amountCell(t);
/** Whether a header cell is over a value cell: their columns overlap (a "$" cell glued to its number starts a column early). */
const covers = (h: Cell, c: Cell) => h.col < c.col + c.span && c.col < h.col + h.span;

function slot(kind: Kind, label: string, cell: Cell, row: Row, c: Ctx): Slot | undefined {
  if (kind === 'amount') {
    const amount = amountCell(cell.text);
    return amount ? { kind, label, scope: scopeOf(label, c), amount, row } : undefined;
  }
  const date = dateCell(cell.text, c.f.filed);
  return date ? { kind, label, scope: scopeOf(label, c), date, row } : undefined;
}

/** Labels across the top ("Record Date | Payment Date | Amount"), one dividend (or market) per row. */
function horizontal(rows: Row[], c: Ctx): Shape | undefined | null {
  const filed = c.f.filed;
  const h = rows.findIndex((r) => {
    const cs = cellsOf(r);
    return cs.filter((x) => kindsOf(x.text).length).length >= 2 && !cs.some((x) => isValue(x.text, filed));
  });
  if (h < 0) return undefined;
  const head = cellsOf(rows[h]);
  const kinds = head.map((x) => kindsOf(x.text));
  const ks = kinds.flat();
  if (!ks.includes('record') || !ks.includes('pay')) return undefined;
  // The same column twice ("Record Date | Payment Date | ... | Record Date | Payment Date"): two tables side by side, or two classes.
  const seen = new Set<string>();
  for (const [i, k] of kinds.entries()) for (const x of k) {
    const key = `${x}:${scopeOf(head[i].text, c)}`;
    if (seen.has(key)) return null;
    seen.add(key);
  }
  const series: Series[] = [];
  for (const r of rows.slice(h + 1)) {
    const cs = cellsOf(r);
    if (!cs.some((x) => isValue(x.text, filed))) {
      // A second header row under the first ("Class E | Class FA") splits a column in two: which is whose isn't one cell.
      if (!series.length && cs.length >= 2) return null;
      continue;
    }
    const s: Series = { identity: '', slots: [], rows: [rows[h], r] };
    const ident: string[] = [];
    for (const x of cs) {
      const at = head.findIndex((hc) => covers(hc, x));
      const k = at >= 0 ? kinds[at] : [];
      if (!k.length) {
        ident.push(x.text);
        continue;
      }
      for (const kind of k) {
        const sl = slot(kind, head[at].text, x, r, c);
        if (sl) s.slots.push(sl);
      }
    }
    s.identity = ident.join(' ');
    series.push(s);
  }
  return { series, header: [rows[h]], hints: head.map((x) => x.text), labels: head.map((x) => x.text) };
}

/** Labels down the side ("Record date | 13 November 2026"), one dividend (or market) per column. */
function vertical(rows: Row[], c: Ctx): Shape | undefined | null {
  const filed = c.f.filed;
  const first = rows.findIndex((r) => {
    const cs = cellsOf(r);
    const label = cs.filter((x) => !isValue(x.text, filed)).map((x) => x.text).join(' ');
    return kindsOf(label).length && cs.some((x) => isValue(x.text, filed));
  });
  if (first < 0) return undefined;
  const above = rows.slice(0, first).filter((r) => !cellsOf(r).some((x) => isValue(x.text, filed)));
  const headRow = [...above].reverse().find((r) => cellsOf(r).length >= 2);
  const head = headRow ? cellsOf(headRow) : [];
  const series = new Map<string, Series>();
  const labels: string[] = [];
  for (const r of rows.slice(first)) {
    const cs = cellsOf(r);
    const values = cs.filter((x) => isValue(x.text, filed));
    const label = cs.filter((x) => !isValue(x.text, filed)).map((x) => x.text).join(' ');
    const kinds = kindsOf(label);
    if (!kinds.length || !values.length) continue;
    labels.push(label);
    for (const [i, v] of values.entries()) {
      // Which column: the header cell above it; with no header, only one value a row.
      const hc = head.find((x) => covers(x, v) && !covers(x, cs[0]));
      if (!hc && (values.length > 1 || head.length > 2)) return null;
      const key = hc ? `${hc.col}` : `${i}`;
      const s = series.get(key) ?? { identity: hc?.text ?? '', slots: [], rows: headRow ? [headRow] : [] };
      series.set(key, s);
      let any = false;
      for (const kind of kinds) {
        const sl = slot(kind, label, v, r, c);
        if (sl) {
          s.slots.push(sl);
          any = true;
        }
      }
      if (any && !s.rows.includes(r)) s.rows.push(r);
    }
  }
  return { series: [...series.values()], header: headRow ? [headRow] : [], hints: [head[0]?.text ?? '', ...labels], labels };
}

// ---- what is left out ---------------------------------------------------------------------

const NOT_FIRM_T = /\bpropos|\brecommend|\bexpected\b|\banticipated\b|\bestimated?\b|\bforecast|\bprovisional\b|\btentative\b|\bindicative\b|\bon or (?:about|around)\b|\bsubject to (?:\w+\s+){0,3}?(?:approval|review|change|confirmation|declaration)\b|\bto be (?:confirmed|announced|determined)\b|\bpreliminary\b|\bTB[CAD]\b/i;
const GUIDANCE = /\b(?:announce[sd]?|provide[sd]?|issue[sd]?|gives?|gave)\s+(?:its\s+)?guidance\b|\bguidance (?:on|for) (?:the )?[A-Z]?\w* ?\d{0,4} ?(?:cash )?dividend/i;
const NOT_PLAIN = /\binterest on (?:own )?(?:capital|equity)\b|\bJCP\b|\bjuros\b|\bstock dividend\b|\bin (?:the form of )?(?:additional |new )?shares\b/i;
/** Words for preferred stock's dividends even where the word "preferred" isn't used ("a per annum dividend rate of 14.00% on the CHAD Stock"). */
const PREFERRED_TERMS = /\bperpetual\b|\bliquidation preference\b|\bstated amount\b|\bper annum (?:dividend )?rate\b|\bdividend rate\b|\bcumulative\b|\bredeemable\b/i;
const HISTORY = /\bwere declared\b|\bdeclared and paid\b|\bhas declared and paid\b|\bdeclared (?:the following )?dividends? during\b|\bduring the (?:three|six|nine|twelve) months\b|\bpaid as follows\b|\bsince the start of\b|\bsummary of the dividends\b|\bdividend history\b/i;

/** The sentences just before a table that introduce it ("... declared a dividend of US$0.0115 per share, as follows:"). */
function introOf(t: Table): string {
  const ss = sentences(t.before);
  return ss.slice(-2).join(' ');
}

/** A table's heading: its caption, or the short line before it ("Dividend timetable", "... as follows:"), not a sentence of the text. */
function headingOf(t: Table): string | undefined {
  const h = t.heading?.trim();
  return h && h.length <= 160 && !/[.!?]$/.test(h) ? h : undefined;
}

function otherTicker(s: string, c: Ctx): boolean {
  return c.f.tickers.some((t) => t !== c.ticker && t.length >= 2 && new RegExp(`(?<![A-Za-z0-9.-])${t.replace(/[.\-]/g, '\\$&')}(?![A-Za-z0-9-])`).test(s));
}

// ---- reading ------------------------------------------------------------------------------

/** One field of a dividend: the US security's cell if the table has one, else the one cell for every holder; two that differ: none. */
function pick(slots: Slot[], kind: Kind): Slot | undefined | null {
  const of = slots.filter((s) => s.kind === kind && s.scope !== 'other');
  const us = of.filter((s) => s.scope === 'us');
  const use = us.length ? us : of;
  if (!use.length) return undefined;
  const v = (s: Slot) => s.date ?? s.amount?.raw;
  return use.every((s) => v(s) === v(use[0])) ? use[0] : null;
}

/** The small tables that state one amount and nothing else ("Per ADS | Q3 2026 / Shell ADSs (US$) | 0.7812"). */
function amountTables(ts: Table[], c: Ctx): { money: Money; rows: Row[]; heading?: string }[] {
  const out: { money: Money; rows: Row[]; heading?: string }[] = [];
  for (const t of ts) {
    if (t.rows.length > 4) continue;
    const cells = t.rows.flatMap((r) => cellsOf(r).map((x) => ({ x, r })));
    if (cells.some(({ x }) => dateCell(x.text, c.f.filed))) continue;
    const found = cells.filter(({ x }) => amountCell(x.text));
    if (found.length !== 1) continue;
    const text = cells.filter(({ x }) => !amountCell(x.text)).map(({ x }) => x.text);
    const all = [...text, headingOf(t) ?? ''].join(' ');
    if (!/\bdividends?\b|\bper (?:share|ADS|ADR|ordinary)|\bADSs?\b|\bshares\b/i.test(all) || NOT_PER_UNIT.test(text.join(' '))) continue;
    const a = amountCell(found[0].x.text)!;
    const m = moneyOf(a, [...text, headingOf(t) ?? ''], c);
    const unit = a.unit ?? unitOf(text.join(' ')) ?? unitOf(headingOf(t) ?? '');
    if (m && unit) out.push({ money: { ...m, unit }, rows: t.rows, heading: headingOf(t) });
  }
  return out;
}

/** The amount in the sentence that introduces a table, when that sentence declares it and states only one for the US security. */
function introAmount(intro: string, c: Ctx): Money | undefined {
  if (!/\bdividends?\b|\bdistributions?\b/i.test(intro) || NOT_FIRM_T.test(intro)) return undefined;
  if (!c.six) {
    if (!DECLARED_8K.test(intro)) return undefined;
    const a = commonAmount(intro);
    return a ? { amount: a, currency: 'USD', unit: 'share' } : undefined;
  }
  if (!DECLARED_6K.test(intro)) return undefined;
  const as = amounts(intro, c.f.text).filter((a) => a.ads === c.ads);
  const distinct = new Set(as.map((a) => `${a.currency} ${a.amount}`));
  return distinct.size === 1 ? { amount: as[0].amount, currency: as[0].currency, unit: c.ads ? 'ADS' : 'share' } : undefined;
}

function fromTable(t: Table, all: Table[], c: Ctx): CorporateAction[] {
  if (t.rows.length > 60) return [];
  // Rows of prose inside a layout table are not timetable rows.
  const rows = t.rows.filter((r) => readCells(r).every((x) => x.text.length <= 200));
  const shape = horizontal(rows, c) ?? vertical(rows, c);
  if (!shape || !shape.series.length) return [];
  const intro = introOf(t);
  const heading = headingOf(t);
  const own = [heading ?? '', ...rows.map(rowText)].join(' ');
  const context = `${intro} ${own}`;
  if (NOT_FIRM_T.test(own) || NOT_FIRM_T.test(intro.split(/(?<=[.!?])\s+/).pop() ?? '')) return [];
  // "Announced guidance on the October 2026 cash dividend": a forecast of what will be declared, not a declaration.
  if (GUIDANCE.test(intro) || GUIDANCE.test(own)) return [];
  // "Common Stock Dividend Information" is a heading, not a stock dividend.
  const cashOnly = context.replace(/\b(?:[Cc]ommon|[Pp]referred|[A-Z]{2,6}) [Ss]tock [Dd]ividends?\b/g, 'dividend');
  if (NOT_CASH.test(cashOnly) || CAPITAL.test(context) || NOT_PLAIN.test(cashOnly) || HISTORY.test(context)) return [];
  if (otherTicker(context, c)) return [];
  // Preferred stock: in the table itself, or only in the words before it while the table doesn't say common.
  const plain = (s: string) => s.replace(/\bdepositary shares\b/gi, '');
  if (PREFERRED.test(plain(own)) || PREFERRED_TERMS.test(own)) return [];
  if ((PREFERRED.test(plain(intro)) || PREFERRED_TERMS.test(intro)) && !COMMON.test(own)) return [];

  // Which rows or columns are the US security's.
  const ids = shape.series.map((s) => identityOf(s.identity, c));
  const us = shape.series.filter((_, i) => ids[i] === 'us');
  let chosen: Series[];
  if (us.length === 1) chosen = us;
  else if (us.length > 1 || ids.includes('other')) return [];
  else chosen = shape.series;
  // A 6-K: dates for ADS holders only from a table that speaks of ADSs (or the US market); shares only when named on a US exchange.
  const named = [heading ?? '', ...shape.labels, ...chosen.map((s) => s.identity)].join(' ');
  if (c.six && c.ads && !(ADS.test(named) || US_EXCHANGE.test(named))) return [];
  if (c.six && !c.ads && !c.usNamed) return [];

  const read: { s: Series; record: string; pay: string; ex?: string; money?: Money; used: Row[] }[] = [];
  for (const s of chosen) {
    const record = pick(s.slots, 'record');
    const pay = pick(s.slots, 'pay');
    const ex = pick(s.slots, 'ex');
    const amt = pick(s.slots, 'amount');
    if (!record || !pay || ex === null || amt === null) return [];
    let money: Money | undefined;
    if (amt) {
      const m = moneyOf(amt.amount!, [amt.label, ...shape.hints, heading ?? ''], c);
      const unit = amt.amount!.unit ?? unitOf(amt.label) ?? unitOf(s.identity) ?? unitOf(shape.hints[0] ?? '') ?? unitOf(heading ?? '') ?? (/\bper share\b/i.test(intro) ? 'share' : undefined);
      if (!m) return [];
      money = { ...m, unit };
    }
    // The ex-date: stated for the US market, or in a filing that names no other; else the T+1 rule.
    const exUse = ex && (!c.six || ex.scope === 'us' || ids[shape.series.indexOf(s)] === 'us' || !c.nonUs) ? ex.date : undefined;
    const used = [record, pay, exUse ? ex : undefined, amt].filter((x): x is Slot => !!x).map((x) => x.row);
    read.push({ s, record: record.date!, pay: pay.date!, ex: exUse, money, used });
  }
  // A table with a row paid before the filing lists past dividends, whatever else it lists.
  if (read.some((x) => x.pay < addDays(c.f.filed, -5) || x.pay > addDays(c.f.filed, 400) || x.record > x.pay || (x.ex && x.ex > x.pay))) return [];
  if (new Set(read.map((x) => x.pay)).size !== read.length) return [];

  // One dividend with no amount in its table: the sentence that introduces it, or the document's one table of amounts.
  let extra: { intro?: string; rows: Row[]; heading?: string } = { rows: [] };
  if (read.length === 1 && !read[0].money) {
    const want = c.six && c.ads ? 'ADS' : 'share';
    const fromIntro = introAmount(intro, c);
    const tablesOf = amountTables(all.filter((x) => x !== t), c).filter((x) => x.money.unit === want);
    const distinct = new Set(tablesOf.map((x) => `${x.money.currency} ${x.money.amount}`));
    if (fromIntro && (!tablesOf.length || (distinct.size === 1 && distinct.has(`${fromIntro.currency} ${fromIntro.amount}`)))) {
      read[0].money = fromIntro;
      extra = { intro, rows: [] };
    } else if (!fromIntro && distinct.size === 1) {
      read[0].money = tablesOf[0].money;
      extra = { rows: tablesOf[0].rows, heading: tablesOf[0].heading };
    } else return [];
  }

  const out: CorporateAction[] = [];
  for (const x of read) {
    const m = x.money;
    if (!m || !m.unit) continue;
    if ((m.unit === 'ADS') !== (c.six && c.ads)) continue;
    const freqText = `${heading ?? ''} ${intro} ${x.s.identity}`;
    const frequency = (c.six ? FREQ6 : FREQ).find(([re]) => re.test(freqText))?.[1] ?? 'other';
    const tableRows = [...shape.header, ...rows.filter((r) => x.used.includes(r) && !shape.header.includes(r))];
    const parts = [
      extra.intro,
      extra.heading,
      ...extra.rows.map((r) => `[${rowText(r)}]`),
      heading && !(extra.intro ?? '').includes(heading) ? heading : undefined,
      ...tableRows.map((r) => `[${rowText(r)}]`),
    ].filter(Boolean);
    const ticker = c.ticker;
    const e: CorporateAction = {
      id: `dividend-${c.f.company.cik}-${x.pay}${frequency === 'special' ? '-special' : ''}`,
      type: 'dividend',
      company: { ...c.f.company, ...(ticker ? { ticker } : {}) },
      ...(m.unit === 'ADS' ? { instrument: 'ADS' as const } : {}),
      dates: { announced: c.f.filed, record: x.record, ex: x.ex ?? x.record, pay: x.pay },
      ...(x.ex ? {} : { exDateRule: true as const }),
      cash: { amount: m.amount, currency: m.currency },
      frequency,
      source: { url: c.f.url, form: c.f.form, accession: c.f.accession, filed: c.f.filed, quote: parts.join(' '), table: true },
    };
    out.push(e);
  }
  return out;
}

/** Every dividend a filing states in a table, for the security that trades in the US. */
export function tableDividends(f: Filing): CorporateAction[] {
  if (!f.html || !f.tickers.length || !/<table/i.test(f.html)) return [];
  const six = /^6-K/.test(f.form);
  const c: Ctx = {
    f,
    six,
    ads: six && mentionsAds(f.text),
    usNamed: US_EXCHANGE.test(f.text),
    nonUs: NON_US_EXCHANGE.test(f.text),
    ticker: six ? tickerOf6k(f) : tickerOf8k(f),
  };
  const ts = tables(f.html);
  const out: CorporateAction[] = [];
  for (const t of ts) for (const e of fromTable(t, ts, c)) if (!out.some((x) => x.id === e.id)) out.push(e);
  return out;
}

/** Everything the feed reads from one document: its sentences (extract, extract6k), then its tables, a dividend already read from the sentences kept as it is. */
export function extractAll(f: Filing): CorporateAction[] {
  const fromText = /^6-K/.test(f.form) ? extract6k(f) : extract(f);
  const ids = new Set(fromText.map((e) => e.id));
  return [...fromText, ...tableDividends(f).filter((e) => !ids.has(e.id))];
}
