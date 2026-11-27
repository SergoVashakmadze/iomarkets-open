// Financial identifier checks: IBAN, BIC, LEI, ISIN, CUSIP, FIGI, ISO 4217 and ISO 3166 codes.
// Pure and dependency-free. The IBAN / LEI / ISIN checksums and the code lists are the ones the Test Bench
// uses (./codes.ts): this module only adds the structure checks, the CUSIP and FIGI check digits and the
// per-line detection for a pasted batch. A valid check digit means the identifier is well-formed; it does
// not mean it was ever issued: nothing here looks anything up.
import { COUNTRIES, CURRENCIES, IBAN_LENGTH, WITHDRAWN_CURRENCIES, ibanChecksumOk, isinCheckDigit, leiChecksumOk } from './codes.ts';

export type IdKind = 'iban' | 'bic' | 'lei' | 'isin' | 'cusip' | 'figi' | 'currency' | 'country';
export const ID_KINDS: IdKind[] = ['iban', 'bic', 'lei', 'isin', 'cusip', 'figi', 'currency', 'country'];
export const MAX_LINES = 200;
export const MAX_LINE_LENGTH = 64;

export type IdVerdict = {
  line: number;
  input: string;
  /** The kind it was read as; null when no kind fits. */
  kind: IdKind | null;
  valid: boolean;
  normalized: string;
  /** Why it failed, or a note on a valid one (test BIC, withdrawn currency). */
  message: string;
  /** What was read from it (country, length, check digits). */
  details: Record<string, string>;
};

type Check = { valid: boolean; message: string; details?: Record<string, string> };
const ok = (message = 'Valid.', details: Record<string, string> = {}): Check => ({ valid: true, message, details });
const bad = (message: string, details: Record<string, string> = {}): Check => ({ valid: false, message, details });

const clean = (s: string) => s.replace(/[\s-]+/g, '').toUpperCase();

export function checkIban(raw: string): Check {
  const s = clean(raw);
  if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]+$/.test(s)) return bad('An IBAN is two letters, two check digits, then the account part.');
  const cc = s.slice(0, 2);
  const details = { country: cc, length: String(s.length), checkDigits: s.slice(2, 4) };
  const want = IBAN_LENGTH[cc];
  if (!want) return bad(`${cc} is not in the IBAN registry: no IBAN is issued with that country code.`, details);
  if (s.length !== want) return bad(`An IBAN from ${cc} is ${want} characters; this one is ${s.length}.`, details);
  if (!ibanChecksumOk(s)) return bad('The check digits are wrong (ISO 13616 mod 97 does not give 1): a typo or a transposed character.', details);
  return ok('Valid length and check digits for ' + cc + '.', details);
}

export function checkBic(raw: string): Check {
  const s = clean(raw);
  if (!/^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(s)) return bad('A BIC is 8 or 11 characters: 4 letters (institution), 2 letters (country), 2 letters or digits (location), optional 3 (branch).');
  const country = s.slice(4, 6);
  const details = { institution: s.slice(0, 4), country, location: s.slice(6, 8), branch: s.length === 11 ? s.slice(8) : '(head office)' };
  if (!COUNTRIES.has(country)) return bad(`Characters 5 and 6 of a BIC are its country, and ${country} is not an ISO 3166 country code.`, details);
  if (s[7] === '0') return ok('Well-formed. A 0 as the last location character marks a test BIC.', details);
  return ok('Well-formed: structure and country only. A BIC can look right and not be registered.', details);
}

export function checkLei(raw: string): Check {
  const s = clean(raw);
  if (!/^[A-Z0-9]{18}[0-9]{2}$/.test(s)) return bad('An LEI is 20 characters: 18 letters or digits, then 2 check digits.');
  const details = { lou: s.slice(0, 4), checkDigits: s.slice(18) };
  if (!leiChecksumOk(s)) return bad('The check digits are wrong (ISO 17442 mod 97 does not give 1).', details);
  return ok('Valid structure and check digits. Whether it is registered, and to whom, is in GLEIF’s database, not here.', details);
}

