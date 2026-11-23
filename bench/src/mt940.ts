// MT940 to camt.053: turn a SWIFT MT940 customer statement into an ISO 20022 camt.053.001.08,
// check that the MT940 adds up (opening balance plus entries is the closing balance), and run the
// result through the Test Bench. The same function runs on the iomarkets.tech/convert page, behind
// POST /api/convert and in the MCP tool convert_mt940. Pure and deterministic: no AI, no network,
// nothing stored.
//
// What it reads:
//   - one MT940 or several back to back, bare or inside SWIFT blocks ({1:…}{2:…}{4:… -});
//   - :20: reference, :25:/:25P: account (an IBAN when it is one, else the account number as given,
//     with the BIC when the field carries one), :28C: statement and page number;
//   - balances :60F:/:60M: (opening, first or intermediate page), :62F:/:62M: (closing),
//     :64: (closing available), :65: (forward available);
//   - :61: statement lines: value date, entry date, debit/credit and reversals (RC, RD), amount,
//     the SWIFT transaction type (NTRF, NCHG…), the account owner's reference, the bank's
//     reference and the supplementary details;
//   - :86: information to the account owner, in the three layouts banks use: SWIFT-style keywords
//     (/EREF/…/REMI/…/ORDP//NAME/…), the German "?" subfields (?20 to ?29 purpose with EREF+ and
//     SVWZ+, ?31 IBAN, ?32 and ?33 name), or free text.
// Where it goes (camt.053.001.08):
//   60F → Bal OPBD, 60M/62M → Bal ITBD, 62F → Bal CLBD, 64 → Bal CLAV, 65 → Bal FWAV;
//   :61: → Ntry (Amt, CdtDbtInd, RvslInd for RC/RD, Sts BOOK, BookgDt, ValDt, AcctSvcrRef,
//   BkTxCd/Prtry with issuer SWIFT), with one TxDtls carrying Refs/EndToEndId (EREF, else the
//   owner's reference unless it is NONREF), MndtId (MREF), the counterparty (Dbtr on a credit, Cdtr on
//   a debit) and its IBAN, RmtInf/Ustrd (REMI or SVWZ, else the free text), AddtlTxInf (the
//   :61: supplementary details); the whole :86: as AddtlNtryInf when part of it (bank-specific codes,
//   booking keys) has no camt.053 field. A :86: after the closing balance
//   goes to AddtlStmtInf.

import { validate, type Report } from './index.ts';
import { ibanChecksumOk, minorUnits, CURRENCIES } from './codes.ts';

export type NoteSeverity = 'error' | 'warning' | 'info';
export type ConversionNote = { severity: NoteSeverity; code: string; line: number; message: string };

export type Mt940Balance = { kind: 'OPBD' | 'ITBD' | 'CLBD' | 'CLAV' | 'FWAV'; tag: string; direction: 'CRDT' | 'DBIT'; date: string; currency: string; amount: string; line: number };

export type Mt940Entry = {
  line: number;
  valueDate: string;
  bookingDate: string;
  direction: 'CRDT' | 'DBIT';
  reversal: boolean;
  amount: string;
  /** SWIFT transaction type: N, F or S and three characters, e.g. NTRF. */
  type: string;
  ownerReference: string | null;
  bankReference: string | null;
  supplementary: string | null;
  /** :86: as sent, unwrapped. */
  info: string | null;
  /** Keep the whole :86: as AddtlNtryInf: a structured one with something no camt.053 field took. */
  keepInfo: boolean;
  endToEndId: string | null;
  mandateId: string | null;
  counterparty: string | null;
  counterpartyIban: string | null;
  remittance: string | null;
};

export type Mt940Statement = {
  line: number;
  reference: string;
  account: string | null;
  accountIsIban: boolean;
  bic: string | null;
  number: string | null;
  page: string | null;
  currency: string | null;
  balances: Mt940Balance[];
  entries: Mt940Entry[];
  info: string | null;
};

export type StatementSummary = {
  reference: string;
  account: string | null;
  currency: string | null;
  from: string | null;
  to: string | null;
  opening: string | null;
  closing: string | null;
  entries: number;
  credits: string;
  debits: string;
  /** Opening plus entries equals closing, in the MT940 itself. null when a balance is missing. */
  balanced: boolean | null;
};

export type Conversion = {
  ok: boolean;
  error?: string;
  /** The camt.053.001.08, when at least one statement could be read. */
  xml: string | null;
  statements: StatementSummary[];
  entries: number;
  notes: ConversionNote[];
  /** The Test Bench's report on the camt.053 produced. */
  check: Report | null;
};

export type ConvertOptions = {
  /** Creation time written to GrpHdr/CreDtTm, and "now" for the Test Bench (tests fix it). */
  now?: Date;
  /** GrpHdr/MsgId; defaults to MT940- and the first statement's :20:. */
  messageId?: string;
};

