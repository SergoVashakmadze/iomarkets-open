// Statement reconciliation: match what a bank says happened (an ISO 20022 camt.053 statement
// or camt.054 notification) against what you expected to happen (open invoices, a payment run,
// a ledger export: a CSV or a JSON list), and list the exceptions. The same function runs on
// the iomarkets.tech/reconcile page, behind POST /api/reconcile and in the MCP tool
// reconcile_statement. Pure and deterministic: no AI, no network, nothing stored.
//
// Matching, in order, each line and each expected item used at most once:
//   1. reference: the expected reference equals one of the entry's references (EndToEndId,
//      InstrId, TxId, AcctSvcrRef, UETR, a structured creditor reference…) or appears as a
//      word in its remittance text, with the same amount, currency and direction;
//   2. one payment for several items: an entry whose references or remittance text name two or
//      more expected items, and whose amount is exactly their sum;
//   3. a reference that matches but an amount that doesn't (short or over payment, bank charges
//      taken): reported as an amount mismatch, with the difference;
//   4. amount: same amount, currency and direction, within `days` of the expected date, closest
//      date first; flagged "ambiguous" when more than one entry could be it.
// What is left is either an unexpected entry (on the statement, not expected) or a missing item
// (expected, not on the statement).

import { validate } from './index.ts';
import { parseXml, XmlError, type XmlElement } from './xml.ts';

export type Direction = 'CRDT' | 'DBIT';

/** One booked movement on the statement: an entry, or one transaction of a batch-booked entry. */
export type StatementLine = {
  /** NtryRef (or the entry's position) and, for a batch, the transaction number. */
  id: string;
  amount: string;
  currency: string;
  direction: Direction;
  /** BOOK, PDNG or INFO. */
  status: string;
  bookingDate: string | null;
  valueDate: string | null;
  references: { kind: string; value: string }[];
  remittance: string;
  counterparty: string | null;
  /** Line in the XML where the entry (or transaction) starts. */
  line: number;
};

export type ExpectedItem = {
  /** 1-based row number in the input (the CSV header is row 0). */
  row: number;
  reference: string | null;
  amount: string;
  currency: string;
  direction: Direction;
  date: string | null;
  counterparty: string | null;
};

export type Match = {
  kind: 'reference' | 'group' | 'amount';
  expected: ExpectedItem[];
  line: StatementLine;
  /** Plain words: how it matched and anything to look at. */
  note: string;
  /** For an amount match: other entries that could also be it. */
  ambiguous?: boolean;
};

export type Mismatch = {
  expected: ExpectedItem;
  line: StatementLine;
  /** Statement minus expected, in the currency (signed). */
  difference: string;
  note: string;
};

export type Reconciliation = {
  ok: boolean;
  error?: string;
  statement: {
    message: string | null;
    account: string | null;
    currency: string | null;
    lines: number;
    from: string | null;
    to: string | null;
    /** The Test Bench's own check of the statement (schema and rules), in short. */
    check: { valid: boolean; errors: number; warnings: number; issues: { code: string; message: string; line: number | null }[] };
  };
  expected: { rows: number; skipped: { row: number; reason: string }[] };
  matches: Match[];
  mismatches: Mismatch[];
  unexpected: StatementLine[];
  missing: ExpectedItem[];
  summary: {
    matched: number;
    mismatched: number;
    unexpected: number;
    missing: number;
    /** True when every line and every expected item is matched exactly. */
    reconciled: boolean;
    /** Per currency: what was expected, what the statement shows, both signed (credits +, debits −). */
    totals: { currency: string; expected: string; statement: string; difference: string }[];
  };
};

export type ReconcileOptions = {
  /** How far apart the expected date and the booking or value date may be for an amount match. Default 3. */
  days?: number;
  /** Passed to the Test Bench's check of the statement (tests fix it). */
  now?: Date;
};

export const MAX_EXPECTED = 5000;
const SCALE = 5; // ISO 20022 amounts carry at most 5 decimals
const DAY = 86_400_000;

// ---- decimals ---------------------------------------------------------------------------

