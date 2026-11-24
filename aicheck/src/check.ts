// The AI answer check: what AI search engines tell people about a listed company, fund or token issuer,
// and whether it is right. A subject is found in the corporate actions feed (SEC filings) and the
// Tokenized Asset Map (issuers' own pages); those are the answer key. A few questions are put to the
// engines (engines.ts), and every fact an answer states is graded here, without a model: dates, amounts,
// ratios, acquirers, contract addresses and ISINs are read out of the text and compared with the key.
// Same code for the /ai-check page, POST /api/ai-check and the MCP tool check_ai_answer.

import { EVENTS, HISTORY, describe as describeEvent, type CorporateAction } from '../../corpactions/src/index.ts';
import { CHAINS, ENTRIES, type Chain, type Entry } from '../../assetmap/src/index.ts';

export type Subject = {
  /** What the subject is called in answers. */
  name: string;
  ticker?: string;
  cik?: string;
  figi?: string;
  /** Every corporate action the feed holds for it, newest first. */
  events: CorporateAction[];
  /** Its earlier corporate actions, since dropped from the feed (kept in the feed's history): an answer quoting these is out of date. */
  older: CorporateAction[];
  /** True when the subject is a token or fund itself (BENJI, AAPLx), false for a listed company. */
  asset: boolean;
  /** Asset Map entries for it (a fund's share classes, or a tokenized stock's versions). */
  entries: Entry[];
  /** Hosts whose citation counts as the primary source: sec.gov for a company, the issuer's own sites for a token. */
  primaryHosts: string[];
};

export type Question = { id: 'dividend' | 'split' | 'merger' | 'tokens' | 'identity'; text: string };

/** unverified: a contract address the Asset Map does not know either way (not in the map is not a verdict). */
export type Verdict = 'right' | 'wrong' | 'out-of-date' | 'not-stated' | 'unverified';
export type Finding = { question: Question['id']; fact: string; expected: string; stated: string | null; verdict: Verdict; source: string };

export const MAX_SUBJECT = 120;
export const MAX_ANSWER = 40_000;

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
// Words a company name carries that answers often leave out.
const LEGAL = /\b(inc|incorporated|corp|corporation|co|company|ltd|limited|plc|sa|nv|ag|holdings?|group|the|class [a-z]|de|n v|s a)\b/g;
const core = (name: string) => norm(name).replace(LEGAL, ' ').replace(/\s+/g, ' ').trim();
/** SEC names come in capitals (NUCOR CORP): shown as Nucor Corp. */
export const displayName = (n: string) =>
  (n.match(/[A-Z]/g)?.length ?? 0) >= 0.8 * (n.match(/[A-Za-z]/g)?.length ?? 1) && /[A-Z]{3}/.test(n) ? n.toLowerCase().replace(/\b([a-z])/g, (c) => c.toUpperCase()).replace(/\b(Llc|Lp|Plc|Nv|Sa|Ag|Reit|Etf|Ads|Usa|Us)\b/g, (w) => w.toUpperCase()) : n;