export const MAX_MT940 = 2_000_000;
export const MAX_ENTRIES = 20_000;
export const CAMT_053 = 'camt.053.001.08';

// ---- small helpers ----------------------------------------------------------------------

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);
const squash = (s: string) => s.replace(/\s+/g, ' ').trim();

/** YYMMDD → YYYY-MM-DD (SWIFT: 00-79 is 20xx, 80-99 is 19xx). null when it isn't a date. */
export function swiftDate(yymmdd: string): string | null {
  if (!/^\d{6}$/.test(yymmdd)) return null;
  const yy = Number(yymmdd.slice(0, 2));
  const iso = `${yy < 80 ? 2000 + yy : 1900 + yy}-${yymmdd.slice(2, 4)}-${yymmdd.slice(4, 6)}`;
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso ? null : iso;
}

/** The entry date (MMDD) next to a value date: the same year, or the next or previous one across New Year. */
function entryDate(mmdd: string, valueDate: string): string | null {
  const year = Number(valueDate.slice(0, 4));
  const month = Number(mmdd.slice(0, 2));
  const vMonth = Number(valueDate.slice(5, 7));
  const y = month - vMonth > 6 ? year - 1 : vMonth - month > 6 ? year + 1 : year;
  const iso = `${y}-${mmdd.slice(0, 2)}-${mmdd.slice(2, 4)}`;
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso ? null : iso;
}

/** "1234,5" → "1234.50" in the currency's minor units (more decimals than that are kept). null when it isn't an MT amount. */
export function swiftAmount(raw: string, currency: string | null): string | null {
  const m = /^(\d{1,15}),(\d*)$/.exec(raw);
  if (!m) return null;
  const whole = m[1].replace(/^0+(?=\d)/, '');
  const minor = currency ? minorUnits(currency) ?? 2 : 2;
  const frac = m[2].replace(/0+$/, '');
  const digits = Math.max(minor, frac.length);
  return digits ? `${whole}.${frac.padEnd(digits, '0')}` : whole;
}