/** "1,234.50" → 123450000n (5 implied decimals). null when it isn't a number. */
export function toUnits(raw: string): bigint | null {
  let s = raw.trim().replace(/[\s'_ ]/g, '');
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  if (s.startsWith('-')) { neg = !neg; s = s.slice(1); } else if (s.startsWith('+')) s = s.slice(1);
  s = s.replace(/^[A-Z]{3}/i, '').replace(/[A-Z]{3}$/i, ''); // "EUR 25.00" or "25.00 EUR"
  const dot = s.lastIndexOf('.'), comma = s.lastIndexOf(',');
  if (dot >= 0 && comma >= 0) s = dot > comma ? s.replace(/,/g, '') : s.replace(/\./g, '').replace(',', '.');
  else if (comma >= 0) s = /^\d{1,3}(,\d{3})+$/.test(s) ? s.replace(/,/g, '') : /^\d+,\d{1,5}$/.test(s) ? s.replace(',', '.') : s;
  const m = /^(\d+)(?:\.(\d{0,5}))?$/.exec(s);
  if (!m) return null;
  const v = BigInt(m[1]) * 10n ** BigInt(SCALE) + BigInt((m[2] ?? '').padEnd(SCALE, '0') || '0');
  return neg ? -v : v;
}

/** 123450000n → "1234.50" (at least two decimals, trailing zeros beyond that dropped). */
export function fromUnits(v: bigint): string {
  const neg = v < 0n;
  const a = neg ? -v : v;
  const whole = a / 10n ** BigInt(SCALE);
  let frac = (a % 10n ** BigInt(SCALE)).toString().padStart(SCALE, '0').replace(/0+$/, '');
  if (frac.length < 2) frac = frac.padEnd(2, '0');
  return `${neg ? '-' : ''}${whole}.${frac}`;
}

// ---- the statement ----------------------------------------------------------------------

const kids = (el: XmlElement, name: string) => el.children.filter((c) => c.name === name);
const kid = (el: XmlElement | undefined, path: string): XmlElement | undefined =>
  path.split('/').reduce<XmlElement | undefined>((x, n) => x?.children.find((c) => c.name === n), el);
const txt = (el: XmlElement | undefined, path: string) => kid(el, path)?.text.trim() || null;
const dateOf = (el: XmlElement | undefined) => txt(el, 'Dt') ?? txt(el, 'DtTm')?.slice(0, 10) ?? null;

function findDocument(root: XmlElement): XmlElement | null {
  const queue = [root];
  while (queue.length) {
    const el = queue.shift()!;
    if (el.name === 'Document') return el;
    queue.push(...el.children);
  }
  return null;
}

const REF_TAGS = ['EndToEndId', 'InstrId', 'TxId', 'MsgId', 'PmtInfId', 'AcctSvcrRef', 'ClrSysRef', 'UETR', 'MndtId', 'ChqNb'];

function references(tx: XmlElement | undefined, entry: XmlElement): { kind: string; value: string }[] {
  const out: { kind: string; value: string }[] = [];
  const add = (kind: string, value: string | null) => {
    if (value && value.toUpperCase() !== 'NOTPROVIDED' && !out.some((r) => r.value === value)) out.push({ kind, value });
  };
  const refs = kid(tx, 'Refs');
  for (const t of REF_TAGS) add(t, txt(refs, t));
  for (const s of tx ? kids(kid(tx, 'RmtInf') ?? tx, 'Strd') : []) add('CdtrRef', txt(s, 'CdtrRefInf/Ref'));
  for (const s of tx ? kids(kid(tx, 'RmtInf') ?? tx, 'Strd') : []) for (const d of kids(s, 'RfrdDocInf')) add('RfrdDoc', txt(d, 'Nb'));
  add('AcctSvcrRef', txt(entry, 'AcctSvcrRef'));
  add('NtryRef', txt(entry, 'NtryRef'));
  return out;
}

function remittance(tx: XmlElement | undefined, entry: XmlElement): string {
  const parts: string[] = [];
  const rmt = kid(tx, 'RmtInf');
  if (rmt) parts.push(...kids(rmt, 'Ustrd').map((u) => u.text.trim()));
  const tAdd = txt(tx, 'AddtlTxInf');
  if (tAdd) parts.push(tAdd);
  const eAdd = txt(entry, 'AddtlNtryInf');
  if (eAdd) parts.push(eAdd);
  return parts.filter(Boolean).join(' / ');
}

function counterparty(tx: XmlElement | undefined, dir: Direction): string | null {
  const p = kid(tx, 'RltdPties');
  const side = dir === 'CRDT' ? 'Dbtr' : 'Cdtr';
  return txt(p, `${side}/Pty/Nm`) ?? txt(p, `${side}/Nm`) ?? txt(p, `Ultmt${side}/Pty/Nm`) ?? txt(p, `Ultmt${side}/Nm`);
}

const txAmount = (tx: XmlElement) => kid(tx, 'Amt') ?? kid(tx, 'AmtDtls/TxAmt/Amt') ?? kid(tx, 'AmtDtls/InstdAmt/Amt');

/** Every entry of a camt.053 or camt.054, batch-booked entries split into their transactions when each has its own amount. */
export function statementLines(doc: XmlElement): { lines: StatementLine[]; account: string | null; currency: string | null } {
  const top = doc.children[0];
  const reports = top ? [...kids(top, 'Stmt'), ...kids(top, 'Ntfctn')] : [];
  const lines: StatementLine[] = [];
  let account: string | null = null, currency: string | null = null;
  let n = 0;
  for (const st of reports) {
    account ??= txt(st, 'Acct/Id/IBAN') ?? txt(st, 'Acct/Id/Othr/Id');
    currency ??= txt(st, 'Acct/Ccy');
    for (const e of kids(st, 'Ntry')) {
      n++;
      const amt = kid(e, 'Amt');
      const dir = (txt(e, 'CdtDbtInd') === 'DBIT' ? 'DBIT' : 'CRDT') as Direction;
      const base = {
        currency: amt?.attrs.Ccy ?? currency ?? '',
        status: txt(e, 'Sts/Cd') ?? txt(e, 'Sts/Prtry') ?? txt(e, 'Sts') ?? 'BOOK',
        bookingDate: dateOf(kid(e, 'BookgDt')),
        valueDate: dateOf(kid(e, 'ValDt')),
      };
      const entryId = txt(e, 'NtryRef') ?? `#${n}`;
      const txs = kids(e, 'NtryDtls').flatMap((d) => kids(d, 'TxDtls'));
      const split = txs.length > 1 && txs.every((t) => txAmount(t));
      if (split) {
        txs.forEach((t, k) => {
          const a = txAmount(t)!;
          const d = (txt(t, 'CdtDbtInd') ?? dir) as Direction;
          lines.push({ ...base, id: `${entryId} tx ${k + 1}`, amount: a.text.trim(), currency: a.attrs.Ccy ?? base.currency, direction: d, references: references(t, e), remittance: remittance(t, e), counterparty: counterparty(t, d), line: t.line });
        });
      } else {
        const t = txs[0];
        lines.push({ ...base, id: entryId, amount: amt?.text.trim() ?? '0', direction: dir, references: references(t, e), remittance: remittance(t, e), counterparty: counterparty(t, dir), line: e.line });
      }
    }
  }
  return { lines, account, currency };
}

// ---- what was expected ------------------------------------------------------------------

/** Split CSV text into rows of cells: quotes, doubled quotes, and a comma, semicolon or tab delimiter, guessed from the header. */
export function parseCsv(src: string): string[][] {
  if (src.charCodeAt(0) === 0xfeff) src = src.slice(1);
  const head = src.split(/\r?\n/, 1)[0] ?? '';
  const delim = [',', ';', '\t'].map((d) => [d, head.split(d).length] as const).sort((a, b) => b[1] - a[1])[0]![0];
  const rows: string[][] = [];
  let row: string[] = [], cell = '', quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"' && cell === '') quoted = true;
    else if (c === delim) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((x) => x.trim())) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim())) rows.push(row);
  return rows;
}