export function checkIsin(raw: string): Check {
  const s = clean(raw);
  if (!/^[A-Z]{2}[A-Z0-9]{9}[0-9]$/.test(s)) return bad('An ISIN is 12 characters: 2 letters (country), 9 letters or digits (national code), 1 check digit.');
  const prefix = s.slice(0, 2);
  const details = { prefix, nsin: s.slice(2, 11), checkDigit: s[11] };
  // XS = Euroclear/Clearstream, EU = EU instruments, XA-XF and XX = other international or temporary prefixes.
  const international = /^(XS|EU|XA|XB|XC|XD|XF|XX|QS|QT|QW|QX|QY|QZ)$/.test(prefix);
  if (!COUNTRIES.has(prefix) && !international) return bad(`${prefix} is not a country code or a known ISIN prefix.`, details);
  const want = isinCheckDigit(s.slice(0, 11));
  if (want !== Number(s[11])) return bad(`The check digit is wrong: it should be ${want} (ISO 6166, Luhn over the expanded digits).`, details);
  return ok(international ? 'Valid check digit; the prefix is an international one, not a country.' : 'Valid check digit and prefix.', details);
}

/** CUSIP: 9 characters, the 9th a modulus-10 double-add-double check over the first 8. */
export function cusipCheckDigit(first8: string): number {
  let sum = 0;
  for (let i = 0; i < 8; i++) {
    const c = first8[i];
    let v = /[0-9]/.test(c) ? Number(c) : c === '*' ? 36 : c === '@' ? 37 : c === '#' ? 38 : c.charCodeAt(0) - 55;
    if (i % 2 === 1) v *= 2;
    sum += Math.floor(v / 10) + (v % 10);
  }
  return (10 - (sum % 10)) % 10;
}
export function checkCusip(raw: string): Check {
  const s = clean(raw);
  if (!/^[A-Z0-9*@#]{8}[0-9]$/.test(s)) return bad('A CUSIP is 9 characters: 8 letters or digits, then 1 check digit.');
  const details = { issuer: s.slice(0, 6), issue: s.slice(6, 8), checkDigit: s[8] };
  const want = cusipCheckDigit(s.slice(0, 8));
  if (want !== Number(s[8])) return bad(`The check digit is wrong: it should be ${want}.`, details);
  return ok('Valid check digit. Its ISIN is US or CA plus the CUSIP plus a new check digit.', details);
}

/** FIGI (ISO/OMG): 12 characters, "BBG" prefix, no vowels in the first 11, a check digit last. */
export function figiCheckDigit(first11: string): number {
  let sum = 0;
  for (let i = 0; i < 11; i++) {
    const c = first11[i];
    let v = /[0-9]/.test(c) ? Number(c) : c.charCodeAt(0) - 55;
    if (i % 2 === 1) v *= 2;
    sum += Math.floor(v / 10) + (v % 10);
  }
  return (10 - (sum % 10)) % 10;
}
export function checkFigi(raw: string): Check {
  const s = clean(raw);
  if (!/^[A-Z0-9]{12}$/.test(s)) return bad('A FIGI is 12 characters: letters and digits only.');
  const details = { prefix: s.slice(0, 2), thirdChar: s[2], checkDigit: s[11] };
  if (!/^[B-DF-HJ-NP-TV-Z0-9]{2}G/.test(s) || /[AEIOU]/.test(s.slice(0, 11))) return bad('A FIGI starts with two consonants (or digits) and G, and has no vowels in its first 11 characters.', details);
  if (!/[0-9]/.test(s[11])) return bad('The last character of a FIGI is a check digit.', details);
  const want = figiCheckDigit(s.slice(0, 11));
  if (want !== Number(s[11])) return bad(`The check digit is wrong: it should be ${want}.`, details);
  return ok(s.startsWith('BBG') ? 'Valid check digit (Bloomberg-issued, BBG prefix).' : 'Valid structure and check digit. The prefix is not BBG, so it was issued by another FIGI issuer.', details);
}

export function checkCurrency(raw: string): Check {
  const s = clean(raw);
  if (!/^[A-Z]{3}$/.test(s)) return bad('An ISO 4217 currency code is 3 letters.');
  if (CURRENCIES.has(s)) return ok('Current ISO 4217 code.', { code: s });
  if (WITHDRAWN_CURRENCIES.has(s)) return bad(`${s} was an ISO 4217 code and has been withdrawn.`, { code: s });
  return bad(`${s} is not an ISO 4217 code.`, { code: s });
}

export function checkCountry(raw: string): Check {
  const s = clean(raw);
  if (!/^[A-Z]{2}$/.test(s)) return bad('An ISO 3166-1 alpha-2 country code is 2 letters.');
  return COUNTRIES.has(s) ? ok('ISO 3166-1 alpha-2 code (XK, Kosovo, is the SWIFT/IBAN convention).', { code: s }) : bad(`${s} is not an ISO 3166-1 alpha-2 code.`, { code: s });
}

const CHECKS: Record<IdKind, (s: string) => Check> = {
  iban: checkIban, bic: checkBic, lei: checkLei, isin: checkIsin, cusip: checkCusip, figi: checkFigi, currency: checkCurrency, country: checkCountry,
};

/** The kinds a string could be, by length and alphabet, most specific first. */
export function candidateKinds(raw: string): IdKind[] {
  const s = clean(raw);
  const out: IdKind[] = [];
  if (/^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$/.test(s) && s.length >= 15) out.push('iban');
  if (s.length === 12 && /^[A-Z0-9]{2}G/.test(s)) out.push('figi');
  // BBG… is a Bloomberg FIGI prefix: read it as one rather than as an ISIN from Barbados that happens to pass.
  if (s.length === 12 && !s.startsWith('BBG')) out.push('isin');
  if (s.length === 20) out.push('lei');
  if (s.length === 9) out.push('cusip');
  if (s.length === 8 || s.length === 11) out.push('bic');
  if (s.length === 3) out.push('currency');
  if (s.length === 2) out.push('country');
  return out;
}

/** Check one identifier. With `kind` it is read as that kind; without, the first kind it is valid as wins, else the first candidate's error. */
export function checkIdentifier(raw: string, kind?: IdKind, line = 1): IdVerdict {
  const input = raw.trim();
  const base = { line, input, normalized: clean(input) };
  if (kind) {
    const c = CHECKS[kind](input);
    return { ...base, kind, valid: c.valid, message: c.message, details: c.details ?? {} };
  }
  const cands = candidateKinds(input);
  if (!cands.length) return { ...base, kind: null, valid: false, message: `${base.normalized.length} characters fits none of IBAN, BIC, LEI, ISIN, CUSIP, FIGI, currency or country code. Prefix the line with the kind (for example "iban: …") to force one.`, details: {} };
  let first: { kind: IdKind; c: Check } | null = null;
  for (const k of cands) {
    const c = CHECKS[k](input);
    if (c.valid) return { ...base, kind: k, valid: true, message: c.message, details: c.details ?? {} };
    first ??= { kind: k, c };
  }
  return { ...base, kind: first!.kind, valid: false, message: first!.c.message, details: first!.c.details ?? {} };
}

export type BatchResult = { total: number; valid: number; invalid: number; truncated: boolean; results: IdVerdict[] };

/** One identifier per line; blank lines are skipped. A line may start with "kind:" or "kind," to force the kind. */
export function checkBatch(text: string, kind?: IdKind): BatchResult {
  const lines = text.split(/\r?\n/);
  const results: IdVerdict[] = [];
  let truncated = false;
  lines.forEach((l, i) => {
    const t = l.trim();
    if (!t) return;
    if (results.length >= MAX_LINES) {
      truncated = true;
      return;
    }
    if (t.length > MAX_LINE_LENGTH) {
      results.push({ line: i + 1, input: t.slice(0, MAX_LINE_LENGTH) + '…', kind: null, valid: false, normalized: '', message: `Over ${MAX_LINE_LENGTH} characters: not an identifier.`, details: {} });
      return;
    }
    const m = /^([A-Za-z]+)\s*[:,;\t]\s*(.+)$/.exec(t);
    const forced = m && (ID_KINDS as string[]).includes(m[1].toLowerCase()) ? (m[1].toLowerCase() as IdKind) : kind;
    results.push(checkIdentifier(m && forced === m[1].toLowerCase() ? m[2] : t, forced, i + 1));
  });
  const valid = results.filter((r) => r.valid).length;
  return { total: results.length, valid, invalid: results.length - valid, truncated, results };
}

const csvCell = (s: string) => (/^[=+\-@\t\r]/.test(s) ? `'${s}` : s).replace(/"/g, '""');
export function identifiersCsv(r: BatchResult): string {
  const rows = r.results.map((v) => [v.line, v.input, v.kind ?? '', v.valid ? 'valid' : 'invalid', v.message].map((c) => `"${csvCell(String(c))}"`).join(','));
  return ['line,input,kind,verdict,message', ...rows].join('\n') + '\n';
}