// Exact decimal arithmetic on amounts with up to 5 decimals.
const SCALE = 5;
const units = (s: string) => {
  const neg = s.startsWith('-');
  const [i, f = ''] = s.replace(/^-/, '').split('.');
  const v = BigInt(i || '0') * 10n ** BigInt(SCALE) + BigInt(f.padEnd(SCALE, '0').slice(0, SCALE) || '0');
  return neg ? -v : v;
};
const decimal = (v: bigint, minor: number) => {
  const neg = v < 0n;
  const a = neg ? -v : v;
  const whole = a / 10n ** BigInt(SCALE);
  let frac = (a % 10n ** BigInt(SCALE)).toString().padStart(SCALE, '0').replace(/0+$/, '');
  if (frac.length < minor) frac = frac.padEnd(minor, '0');
  return `${neg ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
};

const IBAN = /^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/;
const BIC = /^[A-Z0-9]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/;
const isIban = (s: string) => IBAN.test(s) && ibanChecksumOk(s);

// ---- reading the MT940 ------------------------------------------------------------------

type Field = { tag: string; value: string; line: number };

/** The text of each message: the {4: … -} block when SWIFT blocks are there, else the whole input. */
function messages(src: string): { text: string; line: number }[] {
  const text = src.replace(/\r\n?/g, '\n');
  if (!/\{4:/.test(text)) return [{ text, line: 1 }];
  const out: { text: string; line: number }[] = [];
  const re = /\{4:\s*\n?([\s\S]*?)(?:\n-\}|-\})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const before = text.slice(0, m.index + m[0].indexOf(m[1]));
    out.push({ text: m[1], line: before.split('\n').length });
  }
  return out;
}

/** Fields in order: ":TAG:value" starts one, other lines continue it (kept as separate lines). */
function fields(text: string, firstLine: number, notes: ConversionNote[]): Field[] {
  const out: Field[] = [];
  text.split('\n').forEach((raw, k) => {
    const line = firstLine + k;
    const s = raw.replace(/\s+$/, '');
    const m = /^:(\d{2}[A-Z]?):(.*)$/.exec(s);
    if (m) out.push({ tag: m[1], value: m[2], line });
    else if (s === '-' || s === '' || s === '-}') return;
    else if (out.length) out[out.length - 1].value += `\n${s}`;
    else if (!/^\{[1-5]:/.test(s)) notes.push({ severity: 'warning', code: 'TEXT_BEFORE_FIELDS', line, message: `Line ${line} comes before the first field (":20:") and was skipped.` });
  });
  return out;
}

const KEYWORDS = ['EREF', 'KREF', 'MREF', 'PREF', 'IREF', 'MARF', 'CSID', 'REMI', 'NAME', 'IBAN', 'BIC', 'ORDP', 'BENM', 'CNTP', 'TRTP', 'ULTD', 'ULTB', 'PURP', 'RTRN', 'ISDT', 'OCMT', 'ADDR', 'ID', 'USTD', 'STRD', 'CDTRREF', 'CDTRREFTP', 'CD', 'ISSR', 'SVCL', 'EXCH', 'CHGS', 'ACCW', 'BUSP', 'ROC', 'RTYP'];

/** :86: lines are cut at 65 characters: a full line runs on into the next one, a shorter one ends a phrase. */
export function unwrap(info: string): string {
  const lines = info.split('\n');
  return lines.reduce((acc, l, k) => (k === 0 ? l : acc + (lines[k - 1].length >= 65 ? '' : ' ') + l), '');
}

/**
 * What :86: says about the transaction, in whichever layout the bank used. `complete` is true when
 * everything in a structured :86: went to a camt.053 field; when it is false (bank-specific codes,
 * booking keys, addresses…) the converter also keeps the whole :86: as AddtlNtryInf, so nothing is lost.
 */
export type Info = { endToEndId: string | null; mandateId: string | null; counterparty: string | null; iban: string | null; remittance: string | null; structured: boolean; complete: boolean };

/** German subfields the converter maps: ?00 booking text (said again by the transaction type), purpose ?20-?29 and ?60-?63, ?31 IBAN, ?32-?33 name. */
const GERMAN_MAPPED = new Set(['00', '20', '21', '22', '23', '24', '25', '26', '27', '28', '29', '60', '61', '62', '63', '31', '32', '33']);
/** SWIFT-style keywords the converter maps. */
const SWIFT_MAPPED = new Set(['EREF', 'MARF', 'MREF', 'REMI', 'USTD', 'ORDP', 'BENM', 'CNTP', 'NAME', 'IBAN']);

export function readInfo(info: string): Info {
  const flat = info.replace(/\n/g, '');
  const pick = (v: string | undefined | null) => {
    const s = v ? squash(v) : '';
    return s && !/^(NOTPROVIDED|NONREF)$/i.test(s) ? s : null;
  };

  // German layout: "166?00SEPA-UEBERWEISUNG?20EREF+…?21SVWZ+…?32Name"
  if (/^\d{3}\?/.test(flat) || /\?2\d/.test(flat)) {
    const sub: Record<string, string> = {};
    for (const m of flat.matchAll(/\?(\d{2})([^?]*)/g)) sub[m[1]] = (sub[m[1]] ?? '') + m[2];
    const purpose = ['20', '21', '22', '23', '24', '25', '26', '27', '28', '29', '60', '61', '62', '63'].map((k) => sub[k] ?? '').join('');
    const tagged: Record<string, string> = {};
    const parts = purpose.split(/(EREF|KREF|MREF|CRED|DEBT|COAM|OAMT|SVWZ|ABWA|ABWE|IBAN|BIC)\+/);
    for (let i = 1; i < parts.length; i += 2) tagged[parts[i]] = (tagged[parts[i]] ?? '') + parts[i + 1];
    const remittance = pick(tagged.SVWZ) ?? (parts.length === 1 ? pick(purpose) : null);
    const complete = Object.keys(sub).every((k) => GERMAN_MAPPED.has(k)) && Object.keys(tagged).every((k) => k === 'EREF' || k === 'MREF' || k === 'SVWZ');
    const iban = (sub['31'] ?? '').replace(/\s/g, '').toUpperCase();
    return {
      endToEndId: pick(tagged.EREF),
      mandateId: pick(tagged.MREF),
      counterparty: pick(`${sub['32'] ?? ''}${sub['33'] ?? ''}`),
      iban: isIban(iban) ? iban : null,
      remittance,
      structured: true,
      complete,
    };
  }

  // SWIFT-style keywords: "/EREF/ref/REMI/USTD//text/ORDP//NAME/Name/"
  if (flat.startsWith('/') && new RegExp(`/(${KEYWORDS.join('|')})/`).test(flat)) {
    const re = new RegExp(`/(${KEYWORDS.join('|')})/`, 'g');
    const keys: { k: string; at: number; end: number }[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(flat))) {
      keys.push({ k: m[1], at: m.index, end: m.index + m[0].length });
      re.lastIndex = m.index + m[0].length - 1; // the closing slash can open the next keyword
    }
    const val: Record<string, string> = {};
    let party: string | null = null;
    keys.forEach((x, i) => {
      const v = flat.slice(x.end, i + 1 < keys.length ? keys[i + 1].at : undefined).replace(/^\/+|\/+$/g, '');
      if (x.k === 'ORDP' || x.k === 'BENM' || x.k === 'CNTP') party = x.k;
      const key = x.k === 'NAME' && party ? `${party}.NAME` : x.k === 'IBAN' && party ? `${party}.IBAN` : x.k;
      if (!val[key]) val[key] = v;
    });
    const name = val['ORDP.NAME'] || val['BENM.NAME'] || val['CNTP.NAME'] || val.NAME || null;
    const iban = (val['ORDP.IBAN'] || val['BENM.IBAN'] || val['CNTP.IBAN'] || val.IBAN || '').replace(/\s/g, '').toUpperCase();
    // /CNTP/IBAN/BIC/NAME/CITY/: positional
    let cntp: string[] = [];
    if (!name && val.CNTP) cntp = val.CNTP.split('/');
    const remi = val.REMI || val.USTD || null;
    return {
      endToEndId: pick(val.EREF),
      mandateId: pick(val.MARF || val.MREF),
      counterparty: pick(name ?? cntp[2] ?? null),
      iban: isIban(iban) ? iban : isIban((cntp[0] ?? '').toUpperCase()) ? cntp[0].toUpperCase() : null,
      remittance: pick(remi?.replace(/^USTD\/+/, '').replace(/^STRD\/+.*?\/+/, '') ?? null),
      structured: true,
      complete: keys.every((x) => SWIFT_MAPPED.has(x.k)) && !cntp.length,
    };
  }

  return { endToEndId: null, mandateId: null, counterparty: null, iban: null, remittance: pick(unwrap(info)), structured: false, complete: true };
}

const BALANCE = /^([CD])(\d{6})([A-Z]{3})(\d{1,15},\d*)$/;
const LINE61 = /^(\d{6})(\d{4})?(RC|RD|C|D)([A-Z])?(\d{1,15},\d*)([NFS][A-Z0-9]{3})(.*)$/;

function balance(f: Field, kind: Mt940Balance['kind'], notes: ConversionNote[]): Mt940Balance | null {
  const m = BALANCE.exec(f.value.replace(/\s/g, ''));
  const date = m ? swiftDate(m[2]) : null;
  const amount = m ? swiftAmount(m[4], m[3]) : null;
  if (!m || !date || !amount) {
    notes.push({ severity: 'error', code: 'BAD_BALANCE', line: f.line, message: `:${f.tag}: should look like C261027EUR1234,56 (credit or debit, date YYMMDD, currency, amount with a comma); found "${f.value}".` });
    return null;
  }
  if (!CURRENCIES.has(m[3])) notes.push({ severity: 'warning', code: 'CURRENCY', line: f.line, message: `:${f.tag}: names currency ${m[3]}, which is not an ISO 4217 code.` });
  return { kind, tag: f.tag, direction: m[1] === 'C' ? 'CRDT' : 'DBIT', date, currency: m[3], amount, line: f.line };
}

function statementLine(f: Field, currency: string | null, notes: ConversionNote[]): Mt940Entry | null {
  const [first, ...rest] = f.value.split('\n');
  const m = LINE61.exec(first.trim());
  const valueDate = m ? swiftDate(m[1]) : null;
  if (!m || !valueDate) {
    notes.push({ severity: 'error', code: 'BAD_LINE', line: f.line, message: `This :61: can't be read: it should start with the value date (YYMMDD), an optional entry date (MMDD), C, D, RC or RD, the amount with a comma and the transaction type (e.g. NTRF); found "${first}". The line was left out.` });
    return null;
  }
  const amount = swiftAmount(m[5], currency)!;
  const bookingDate = m[2] ? entryDate(m[2], valueDate) : valueDate;
  if (m[2] && !bookingDate) notes.push({ severity: 'warning', code: 'BAD_DATE', line: f.line, message: `The entry date ${m[2]} is not a date; the value date was used instead.` });
  const refs = m[7];
  const slash = refs.indexOf('//');
  const owner = squash(slash >= 0 ? refs.slice(0, slash) : refs);
  const bank = slash >= 0 ? squash(refs.slice(slash + 2)) : '';
  const mark = m[3];
  return {
    line: f.line,
    valueDate,
    bookingDate: bookingDate ?? valueDate,
    // RC is a reversal of a credit (money goes out), RD of a debit (money comes in).
    direction: mark === 'C' || mark === 'RD' ? 'CRDT' : 'DBIT',
    reversal: mark.startsWith('R'),
    amount,
    type: m[6],
    ownerReference: owner && owner.toUpperCase() !== 'NONREF' ? owner : null,
    bankReference: bank || null,
    supplementary: rest.length ? squash(rest.join(' ')) || null : null,
    info: null,
    keepInfo: false,
    endToEndId: null,
    mandateId: null,
    counterparty: null,
    counterpartyIban: null,
    remittance: null,
  };
}