/** Column names the CSV may use, lower-case with spaces and punctuation removed. */
const COLUMNS: Record<keyof Omit<ExpectedItem, 'row'>, string[]> = {
  reference: ['reference', 'ref', 'endtoendid', 'e2e', 'invoice', 'invoiceno', 'invoicenumber', 'invoiceid', 'document', 'docno', 'remittance', 'id', 'paymentreference'],
  amount: ['amount', 'amt', 'value', 'sum', 'total', 'gross'],
  currency: ['currency', 'ccy', 'cur'],
  direction: ['direction', 'side', 'type', 'cdtdbtind', 'creditdebit', 'dc', 'drcr', 'inout'],
  date: ['date', 'duedate', 'expecteddate', 'valuedate', 'paymentdate', 'bookingdate', 'settlementdate'],
  counterparty: ['counterparty', 'name', 'customer', 'supplier', 'vendor', 'payer', 'payee', 'party', 'debtor', 'creditor'],
};
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

function direction(raw: string | null): Direction | null {
  const v = norm(raw ?? '');
  if (!v) return null;
  if (['credit', 'cr', 'crdt', 'c', 'in', 'incoming', 'receipt', 'received', 'receivable', 'ar'].includes(v)) return 'CRDT';
  if (['debit', 'dr', 'dbit', 'd', 'out', 'outgoing', 'payment', 'paid', 'payable', 'ap'].includes(v)) return 'DBIT';
  return null;
}