const REMOVED = Object.values(HISTORY.events).flatMap((h) => (h.removed ? [h.removed.last] : []));
const hostOf = (u: string) => {
  try {
    return new URL(u).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
};

/** A ticker, company name, CIK, FIGI, ISIN, token symbol or Asset Map id → the subject, or null. */
/** A stock known only through its tokens: "Microsoft xStock" and "Microsoft (Ondo Tokenized)" both say Microsoft. */
function stockName(entries: Entry[], ticker: string): string {
  const names = entries.map((e) => e.security.name.replace(/\s*(xStock|\(Ondo Tokenized\))\s*$/i, '').trim()).filter((x) => x && !/^SP500$/i.test(x));
  return names.sort((a, b) => b.length - a.length)[0] ?? ticker;
}

export function findSubject(input: string, events: CorporateAction[] = EVENTS, entries: Entry[] = ENTRIES, removed: CorporateAction[] = REMOVED): Subject | null {
  const q = input.trim();
  if (!q || q.length > MAX_SUBJECT) return null;
  const up = q.toUpperCase();
  const n = core(q);
  const cik = /^\d{1,10}$/.test(q) ? q.padStart(10, '0') : null;
  // Exact identifiers first (a ticker, CIK, FIGI, ISIN, map id or token symbol, and the tokens tracking that ticker);
  // a name match only when nothing matched exactly, so META is Meta's tokens and not Commercial Metals.
  const exact = (e: CorporateAction) => e.company.ticker?.toUpperCase() === up || e.company.figi === up || e.company.cik === cik;
  let evs = events.filter(exact);
  if (evs.length) evs = events.filter((e) => e.company.cik === evs[0].company.cik);
  const exactEntry = (e: Entry) =>
    e.id === q.toLowerCase() || e.security.ticker?.toUpperCase() === up || e.security.isin === up || e.security.figi === up || e.tokens.some((t) => t.symbol.toUpperCase() === up);
  let ens = entries.filter(exactEntry);
  const tracks = (e: Entry, c?: CorporateAction['company']) => !!e.security.underlying && (e.security.underlying.ticker.toUpperCase() === (c?.ticker ?? up).toUpperCase() || (!!c?.figi && e.security.underlying.figi === c.figi));
  let underlying = entries.filter((e) => tracks(e, evs[0]?.company));
  if (!evs.length && !ens.length && !underlying.length) {
    if (n.length >= 3) evs = events.filter((e) => core(e.company.name) === n || (n.length >= 4 && core(e.company.name).startsWith(n + ' ')));
    if (!evs.length && n.length >= 4) evs = events.filter((e) => core(e.company.name).includes(n));
    if (evs.length) evs = events.filter((e) => e.company.cik === evs[0].company.cik);
    if (evs.length) underlying = entries.filter((e) => tracks(e, evs[0].company));
    else if (n.length >= 4) ens = entries.filter((e) => core(e.security.name).includes(n) || core(e.security.issuer) === n);
  }
  // A token symbol that is also a tracked stock's ticker means the stock.
  if (ens.length && underlying.length && !ens.some((e) => e.security.ticker?.toUpperCase() === up || e.id === q.toLowerCase())) ens = [];
  if (!evs.length && !ens.length && !underlying.length) return null;
  const company = evs[0]?.company;
  const all = [...new Map([...ens, ...underlying].map((e) => [e.id, e])).values()];

  const sorted = [...evs].sort((a, b) => (b.dates.announced + b.id).localeCompare(a.dates.announced + a.id));
  const head = all[0];
  // A token ticker (BENJI) names the fund; a stock ticker (AAPL) names the company even when tokens track it.
  const own = ens.length && !evs.length ? head : null;
  return {
    name: own ? own.security.name : company ? displayName(company.name) : head.security.underlying ? stockName(all, head.security.underlying.ticker) : head.security.name,
    ticker: own ? own.security.ticker ?? own.tokens[0]?.symbol : company?.ticker ?? head?.security.underlying?.ticker,
    cik: company?.cik,
    figi: own ? own.security.figi : company?.figi ?? head?.security.underlying?.figi,
    events: sorted,
    older: company ? removed.filter((e) => e.company.cik === company.cik) : [],
    asset: !!own,
    entries: own ? ens : all,
    primaryHosts: [...new Set([...(evs.length ? ['sec.gov'] : []), ...(own ? ens : all).flatMap((e) => e.sources.map((s) => hostOf(s.url))).filter(Boolean)])],
  };
}

const latest = (s: Subject, types: CorporateAction['type'][]) => s.events.find((e) => types.includes(e.type));

/** The questions for a subject: only ones the answer key can grade, at most three. */
export function questionsFor(s: Subject): Question[] {
  const who = `${s.name}${s.ticker && !s.name.includes(s.ticker) ? ` (${s.ticker})` : ''}`;
  const out: Question[] = [];
  if (latest(s, ['dividend'])) out.push({ id: 'dividend', text: `What is the most recently declared cash dividend of ${who}: the amount per share, the ex-dividend date, the record date and the payment date?` });
  if (latest(s, ['split', 'reverse-split'])) out.push({ id: 'split', text: `Has ${who} announced a stock split or reverse stock split recently? Give the ratio and the date it takes effect.` });
  if (latest(s, ['merger'])) out.push({ id: 'merger', text: `Is ${who} being acquired or merging? Who is the acquirer, what do shareholders get per share, and when does it take effect?` });
  if (s.entries.length) {
    const e = s.entries[0];
    const many = !s.asset && !!e.security.underlying;
    const thing = many ? `tokenized versions of ${s.ticker ?? s.name} stock` : e.security.underlying ? `${who}, the tokenized ${e.security.underlying.ticker} stock,` : `the tokenized ${who}`;
    out.push({ id: 'tokens', text: `Which blockchains ${many ? 'are' : 'is'} ${thing} issued on, who issues ${many ? 'them' : 'it'}, and what are the official token contract addresses?` });
    if (out.length < 3 && e.security.isin && !e.security.underlying) out.push({ id: 'identity', text: `What is the ISIN of ${who}, and who is the fund's issuer or manager?` });
  }
  return out.slice(0, 3);
}

/** The prompt one engine gets: all questions at once, numbered, so each answer can be graded on its own. */
export function promptFor(qs: Question[]): string {
  return [
    'Answer each question from current sources on the web. Be brief and factual.',
    'Write every date as YYYY-MM-DD and every amount with its currency. Copy contract addresses and identifiers exactly.',
    'If you cannot find something, say "unknown" rather than guess.',
    'Start each answer with its number, like "1." on a new line.',
    '',
    ...qs.map((q, i) => `${i + 1}. ${q.text}`),
  ].join('\n');
}

/** An answer to the numbered prompt, split back into one answer per question ("1." / "**1.**" / "1)"). */
export function splitAnswers(text: string, n: number): string[] {
  if (n <= 1) return [text];
  const marks = [...text.matchAll(/(?:^|\n)\s*(?:#+\s*)?\**\s*(\d)\s*[.)]/g)].filter((m) => Number(m[1]) >= 1 && Number(m[1]) <= n);
  const firsts = new Map<number, number>();
  for (const m of marks) if (!firsts.has(Number(m[1]))) firsts.set(Number(m[1]), m.index!);
  if (firsts.size < 2) return Array.from({ length: n }, () => text);
  const starts = [...firsts.entries()].sort((a, b) => a[1] - b[1]);
  const out = Array.from({ length: n }, () => '');
  starts.forEach(([k, at], i) => (out[k - 1] = text.slice(at, starts[i + 1]?.[1] ?? text.length)));
  return out;
}

// ---- reading facts out of text ----

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const mon = (m: string) => MONTHS.indexOf(m.slice(0, 3).toLowerCase()) + 1;
const iso = (y: number, m: number, d: number) => (m >= 1 && m <= 12 && d >= 1 && d <= 31 ? `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` : null);
const MONTH = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?';

/** Every date in a text, with where it is: 2026-11-10, November 10, 2026, Nov. 10 2026, 10 November 2026, 11/10/2026. */
export function datesIn(text: string): { at: number; date: string }[] {
  const out: { at: number; date: string }[] = [];
  const add = (at: number, d: string | null) => d && out.push({ at, date: d });
  for (const m of text.matchAll(/\b(20\d\d)-(\d\d)-(\d\d)\b/g)) add(m.index!, iso(+m[1], +m[2], +m[3]));
  for (const m of text.matchAll(new RegExp(`\\b${MONTH}\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(20\\d\\d)\\b`, 'gi'))) add(m.index!, iso(+m[3], mon(m[1]), +m[2]));
  for (const m of text.matchAll(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${MONTH},?\\s+(20\\d\\d)\\b`, 'gi'))) add(m.index!, iso(+m[3], mon(m[2]), +m[1]));
  for (const m of text.matchAll(/\b(\d{1,2})\/(\d{1,2})\/(20\d\d)\b/g)) add(m.index!, iso(+m[3], +m[1], +m[2]));
  return out.sort((a, b) => a.at - b.at);
}

/** The first date after a label ("ex-dividend date", "record date"…), within the same sentence or line. */
function dateAfter(text: string, label: RegExp): string | null {
  const dates = datesIn(text);
  for (const m of text.matchAll(new RegExp(label.source, 'gi'))) {
    const from = m.index! + m[0].length;
    const stop = text.slice(from).search(/\n|\.\s+(?=[A-Z(])|;|\b(?:ex[- ]?(?:dividend)?|record|pay(?:ment|able)?)[- ](?:date|on)\b/i);
    const end = stop < 0 ? text.length : from + stop;
    const d = dates.find((x) => x.at >= from && x.at < Math.max(end, from + 1) && x.at <= from + 60);
    if (d) return d.date;
  }
  return null;
}

/** Amounts in a text: $0.56, USD 0.56, 0.56 USD, EUR 0.54. */
export function amountsIn(text: string): { amount: string; currency: string }[] {
  const out: { amount: string; currency: string }[] = [];
  for (const m of text.matchAll(/(?:\$|US\$|USD\s?)(\d{1,6}(?:\.\d{1,6})?)\b/g)) out.push({ amount: m[1], currency: 'USD' });
  for (const m of text.matchAll(/\b(EUR|GBP|CAD|CHF|JPY|AUD|HKD|SEK|NOK|DKK|BRL|MXN|INR|CNY|ZAR|ILS)\s?(\d{1,6}(?:\.\d{1,6})?)\b/g)) out.push({ amount: m[2], currency: m[1] });
  for (const m of text.matchAll(/\b(\d{1,6}(?:\.\d{1,6})?)\s?(USD|EUR|GBP|CAD|CHF|JPY|AUD|HKD)\b/g)) out.push({ amount: m[1], currency: m[2] });
  for (const m of text.matchAll(/[€£](\d{1,6}(?:\.\d{1,6})?)\b/g)) out.push({ amount: m[1], currency: m[0][0] === '€' ? 'EUR' : 'GBP' });
  return out;
}
const sameAmount = (a: string, b: string) => Math.abs(Number(a) - Number(b)) < 1e-9;

/** Split ratios in a text: "4-for-1", "1 for 10", "1:20", "one-for-twenty". */
export function ratiosIn(text: string): { new: number; old: number }[] {
  const W: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12, fifteen: 15, twenty: 20, 'twenty-five': 25, thirty: 30, forty: 40, fifty: 50, hundred: 100 };
  const num = (s: string) => (/^\d+$/.test(s) ? Number(s) : W[s.toLowerCase()] ?? NaN);
  const word = `(\\d{1,4}|${Object.keys(W).join('|')})`;
  const out: { new: number; old: number }[] = [];
  for (const m of text.matchAll(new RegExp(`\\b${word}[- ]for[- ]${word}\\b`, 'gi'))) out.push({ new: num(m[1]), old: num(m[2]) });
  for (const m of text.matchAll(/\b(\d{1,4})\s?:\s?(\d{1,4})\b(?!\s?(?:am|pm|AM|PM))/g)) out.push({ new: +m[1], old: +m[2] });
  return out.filter((r) => r.new > 0 && r.old > 0);
}

/** Contract-shaped strings: 0x addresses, Stellar CODE:ISSUER, and base58 strings long enough to be Solana mints or Tron addresses. */
export function addressesIn(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\b0x[0-9a-fA-F]{40}\b/g)) out.add(m[0]);
  for (const m of text.matchAll(/\b[A-Za-z0-9]{1,12}:G[A-Z2-7]{55}\b/g)) out.add(m[0]);
  for (const m of text.matchAll(/(?<![A-Za-z0-9:])[1-9A-HJ-NP-Za-km-z]{32,44}(?![A-Za-z0-9])/g)) if (/\d/.test(m[0]) && /[a-z]/.test(m[0]) && /[A-Z]/.test(m[0])) out.add(m[0]);
  return [...out];
}

export const isinsIn = (text: string) => [...new Set([...text.matchAll(/\b[A-Z]{2}[A-Z0-9]{9}\d\b/g)].map((m) => m[0]).filter((x) => /\d/.test(x.slice(2))))];

const sameAddress = (a: string, b: string, chain?: Chain) => (chain && CHAINS[chain].caseSensitive ? a === b : a.toLowerCase() === b.toLowerCase());

// ---- grading ----

/** "Ethereum contract (BENJI)", or for one address on several EVM chains, "Ethereum, Base and 6 more chains contract (AAPLx)". */
function contractLabel(ts: { chain: Chain; symbol: string }[]): string {
  const names = ts.map((t) => CHAINS[t.chain].name);
  const chains = names.length <= 2 ? names.join(' and ') : `${names.slice(0, 2).join(', ')} and ${names.length - 2} more chains`;
  return `${chains} contract (${ts[0].symbol})`;
}

const SAYS_UNKNOWN = /\b(unknown|could not find|couldn['’]t find|no (?:information|data|record)|not (?:able|found|available|publicly)|i (?:do not|don['’]t) have)\b/i;

function gradeDate(q: Question['id'], fact: string, expected: string | undefined, stated: string | null, older: string[], source: string): Finding | null {
  if (!expected) return null;
  const verdict: Verdict = stated === null ? 'not-stated' : stated === expected ? 'right' : older.includes(stated) ? 'out-of-date' : 'wrong';
  return { question: q, fact, expected, stated, verdict, source };
}

/** Grade one answer to one question against the subject's key. */
export function gradeAnswer(s: Subject, q: Question, text: string): Finding[] {
  const out: Finding[] = [];
  const push = (f: Finding | null) => f && out.push(f);
  if (q.id === 'dividend') {
    const e = latest(s, ['dividend'])!;
    const older = [...s.events, ...s.older].filter((x) => x.type === 'dividend' && x !== e);
    const src = e.source.url;
    const amounts = amountsIn(text);
    const cash = e.cash!;
    const stated = amounts.find((a) => a.currency === cash.currency) ?? amounts[0];
    out.push({
      question: q.id,
      fact: 'Dividend per share',
      expected: `${cash.currency === 'USD' ? '$' : cash.currency + ' '}${cash.amount}`,
      stated: stated ? `${stated.currency === 'USD' ? '$' : stated.currency + ' '}${stated.amount}` : null,
      verdict: !stated ? 'not-stated' : amounts.some((a) => sameAmount(a.amount, cash.amount)) ? 'right' : older.some((o) => o.cash && amounts.some((a) => sameAmount(a.amount, o.cash!.amount))) ? 'out-of-date' : 'wrong',
      source: src,
    });
    if (out[0].verdict === 'right' && stated && !sameAmount(stated.amount, cash.amount)) out[0].stated = out[0].expected;
    const exStated = dateAfter(text, /\bex[- ]?(?:dividend)?(?:[- ]date)?\b/);
    push(gradeDate(q.id, e.exDateRule ? 'Ex-dividend date (T+1 rule: the record date)' : 'Ex-dividend date', e.dates.ex, exStated, older.map((o) => o.dates.ex!).filter(Boolean), src));
    push(gradeDate(q.id, 'Record date', e.dates.record, dateAfter(text, /\b(?:record date|of record|record)\b/), older.map((o) => o.dates.record!).filter(Boolean), src));
    push(gradeDate(q.id, 'Payment date', e.dates.pay, dateAfter(text, /\b(?:payment date|pay date|payable|paid|payment|pay)\b/), older.map((o) => o.dates.pay!).filter(Boolean), src));
  }
  if (q.id === 'split') {
    const e = latest(s, ['split', 'reverse-split'])!;
    const src = e.source.url;
    const rs = ratiosIn(text);
    const want = e.ratio!;
    // "1-for-20" and "20:1 reverse" both appear: either order counts if the numbers match.
    const hit = rs.find((r) => (r.new === want.new && r.old === want.old) || (r.new === want.old && r.old === want.new && /reverse/i.test(text) === (e.type === 'reverse-split')));
    out.push({ question: q.id, fact: e.type === 'reverse-split' ? 'Reverse split ratio' : 'Split ratio', expected: `${want.new}-for-${want.old}`, stated: hit ? `${want.new}-for-${want.old}` : rs[0] ? `${rs[0].new}-for-${rs[0].old}` : null, verdict: hit ? 'right' : rs.length ? 'wrong' : 'not-stated', source: src });
    push(gradeDate(q.id, 'Takes effect', e.dates.effective, dateAfter(text, /\b(?:effective|takes? effect|begins? trading|post-split|on or about|on)\b/), [], src));
  }
  if (q.id === 'merger') {
    const e = latest(s, ['merger'])!;
    const src = e.source.url;
    if (e.acquirer) {
      const a = core(e.acquirer);
      const said = a && norm(text).includes(a.split(' ').slice(0, 2).join(' '));
      out.push({ question: q.id, fact: 'Acquirer', expected: e.acquirer, stated: said ? e.acquirer : null, verdict: said ? 'right' : SAYS_UNKNOWN.test(text) || !/acqui|merg/i.test(text) ? 'not-stated' : 'wrong', source: src });
    }
    if (e.cash) {
      const amounts = amountsIn(text);
      out.push({ question: q.id, fact: 'Cash per share', expected: `$${e.cash.amount}`, stated: amounts[0] ? `$${amounts.find((x) => sameAmount(x.amount, e.cash!.amount))?.amount ?? amounts[0].amount}` : null, verdict: !amounts.length ? 'not-stated' : amounts.some((x) => sameAmount(x.amount, e.cash!.amount)) ? 'right' : 'wrong', source: src });
    }
    if (e.ratio) {
      const rs = ratiosIn(text);
      const r = text.match(/(\d+(?:\.\d+)?)\s+(?:shares?|of a share)/i);
      const right = rs.some((x) => x.new / x.old === e.ratio!.new / e.ratio!.old) || (r && Number(r[1]) === e.ratio.new / e.ratio.old);
      out.push({ question: q.id, fact: 'Acquirer shares per share', expected: String(e.ratio.new / e.ratio.old), stated: right ? String(e.ratio.new / e.ratio.old) : r?.[1] ?? null, verdict: right ? 'right' : r ? 'wrong' : 'not-stated', source: src });
    }
    push(gradeDate(q.id, 'Takes effect', e.dates.effective, dateAfter(text, /\b(?:effective|close[sd]?|closing|complet(?:ed|ion|e)|takes? effect)\b/), [], src));
  }
  if (q.id === 'tokens') {
    const tokens = s.entries.flatMap((e) => e.tokens.map((t) => ({ ...t, entry: e })));
    const elsewhere = ENTRIES.filter((e) => !s.entries.includes(e)).flatMap((e) => e.tokens.map((t) => ({ ...t, entry: e })));
    for (const a of addressesIn(text)) {
      const mine = tokens.find((t) => sameAddress(t.address, a, t.chain));
      const other = mine ? null : elsewhere.find((t) => sameAddress(t.address, a, t.chain));
      const src = (mine ?? other)?.entry.sources[(mine ?? other)!.source]?.url ?? 'https://iomarkets.tech/asset-map';
      out.push({
        question: q.id,
        fact: mine ? contractLabel(tokens.filter((t) => t.entry === mine.entry && sameAddress(t.address, a, t.chain))) : 'Contract address',
        expected: mine ? mine.address : other ? `not this: it is ${other.entry.security.name}'s ${other.symbol}` : 'not in the Asset Map',
        stated: a,
        // Another listed asset's contract is wrong; an address the map has never seen may be a real issuer it does not cover yet.
        verdict: mine ? 'right' : other ? 'wrong' : 'unverified',
        source: other ? `${src} (it is ${other.entry.security.name}'s ${other.symbol} on ${CHAINS[other.chain].name})` : src,
      });
    }
    const said = new Set(out.filter((f) => f.verdict === 'right').map((f) => f.stated!.toLowerCase()));
    const missing = tokens.filter((t) => !said.has(t.address.toLowerCase()));
    if (missing.length) {
      const chains = [...new Set(missing.map((t) => CHAINS[t.chain].name))];
      out.push({ question: q.id, fact: 'Official contracts not given', expected: `${missing.length} (on ${chains.slice(0, 6).join(', ')}${chains.length > 6 ? ', …' : ''})`, stated: null, verdict: 'not-stated', source: 'https://iomarkets.tech/asset-map' });
    }
    const issuers = [...new Set(s.entries.map((e) => e.security.issuer))];
    const named = issuers.filter((i) => norm(text).includes(core(i).split(' ')[0]));
    out.push({ question: q.id, fact: 'Issuer', expected: issuers.join(', '), stated: named.length ? named.join(', ') : null, verdict: named.length ? 'right' : 'not-stated', source: s.entries[0].sources[0].url });
  }
  if (q.id === 'identity') {
    const e = s.entries[0];
    const found = isinsIn(text);
    if (e.security.isin) out.push({ question: q.id, fact: 'ISIN', expected: e.security.isin, stated: found.includes(e.security.isin) ? e.security.isin : found[0] ?? null, verdict: found.includes(e.security.isin) ? 'right' : found.length ? 'wrong' : 'not-stated', source: e.sources[0].url });
    const said = norm(text).includes(core(e.security.issuer).split(' ')[0]);
    out.push({ question: q.id, fact: 'Issuer', expected: e.security.issuer, stated: said ? e.security.issuer : null, verdict: said ? 'right' : 'not-stated', source: e.sources[0].url });
  }
  return out;
}

export type Visibility = { mentioned: boolean; citations: string[]; primarySourceCited: boolean; ownSiteCited: boolean | null };

/** Whether an answer names the subject at all, what it cites, and whether the primary source is among the citations. */
export function visibility(s: Subject, text: string, citations: string[], ownSite?: string): Visibility {
  const t = norm(text);
  const words = core(s.name);
  const mentioned = (!!words && t.includes(words)) || (!!s.ticker && new RegExp(`\\b${s.ticker.replace(/[^A-Za-z0-9]/g, '')}\\b`, 'i').test(text));
  const hosts = citations.map((c) => (/^https?:/.test(c) ? hostOf(c) : c.toLowerCase().replace(/^www\./, '')));
  const under = (h: string, root: string) => h === root || h.endsWith('.' + root);
  const own = ownSite ? hostOf(/^https?:/.test(ownSite) ? ownSite : `https://${ownSite}`) : '';
  return {
    mentioned,
    citations: [...new Set(citations)].slice(0, 20),
    primarySourceCited: hosts.some((h) => s.primaryHosts.some((p) => under(h, p))),
    ownSiteCited: own ? hosts.some((h) => under(h, own)) : null,
  };
}

/** The answer key as plain lines: what the check grades against, with the source of each fact. */
export function answerKey(s: Subject): string[] {
  const lines: string[] = [];
  const d = latest(s, ['dividend']);
  if (d) lines.push(`Dividend: ${describeEvent(d)} Source: ${d.source.url}`);
  const sp = latest(s, ['split', 'reverse-split']);
  if (sp) lines.push(`Split: ${describeEvent(sp)} Source: ${sp.source.url}`);
  const m = latest(s, ['merger']);
  if (m) lines.push(`Merger: ${describeEvent(m)} Source: ${m.source.url}`);
  for (const e of s.entries.slice(0, 6)) lines.push(`Tokens: ${e.security.name} (${e.security.issuer})${e.security.isin ? `, ISIN ${e.security.isin}` : ''}: ${e.tokens.map((t) => `${CHAINS[t.chain].name} ${t.address}`).join('; ')}. Source: ${e.sources.map((x) => x.url).join(', ')}`);
  if (s.entries.length > 6) lines.push(`…and ${s.entries.length - 6} more Asset Map entries.`);
  return lines;
}

export type Score = { right: number; wrong: number; outOfDate: number; notStated: number; unverified: number; graded: number; accuracy: number | null };

/** Right, wrong and out of date are what the answer stated and the key can judge; accuracy is right over those. Unverified is left out. */
export function score(findings: Finding[]): Score {
  const c = (v: Verdict) => findings.filter((f) => f.verdict === v).length;
  const right = c('right');
  const wrong = c('wrong');
  const outOfDate = c('out-of-date');
  const stated = right + wrong + outOfDate;
  return { right, wrong, outOfDate, notStated: c('not-stated'), unverified: c('unverified'), graded: findings.length, accuracy: stated ? Math.round((100 * right) / stated) : null };
}

/** Grade a whole answer (from any AI, pasted, or one engine's reply) against every question. */
export function gradeAll(s: Subject, qs: Question[], text: string, numbered = false): Finding[] {
  const parts = numbered ? splitAnswers(text, qs.length) : qs.map(() => text);
  return qs.flatMap((q, i) => gradeAnswer(s, q, parts[i] ?? ''));
}