/** Every statement in the input, and what was wrong with it. */
export function readMt940(src: string, notes: ConversionNote[] = []): Mt940Statement[] {
  const out: Mt940Statement[] = [];
  for (const msg of messages(src)) {
    let st: Mt940Statement | null = null;
    let last: 'entry' | 'closing' | null = null;
    for (const f of fields(msg.text, msg.line, notes)) {
      const tag = f.tag;
      if (tag === '20') {
        st = { line: f.line, reference: squash(f.value), account: null, accountIsIban: false, bic: null, number: null, page: null, currency: null, balances: [], entries: [], info: null };
        out.push(st);
        last = null;
        continue;
      }
      if (!st) {
        notes.push({ severity: 'error', code: 'NO_REFERENCE', line: f.line, message: `:${tag}: comes before any :20:, the field every MT940 starts with; it was skipped.` });
        continue;
      }
      if (tag === '21' || tag === '13D' || tag === '34F' || tag === '90D' || tag === '90C') continue;
      if (tag === '25' || tag === '25P') {
        const [acct, second] = f.value.split('\n').map((s) => s.trim());
        let a = acct.replace(/\s/g, '');
        // "BIC/account" or "account" (25P puts the BIC on the next line)
        const parts = a.split('/');
        if (parts.length === 2 && BIC.test(parts[0])) { st.bic = parts[0]; a = parts[1]; }
        if (second && BIC.test(second)) st.bic = second;
        st.account = a.toUpperCase();
        st.accountIsIban = isIban(st.account);
        if (!st.accountIsIban && IBAN.test(st.account)) notes.push({ severity: 'warning', code: 'IBAN_CHECKSUM', line: f.line, message: `The account ${st.account} looks like an IBAN but fails its check digits, so it went in as a plain account number (Othr/Id).` });
        if (st.account.length > 34) { notes.push({ severity: 'warning', code: 'TOO_LONG', line: f.line, message: 'The account number is over 34 characters; it was cut to fit Othr/Id.' }); st.account = st.account.slice(0, 34); }
        continue;
      }
      if (tag === '28C' || tag === '28') {
        const [n, p] = f.value.trim().split('/');
        st.number = /^\d{1,5}$/.test(n ?? '') ? String(Number(n)) : null;
        st.page = /^\d{1,5}$/.test(p ?? '') ? String(Number(p)) : null;
        continue;
      }
      if (tag === '60F' || tag === '60M') {
        const b = balance(f, tag === '60F' ? 'OPBD' : 'ITBD', notes);
        if (b) { st.balances.push(b); st.currency ??= b.currency; }
        continue;
      }
      if (tag === '62F' || tag === '62M' || tag === '64' || tag === '65') {
        const b = balance(f, tag === '62F' ? 'CLBD' : tag === '62M' ? 'ITBD' : tag === '64' ? 'CLAV' : 'FWAV', notes);
        if (b) { st.balances.push(b); st.currency ??= b.currency; }
        last = 'closing';
        continue;
      }
      if (tag === '61') {
        if (st.entries.length >= MAX_ENTRIES) {
          notes.push({ severity: 'error', code: 'TOO_MANY', line: f.line, message: `Over ${MAX_ENTRIES.toLocaleString('en')} lines in one statement; the rest were left out.` });
          continue;
        }
        const e = statementLine(f, st.currency, notes);
        if (e) { st.entries.push(e); last = 'entry'; } else last = null;
        continue;
      }
      if (tag === '86') {
        if (last === 'entry') {
          const e = st.entries[st.entries.length - 1];
          const r = readInfo(f.value);
          e.info = r.structured ? f.value.replace(/\n/g, '') : unwrap(f.value);
          Object.assign(e, { keepInfo: r.structured && !r.complete, endToEndId: r.endToEndId, mandateId: r.mandateId, counterparty: r.counterparty, counterpartyIban: r.iban, remittance: r.remittance });
          last = null;
        } else st.info = st.info ? `${st.info} ${unwrap(f.value)}` : unwrap(f.value);
        continue;
      }
      notes.push({ severity: 'info', code: 'FIELD_SKIPPED', line: f.line, message: `:${tag}: is not an MT940 field this converter maps; it was skipped.` });
    }
  }
  return out;
}