function isoDate(raw: string | null): string | null | undefined {
  const v = (raw ?? '').trim();
  if (!v) return null;
  const m = /^(\d{4})[-/.](\d{2})[-/.](\d{2})/.exec(v);
  if (!m) return undefined;
  const d = `${m[1]}-${m[2]}-${m[3]}`;
  return Number.isNaN(Date.parse(`${d}T00:00:00Z`)) ? undefined : d;
}

/**
 * What was expected, from CSV text (a header row naming the columns) or a JSON list of objects
 * with the same names. Amount is required; a negative amount is a debit unless a direction column
 * says otherwise, and with neither an amount is a credit. Currency defaults to the statement's.
 */
export function parseExpected(input: string | unknown[], defaultCurrency: string | null): { items: ExpectedItem[]; skipped: { row: number; reason: string }[]; error?: string } {
  let records: Record<string, string>[];
  if (Array.isArray(input)) {
    records = input.map((r) => (r && typeof r === 'object' ? Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v == null ? '' : String(v)])) : {}));
  } else {
    const t = input.trim();
    if (t.startsWith('[')) {
      try {
        const j = JSON.parse(t);
        if (Array.isArray(j)) return parseExpected(j, defaultCurrency);
      } catch { return { items: [], skipped: [], error: 'The expected list looks like JSON but cannot be read.' }; }
    }
    const rows = parseCsv(t);
    if (rows.length < 2) return { items: [], skipped: [], error: 'The expected list needs a header row (reference, amount, currency, direction, date, counterparty) and at least one row.' };
    const header = rows[0]!;
    records = rows.slice(1).map((r) => Object.fromEntries(header.map((h, k) => [h, r[k] ?? ''])));
  }
  if (records.length > MAX_EXPECTED) return { items: [], skipped: [], error: `The expected list has ${records.length.toLocaleString('en')} rows; the most it takes is ${MAX_EXPECTED.toLocaleString('en')}.` };
  const keys = Object.keys(records[0] ?? {});
  const col = (field: keyof typeof COLUMNS) => {
    for (const alias of COLUMNS[field]) { const k = keys.find((x) => norm(x) === alias); if (k) return k; }
    return null;
  };
  const c = Object.fromEntries((Object.keys(COLUMNS) as (keyof typeof COLUMNS)[]).map((f) => [f, col(f)])) as Record<keyof typeof COLUMNS, string | null>;
  if (!c.amount) return { items: [], skipped: [], error: `No amount column. Columns found: ${keys.join(', ') || 'none'}. Name one "amount".` };
  const items: ExpectedItem[] = [];
  const skipped: { row: number; reason: string }[] = [];
  records.forEach((r, k) => {
    const row = k + 1;
    const get = (f: keyof typeof COLUMNS) => (c[f] ? (r[c[f]!] ?? '').trim() || null : null);
    const units = toUnits(get('amount') ?? '');
    if (units === null) return skipped.push({ row, reason: `"${get('amount') ?? ''}" is not an amount.` });
    if (units === 0n) return skipped.push({ row, reason: 'The amount is zero.' });
    const said = get('direction');
    const dir = direction(said);
    if (said && !dir) return skipped.push({ row, reason: `"${said}" is not a direction: use credit or debit (in or out).` });
    const date = isoDate(get('date'));
    if (date === undefined) return skipped.push({ row, reason: `"${get('date')}" is not a date: write it as YYYY-MM-DD.` });
    const currency = (get('currency') ?? defaultCurrency ?? '').toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) return skipped.push({ row, reason: 'No currency, and the statement does not give one.' });
    items.push({
      row,
      reference: get('reference'),
      amount: fromUnits(units < 0n ? -units : units),
      currency,
      direction: dir ?? (units < 0n ? 'DBIT' : 'CRDT'),
      date: date ?? null,
      counterparty: get('counterparty'),
    });
  });
  return { items, skipped };
}