// ---- writing the camt.053 -----------------------------------------------------------------

const amt = (ccy: string, v: string) => `<Amt Ccy="${esc(ccy)}">${v}</Amt>`;

function balanceXml(b: Mt940Balance, i: string): string {
  return `${i}<Bal>
${i}  <Tp>
${i}    <CdOrPrtry>
${i}      <Cd>${b.kind}</Cd>
${i}    </CdOrPrtry>
${i}  </Tp>
${i}  ${amt(b.currency, b.amount)}
${i}  <CdtDbtInd>${b.direction}</CdtDbtInd>
${i}  <Dt>
${i}    <Dt>${b.date}</Dt>
${i}  </Dt>
${i}</Bal>
`;
}

function chunks(s: string, n: number, max: number): string[] {
  const out: string[] = [];
  for (let k = 0; k < s.length && out.length < max; k += n) out.push(s.slice(k, k + n));
  return out;
}

function entryXml(e: Mt940Entry, ccy: string, ntryRef: string | null, i: string): string {
  const refs = [
    e.endToEndId ?? e.ownerReference ? `<EndToEndId>${esc(clip(e.endToEndId ?? e.ownerReference!, 35))}</EndToEndId>` : '',
    e.mandateId ? `<MndtId>${esc(clip(e.mandateId, 35))}</MndtId>` : '',
  ].filter(Boolean);
  // TransactionReferences6 order: AcctSvcrRef … EndToEndId … MndtId
  const refBlock = [e.bankReference ? `<AcctSvcrRef>${esc(clip(e.bankReference, 35))}</AcctSvcrRef>` : '', ...refs].filter(Boolean);
  const side = e.direction === 'CRDT' ? 'Dbtr' : 'Cdtr';
  const party = e.counterparty
    ? `${i}      <RltdPties>
${i}        <${side}>
${i}          <Pty>
${i}            <Nm>${esc(clip(e.counterparty, 140))}</Nm>
${i}          </Pty>
${i}        </${side}>
${e.counterpartyIban ? `${i}        <${side}Acct>
${i}          <Id>
${i}            <IBAN>${e.counterpartyIban}</IBAN>
${i}          </Id>
${i}        </${side}Acct>
` : ''}${i}      </RltdPties>
`
    : '';
  const ustrd = e.remittance ? chunks(e.remittance, 140, 10).map((c) => `${i}        <Ustrd>${esc(c)}</Ustrd>\n`).join('') : '';
  const details = refBlock.length || party || ustrd || e.supplementary
    ? `${i}  <NtryDtls>
${i}    <TxDtls>
${refBlock.length ? `${i}      <Refs>\n${refBlock.map((r) => `${i}        ${r}\n`).join('')}${i}      </Refs>\n` : ''}${party}${ustrd ? `${i}      <RmtInf>\n${ustrd}${i}      </RmtInf>\n` : ''}${e.supplementary ? `${i}      <AddtlTxInf>${esc(clip(e.supplementary, 500))}</AddtlTxInf>\n` : ''}${i}    </TxDtls>
${i}  </NtryDtls>
`
    : '';
  // The whole :86: as AddtlNtryInf only when part of it had no camt.053 field; free text already went to RmtInf.
  const info = e.info && e.keepInfo ? squash(e.info) : '';
  return `${i}<Ntry>
${ntryRef ? `${i}  <NtryRef>${esc(clip(ntryRef, 35))}</NtryRef>\n` : ''}${i}  ${amt(ccy, e.amount)}
${i}  <CdtDbtInd>${e.direction}</CdtDbtInd>
${e.reversal ? `${i}  <RvslInd>true</RvslInd>\n` : ''}${i}  <Sts>
${i}    <Cd>BOOK</Cd>
${i}  </Sts>
${i}  <BookgDt>
${i}    <Dt>${e.bookingDate}</Dt>
${i}  </BookgDt>
${i}  <ValDt>
${i}    <Dt>${e.valueDate}</Dt>
${i}  </ValDt>
${e.bankReference ? `${i}  <AcctSvcrRef>${esc(clip(e.bankReference, 35))}</AcctSvcrRef>\n` : ''}${i}  <BkTxCd>
${i}    <Prtry>
${i}      <Cd>${esc(e.type)}</Cd>
${i}      <Issr>SWIFT</Issr>
${i}    </Prtry>
${i}  </BkTxCd>
${details}${info ? `${i}  <AddtlNtryInf>${esc(clip(info, 500))}</AddtlNtryInf>\n` : ''}${i}</Ntry>
`;
}

function statementXml(st: Mt940Statement, id: string, i: string): string {
  const ccy = st.currency!;
  const minor = minorUnits(ccy) ?? 2;
  const credits = st.entries.filter((e) => e.direction === 'CRDT');
  const debits = st.entries.filter((e) => e.direction === 'DBIT');
  const sum = (xs: Mt940Entry[]) => xs.reduce((a, e) => a + units(e.amount), 0n);
  const net = sum(credits) - sum(debits);
  // NtryRef: the bank's reference when every line has a different one, else the line number.
  const bankRefs = st.entries.map((e) => e.bankReference);
  const uniqueRefs = bankRefs.every((r) => r && r.length <= 35) && new Set(bankRefs).size === bankRefs.length;
  const acct = st.accountIsIban
    ? `${i}  <Id>\n${i}    <IBAN>${st.account}</IBAN>\n${i}  </Id>\n`
    : `${i}  <Id>\n${i}    <Othr>\n${i}      <Id>${esc(st.account ?? 'UNKNOWN')}</Id>\n${i}    </Othr>\n${i}  </Id>\n`;
  const svcr = st.bic ? `${i}  <Svcr>\n${i}    <FinInstnId>\n${i}      <BICFI>${st.bic}</BICFI>\n${i}    </FinInstnId>\n${i}  </Svcr>\n` : '';
  const lastPage = st.balances.some((b) => b.kind === 'CLBD');
  const pgntn = st.page ? `${i}<StmtPgntn>\n${i}  <PgNb>${st.page}</PgNb>\n${i}  <LastPgInd>${lastPage}</LastPgInd>\n${i}</StmtPgntn>\n` : '';
  const summary = st.entries.length
    ? `${i}<TxsSummry>
${i}  <TtlNtries>
${i}    <NbOfNtries>${st.entries.length}</NbOfNtries>
${i}    <Sum>${decimal(sum(st.entries), minor)}</Sum>
${i}    <TtlNetNtry>
${i}      <Amt>${decimal(net < 0n ? -net : net, minor)}</Amt>
${i}      <CdtDbtInd>${net < 0n ? 'DBIT' : 'CRDT'}</CdtDbtInd>
${i}    </TtlNetNtry>
${i}  </TtlNtries>
${credits.length ? `${i}  <TtlCdtNtries>\n${i}    <NbOfNtries>${credits.length}</NbOfNtries>\n${i}    <Sum>${decimal(sum(credits), minor)}</Sum>\n${i}  </TtlCdtNtries>\n` : ''}${debits.length ? `${i}  <TtlDbtNtries>\n${i}    <NbOfNtries>${debits.length}</NbOfNtries>\n${i}    <Sum>${decimal(sum(debits), minor)}</Sum>\n${i}  </TtlDbtNtries>\n` : ''}${i}</TxsSummry>
`
    : '';
  return `${i.slice(2)}<Stmt>
${i}<Id>${esc(id)}</Id>
${pgntn}${st.number ? `${i}<ElctrncSeqNb>${st.number}</ElctrncSeqNb>\n` : ''}${i}<Acct>
${acct}${i}  <Ccy>${esc(ccy)}</Ccy>
${svcr}${i}</Acct>
${st.balances.map((b) => balanceXml(b, i)).join('')}${summary}${st.entries.map((e, k) => entryXml(e, ccy, uniqueRefs ? e.bankReference : String(k + 1), i)).join('')}${st.info ? `${i}<AddtlStmtInf>${esc(clip(st.info, 500))}</AddtlStmtInf>\n` : ''}${i.slice(2)}</Stmt>
`;
}