// ---- matching ---------------------------------------------------------------------------

const refKey = (s: string) => s.toUpperCase().replace(/\s+/g, '');
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** How a reference ties to a line: 2 = one of its references, 1 = a word in its remittance text, 0 = not at all. */
function refHit(ref: string | null, l: StatementLine): 0 | 1 | 2 {
  if (!ref) return 0;
  const k = refKey(ref);
  if (l.references.some((r) => refKey(r.value) === k)) return 2;
  if (ref.trim().length < 4) return 0;
  const re = new RegExp(`(^|[^A-Z0-9])${escapeRe(ref.trim().toUpperCase()).replace(/\\? +/g, '\\s*')}($|[^A-Z0-9])`);
  return re.test(l.remittance.toUpperCase()) || l.references.some((r) => re.test(r.value.toUpperCase())) ? 1 : 0;
}

const days = (a: string | null, b: string | null) => (a && b ? Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / DAY : null);
const gap = (e: ExpectedItem, l: StatementLine) => {
  const g = [days(e.date, l.bookingDate), days(e.date, l.valueDate)].filter((x): x is number => x !== null);
  return g.length ? Math.min(...g) : null;
};
const signed = (amount: string, dir: Direction) => (dir === 'DBIT' ? -1n : 1n) * (toUnits(amount) ?? 0n);
const same = (e: ExpectedItem, l: StatementLine) => e.currency === l.currency && e.direction === l.direction;
const name = (e: ExpectedItem) => (e.reference ? `"${e.reference}"` : `row ${e.row}`);