// ---- the conversion ------------------------------------------------------------------------

export function convertMt940(src: string, opts: ConvertOptions = {}): Conversion {
  const fail = (error: string, notes: ConversionNote[] = []): Conversion => ({ ok: false, error, xml: null, statements: [], entries: 0, notes, check: null });
  if (!src.trim()) return fail('Paste or upload an MT940 statement.');
  if (src.length > MAX_MT940) return fail(`The statement is over ${MAX_MT940.toLocaleString('en')} characters.`);
  if (/^\s*</.test(src)) return fail('This looks like XML. The converter takes an MT940 (text starting with :20:); to check an ISO 20022 message, use the Test Bench.');

  const notes: ConversionNote[] = [];
  const read = readMt940(src, notes);
  if (!read.length) return fail('No MT940 statement found: every statement starts with a :20: field.', notes);

  const usable: Mt940Statement[] = [];
  const summaries: StatementSummary[] = [];
  for (const st of read) {
    const opening = st.balances.find((b) => b.kind === 'OPBD' || (b.kind === 'ITBD' && b.tag === '60M'));
    const closing = st.balances.find((b) => b.kind === 'CLBD' || (b.kind === 'ITBD' && b.tag === '62M'));
    const who = `Statement ${st.reference || '(no :20:)'}`;
    if (!st.account) notes.push({ severity: 'error', code: 'NO_ACCOUNT', line: st.line, message: `${who} has no :25: account; a camt.053 must name the account.` });
    if (!opening) notes.push({ severity: 'error', code: 'NO_OPENING', line: st.line, message: `${who} has no :60F: or :60M: opening balance, which MT940 requires.` });
    if (!closing) notes.push({ severity: 'error', code: 'NO_CLOSING', line: st.line, message: `${who} has no :62F: or :62M: closing balance, which MT940 requires.` });
    if (!st.reference) notes.push({ severity: 'error', code: 'NO_REFERENCE', line: st.line, message: 'The :20: reference is empty.' });
    for (const b of st.balances)
      if (st.currency && b.currency !== st.currency) notes.push({ severity: 'warning', code: 'CURRENCY_MIXED', line: b.line, message: `:${b.tag}: is in ${b.currency}, but the statement's opening balance is in ${st.currency}.` });
    if (st.currency) {
      const minor = minorUnits(st.currency) ?? 2;
      for (const e of st.entries) {
        const decimals = e.amount.split('.')[1]?.length ?? 0;
        if (decimals > minor) notes.push({ severity: 'warning', code: 'DECIMALS', line: e.line, message: `${e.amount} has more decimals than ${st.currency} allows (${minor}).` });
      }
    }
    const credits = st.entries.filter((e) => e.direction === 'CRDT').reduce((a, e) => a + units(e.amount), 0n);
    const debits = st.entries.filter((e) => e.direction === 'DBIT').reduce((a, e) => a + units(e.amount), 0n);
    let balanced: boolean | null = null;
    if (opening && closing) {
      const signed = (b: Mt940Balance) => (b.direction === 'DBIT' ? -units(b.amount) : units(b.amount));
      const want = signed(opening) + credits - debits;
      balanced = want === signed(closing);
      const minor = minorUnits(closing.currency) ?? 2;
      if (!balanced)
        notes.push({ severity: 'error', code: 'BALANCE_MISMATCH', line: closing.line, message: `The MT940 does not add up: opening ${decimal(signed(opening), minor)} plus credits ${decimal(credits, minor)} minus debits ${decimal(debits, minor)} is ${decimal(want, minor)}, but :${closing.tag}: says ${decimal(signed(closing), minor)}. Converted as the bank sent it.` });
    }
    if (st.page && opening?.tag === '60M') notes.push({ severity: 'info', code: 'CONTINUATION', line: opening.line, message: `${who} is page ${st.page} of a longer statement (it opens with :60M:), so its balances are intermediate (ITBD).` });
    const minor = st.currency ? minorUnits(st.currency) ?? 2 : 2;
    summaries.push({
      reference: st.reference,
      account: st.account,
      currency: st.currency,
      from: opening?.date ?? null,
      to: closing?.date ?? null,
      opening: opening ? `${opening.direction === 'DBIT' ? '-' : ''}${opening.amount}` : null,
      closing: closing ? `${closing.direction === 'DBIT' ? '-' : ''}${closing.amount}` : null,
      entries: st.entries.length,
      credits: decimal(credits, minor),
      debits: decimal(debits, minor),
      balanced,
    });
    if (st.account && st.currency && opening) usable.push(st);
  }

  if (!usable.length) return { ok: false, error: 'No statement had an account, a currency and an opening balance, so there is nothing to convert. See the notes.', xml: null, statements: summaries, entries: 0, notes, check: null };

  const now = opts.now ?? new Date();
  const created = now.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const ids = new Set<string>();
  const stmts = usable.map((st, k) => {
    let id = clip([st.reference, st.number, st.page].filter(Boolean).join('/'), 35) || `STMT-${k + 1}`;
    while (ids.has(id)) id = clip(`${id}-${k + 1}`, 35);
    ids.add(id);
    return statementXml(st, id, '      ');
  });
  const msgId = clip(opts.messageId ?? `MT940-${usable[0].reference}`, 35);
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:${CAMT_053}">
  <BkToCstmrStmt>
    <GrpHdr>
      <MsgId>${esc(msgId)}</MsgId>
      <CreDtTm>${created}</CreDtTm>
      <AddtlInf>Converted from SWIFT MT940 by iomarkets.tech/convert</AddtlInf>
    </GrpHdr>
${stmts.join('')}  </BkToCstmrStmt>
</Document>
`;
  const entries = usable.reduce((a, s) => a + s.entries.length, 0);
  const check = validate(xml, { now });
  return { ok: true, xml, statements: summaries, entries, notes, check };
}

/** A conversion as plain text: the MCP tool prints this, followed by the XML. */
export function formatConversion(c: Conversion): string {
  if (!c.ok) return [`Could not convert: ${c.error}`, ...c.notes.map((n) => `  ${n.severity} line ${n.line} ${n.code}: ${n.message}`)].join('\n');
  const head = `Converted ${c.statements.length} MT940 statement${c.statements.length === 1 ? '' : 's'} (${c.entries} entr${c.entries === 1 ? 'y' : 'ies'}) to ${CAMT_053}.`;
  const sts = c.statements.map((s) => `  ${s.reference} · ${s.account ?? 'no account'} · ${s.currency ?? ''} · ${s.from ?? '?'} to ${s.to ?? '?'} · opening ${s.opening ?? '?'}, credits ${s.credits}, debits ${s.debits}, closing ${s.closing ?? '?'} · ${s.balanced === null ? 'balances missing' : s.balanced ? 'adds up' : 'DOES NOT ADD UP'}`);
  const check = c.check ? `Test Bench: ${c.check.valid ? `valid ${CAMT_053}${c.check.warnings ? ` with ${c.check.warnings} warning${c.check.warnings === 1 ? '' : 's'}` : ''}` : `${c.check.errors} error${c.check.errors === 1 ? '' : 's'} (${c.check.issues.filter((i) => i.severity === 'error').map((i) => i.code).join(', ')})`}.` : '';
  const notes = c.notes.filter((n) => n.severity !== 'info').map((n) => `  ${n.severity} line ${n.line} ${n.code}: ${n.message}`);
  return [head, ...sts, check, ...(notes.length ? ['Notes:', ...notes] : [])].filter(Boolean).join('\n');
}