export function matchLines(lines: StatementLine[], items: ExpectedItem[], opts: ReconcileOptions = {}): Pick<Reconciliation, 'matches' | 'mismatches' | 'unexpected' | 'missing'> {
  const window = opts.days ?? 3;
  const usedL = new Set<StatementLine>(), usedE = new Set<ExpectedItem>();
  const matches: Match[] = [], mismatches: Mismatch[] = [];
  const freeL = () => lines.filter((l) => !usedL.has(l));
  const take = (m: Match) => { matches.push(m); usedL.add(m.line); m.expected.forEach((e) => usedE.add(e)); };
  const equal = (e: ExpectedItem, l: StatementLine) => same(e, l) && toUnits(e.amount) === toUnits(l.amount);

  // 1. Reference and exact amount: references beat remittance text.
  for (const strength of [2, 1] as const) {
    for (const e of items) {
      if (usedE.has(e) || !e.reference) continue;
      const l = freeL().find((x) => refHit(e.reference, x) === strength && equal(e, x));
      if (l) take({ kind: 'reference', expected: [e], line: l, note: strength === 2 ? `Reference ${name(e)} is the entry's ${l.references.find((r) => refKey(r.value) === refKey(e.reference!))!.kind}; amount, currency and direction agree.` : `Reference ${name(e)} is in the remittance text; amount, currency and direction agree.` });
    }
  }

  // 2. One payment for several items: the line names them, and they add up to it exactly.
  for (const l of freeL()) {
    const named = items.filter((e) => !usedE.has(e) && same(e, l) && refHit(e.reference, l));
    if (named.length < 2) continue;
    const total = named.reduce((s, e) => s + (toUnits(e.amount) ?? 0n), 0n);
    if (total === toUnits(l.amount)) take({ kind: 'group', expected: named, line: l, note: `One ${l.direction === 'CRDT' ? 'receipt' : 'payment'} for ${named.length} items (${named.map(name).join(', ')}): they add up to ${l.currency} ${fromUnits(total)}.` });
  }

  // 3. Reference agrees, amount doesn't.
  for (const strength of [2, 1] as const) {
    for (const e of items) {
      if (usedE.has(e) || !e.reference) continue;
      const l = freeL().find((x) => refHit(e.reference, x) === strength && x.direction === e.direction);
      if (!l) continue;
      usedL.add(l); usedE.add(e);
      if (l.currency !== e.currency) {
        mismatches.push({ expected: e, line: l, difference: '', note: `Reference ${name(e)} matches, but the statement has ${l.currency} ${l.amount} and you expected ${e.currency} ${e.amount}: a different currency.` });
        continue;
      }
      const diff = (toUnits(l.amount) ?? 0n) - (toUnits(e.amount) ?? 0n);
      const what = l.direction === 'CRDT' ? (diff < 0n ? 'Short paid' : 'Over paid') : diff < 0n ? 'Paid less than expected' : 'Paid more than expected';
      mismatches.push({ expected: e, line: l, difference: fromUnits(diff), note: `${what} by ${l.currency} ${fromUnits(diff < 0n ? -diff : diff)}: reference ${name(e)} matches, the statement has ${l.amount}, you expected ${e.amount}.` });
    }
  }

  // 4. Amount and date, closest first.
  const candidates = items
    .filter((e) => !usedE.has(e))
    .map((e) => ({ e, ls: freeL().filter((l) => equal(e, l) && (gap(e, l) ?? 0) <= window) }))
    .filter((x) => x.ls.length)
    .sort((a, b) => a.ls.length - b.ls.length);
  for (const { e, ls } of candidates) {
    const open = ls.filter((l) => !usedL.has(l)).sort((a, b) => (gap(e, a) ?? 0) - (gap(e, b) ?? 0));
    const l = open[0];
    if (!l) continue;
    const g = gap(e, l);
    const ambiguous = open.length > 1;
    take({
      kind: 'amount',
      expected: [e],
      line: l,
      ambiguous,
      note: `${e.reference ? `Reference ${name(e)} is not on the statement; matched` : 'Matched'} on amount, currency and direction${g === null ? '' : g === 0 ? ', same day' : `, ${g} day${g === 1 ? '' : 's'} apart`}.${ambiguous ? ` ${open.length - 1} other entr${open.length === 2 ? 'y' : 'ies'} could also be it: check.` : ''}`,
    });
  }

  const pos = (l: StatementLine) => lines.indexOf(l);
  matches.sort((a, b) => pos(a.line) - pos(b.line));
  mismatches.sort((a, b) => pos(a.line) - pos(b.line));
  return { matches, mismatches, unexpected: lines.filter((l) => !usedL.has(l)), missing: items.filter((e) => !usedE.has(e)) };
}

// ---- the whole thing --------------------------------------------------------------------

const emptyStatement = (): Reconciliation['statement'] => ({ message: null, account: null, currency: null, lines: 0, from: null, to: null, check: { valid: false, errors: 0, warnings: 0, issues: [] } });
const failed = (error: string, statement = emptyStatement()): Reconciliation => ({
  ok: false, error, statement, expected: { rows: 0, skipped: [] }, matches: [], mismatches: [], unexpected: [], missing: [],
  summary: { matched: 0, mismatched: 0, unexpected: 0, missing: 0, reconciled: false, totals: [] },
});

/** Reconcile a camt.053 or camt.054 against what was expected (CSV text or a JSON list). */
export function reconcile(xml: string, expected: string | unknown[], opts: ReconcileOptions = {}): Reconciliation {
  let root: XmlElement;
  try {
    root = parseXml(xml);
  } catch (e) {
    return failed(e instanceof XmlError ? `The statement is not well-formed XML (line ${e.line}): ${e.message}` : 'The statement is not well-formed XML.');
  }
  const doc = findDocument(root);
  const ns = doc?.ns ?? '';
  const message = /(camt\.05[34]\.\d{3}\.\d{2})$/.exec(ns)?.[1] ?? null;
  if (!doc || !message) return failed('Give a bank statement: an ISO 20022 camt.053.001.08 (statement) or camt.054.001.08 (notification).');
  const report = validate(xml, { now: opts.now });
  const { lines, account, currency } = statementLines(doc);
  const dates = lines.flatMap((l) => [l.bookingDate ?? l.valueDate]).filter((d): d is string => !!d).sort();
  const statement: Reconciliation['statement'] = {
    message, account, currency, lines: lines.length, from: dates[0] ?? null, to: dates[dates.length - 1] ?? null,
    check: {
      valid: report.valid,
      errors: report.errors,
      warnings: report.warnings,
      issues: report.issues.filter((i) => i.severity === 'error').slice(0, 5).map((i) => ({ code: i.code, message: i.message, line: i.line ?? null })),
    },
  };
  if (!lines.length) return failed('The statement has no entries to reconcile.', statement);
  const parsed = parseExpected(expected, currency ?? lines[0]!.currency);
  if (parsed.error) return failed(parsed.error, statement);
  if (!parsed.items.length) return { ...failed('No usable rows in the expected list.', statement), expected: { rows: 0, skipped: parsed.skipped } };

  const m = matchLines(lines, parsed.items, opts);
  const totals = new Map<string, { e: bigint; s: bigint }>();
  for (const e of parsed.items) { const t = totals.get(e.currency) ?? { e: 0n, s: 0n }; t.e += signed(e.amount, e.direction); totals.set(e.currency, t); }
  for (const l of lines) { const t = totals.get(l.currency) ?? { e: 0n, s: 0n }; t.s += signed(l.amount, l.direction); totals.set(l.currency, t); }
  const matched = m.matches.reduce((n, x) => n + x.expected.length, 0);
  return {
    ok: true,
    statement,
    expected: { rows: parsed.items.length, skipped: parsed.skipped },
    ...m,
    summary: {
      matched,
      mismatched: m.mismatches.length,
      unexpected: m.unexpected.length,
      missing: m.missing.length,
      reconciled: !m.mismatches.length && !m.unexpected.length && !m.missing.length,
      totals: [...totals].sort(([a], [b]) => a.localeCompare(b)).map(([c, t]) => ({ currency: c, expected: fromUnits(t.e), statement: fromUnits(t.s), difference: fromUnits(t.s - t.e) })),
    },
  };
}

// ---- output -----------------------------------------------------------------------------

const money = (l: { amount: string; currency: string; direction: Direction }) => `${l.direction === 'DBIT' ? '-' : '+'}${l.currency} ${l.amount}`;
const when = (l: StatementLine) => l.bookingDate ?? l.valueDate ?? 'no date';

/** The result in plain text, for the MCP tool and the CLI. */
export function formatReconciliation(r: Reconciliation): string {
  if (!r.ok) return `Could not reconcile: ${r.error}${r.expected.skipped.length ? `\nSkipped rows:\n${r.expected.skipped.map((s) => `- row ${s.row}: ${s.reason}`).join('\n')}` : ''}`;
  const s = r.summary;
  const out = [
    `${s.reconciled ? 'Reconciled' : 'Not reconciled'}: ${r.statement.lines} statement line${r.statement.lines === 1 ? '' : 's'} (${r.statement.message}${r.statement.account ? `, account ${r.statement.account}` : ''}${r.statement.from ? `, ${r.statement.from}${r.statement.to !== r.statement.from ? ` to ${r.statement.to}` : ''}` : ''}) against ${r.expected.rows} expected item${r.expected.rows === 1 ? '' : 's'}.`,
    `${s.matched} matched, ${s.mismatched} amount mismatch${s.mismatched === 1 ? '' : 'es'}, ${s.unexpected} unexpected on the statement, ${s.missing} missing from it.`,
    ...s.totals.map((t) => `${t.currency}: expected net ${t.expected}, statement net ${t.statement}, difference ${t.difference}.`),
  ];
  if (!r.statement.check.valid) out.push(`The statement itself fails the Test Bench (${r.statement.check.errors} error${r.statement.check.errors === 1 ? '' : 's'}): ${r.statement.check.issues.map((i) => i.code).join(', ')}. Check it with validate_message.`);
  if (r.mismatches.length) out.push('', 'Amount mismatches:', ...r.mismatches.map((x) => `- ${x.line.id} (${when(x.line)}, ${money(x.line)}): ${x.note}`));
  if (r.unexpected.length) out.push('', 'On the statement, not expected:', ...r.unexpected.map((l) => `- ${l.id} (${when(l)}, ${money(l)})${l.counterparty ? ` ${l.counterparty}` : ''}${l.remittance ? `: "${l.remittance}"` : ''}${l.status !== 'BOOK' ? ` [${l.status}]` : ''}`));
  if (r.missing.length) out.push('', 'Expected, not on the statement:', ...r.missing.map((e) => `- row ${e.row} ${e.reference ?? '(no reference)'} ${money(e)}${e.date ? ` due ${e.date}` : ''}${e.counterparty ? ` ${e.counterparty}` : ''}`));
  if (r.matches.length) out.push('', 'Matched:', ...r.matches.map((x) => `- ${x.line.id} (${when(x.line)}, ${money(x.line)})${x.ambiguous ? ' [check]' : ''}: ${x.note}`));
  if (r.expected.skipped.length) out.push('', 'Skipped rows of the expected list:', ...r.expected.skipped.map((x) => `- row ${x.row}: ${x.reason}`));
  return out.join('\n');
}

/** A CSV cell, quoted when needed; text a spreadsheet would run as a formula is prefixed with '. */
const cell = (v: string | number | null | undefined) => {
  let s = v == null ? '' : String(v);
  if (/^[=+@\t\r]/.test(s) || /^-[^\d]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** One row per outcome, for a spreadsheet: the exception list a reviewer works through. */
export function reconciliationCsv(r: Reconciliation): string {
  const head = ['status', 'statement_line', 'booking_date', 'statement_amount', 'currency', 'direction', 'counterparty', 'expected_rows', 'expected_reference', 'expected_amount', 'difference', 'note'];
  const rows: (string | number | null)[][] = [];
  for (const m of r.mismatches) rows.push(['amount_mismatch', m.line.id, when(m.line), m.line.amount, m.line.currency, m.line.direction, m.line.counterparty, m.expected.row, m.expected.reference, m.expected.amount, m.difference, m.note]);
  for (const l of r.unexpected) rows.push(['unexpected', l.id, when(l), l.amount, l.currency, l.direction, l.counterparty, null, null, null, null, l.remittance]);
  for (const e of r.missing) rows.push(['missing', null, e.date, null, e.currency, e.direction, e.counterparty, e.row, e.reference, e.amount, null, null]);
  for (const m of r.matches) rows.push([m.ambiguous ? 'matched_check' : 'matched', m.line.id, when(m.line), m.line.amount, m.line.currency, m.line.direction, m.line.counterparty, m.expected.map((e) => e.row).join(' '), m.expected.map((e) => e.reference ?? '').join(' '), m.expected.map((e) => e.amount).join(' '), null, m.note]);
  return [head, ...rows].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}
