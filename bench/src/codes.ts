// Reference data for the business rules: ISO 4217 currencies and their minor units,
// ISO 3166-1 country codes, and IBAN lengths from the SWIFT IBAN registry. Facts, not
// licensed data. Last checked 2026-10-29; when a code list changes, update it here and
// the tests in tests/bench-rules.test.ts.

/** Minor units per ISO 4217. Codes not listed have 2. null = no minor unit defined (metals, funds codes). */
const MINOR: Record<string, number | null> = {
  BIF: 0, CLP: 0, DJF: 0, GNF: 0, ISK: 0, JPY: 0, KMF: 0, KRW: 0, PYG: 0, RWF: 0, UGX: 0, UYI: 0, VND: 0, VUV: 0, XAF: 0, XOF: 0, XPF: 0,
  BHD: 3, IQD: 3, JOD: 3, KWD: 3, LYD: 3, OMR: 3, TND: 3,
  CLF: 4, UYW: 4,
  XAG: null, XAU: null, XBA: null, XBB: null, XBC: null, XBD: null, XDR: null, XPD: null, XPT: null, XSU: null, XTS: null, XUA: null, XXX: null,
};

/** ISO 4217 codes in use. */
export const CURRENCIES = new Set(
  ('AED AFN ALL AMD AOA ARS AUD AWG AZN BAM BBD BDT BHD BIF BMD BND BOB BOV BRL BSD BTN BWP BYN BZD CAD CDF CHE CHF CHW ' +
    'CLF CLP CNY COP COU CRC CUP CVE CZK DJF DKK DOP DZD EGP ERN ETB EUR FJD FKP GBP GEL GHS GIP GMD GNF GTQ GYD HKD HNL HTG ' +
    'HUF IDR ILS INR IQD IRR ISK JMD JOD JPY KES KGS KHR KMF KPW KRW KWD KYD KZT LAK LBP LKR LRD LSL LYD MAD MDL MGA MKD MMK ' +
    'MNT MOP MRU MUR MVR MWK MXN MXV MYR MZN NAD NGN NIO NOK NPR NZD OMR PAB PEN PGK PHP PKR PLN PYG QAR RON RSD RUB RWF SAR ' +
    'SBD SCR SDG SEK SGD SHP SLE SOS SRD SSP STN SVC SYP SZL THB TJS TMT TND TOP TRY TTD TWD TZS UAH UGX USD USN UYI UYU UYW ' +
    'UZS VED VES VND VUV WST XAF XAG XAU XBA XBB XBC XBD XCD XCG XDR XOF XPD XPF XPT XSU XTS XUA XXX YER ZAR ZMW ZWG').split(' '),
);

/** Withdrawn recently enough that old systems still send them: a warning, not an error. */
export const WITHDRAWN_CURRENCIES = new Set(['ANG', 'BGN', 'CUC', 'HRK', 'SLL', 'ZWL', 'VEF', 'MRO', 'STD', 'LTL', 'LVL', 'EEK', 'BYR']);

export const minorUnits = (ccy: string): number | null => (ccy in MINOR ? MINOR[ccy] : 2);

/** ISO 3166-1 alpha-2, plus XK (Kosovo), which SWIFT uses in BICs and IBANs. */
export const COUNTRIES = new Set(
  ('AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD ' +
    'CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF ' +
    'GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN ' +
    'KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA ' +
    'NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI ' +
    'SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI ' +
    'VN VU WF WS YE YT ZA ZM ZW XK').split(' '),
);

/** IBAN length by country, SWIFT IBAN registry. */
export const IBAN_LENGTH: Record<string, number> = {
  AD: 24, AE: 23, AL: 28, AT: 20, AZ: 28, BA: 20, BE: 16, BG: 22, BH: 22, BI: 27, BR: 29, BY: 28, CH: 21, CR: 22, CY: 28,
  CZ: 24, DE: 22, DJ: 27, DK: 18, DO: 28, EE: 20, EG: 29, ES: 24, FI: 18, FK: 18, FO: 18, FR: 27, GB: 22, GE: 22, GI: 23,
  GL: 18, GR: 27, GT: 28, HR: 21, HU: 28, IE: 22, IL: 23, IQ: 23, IS: 26, IT: 27, JO: 30, KW: 30, KZ: 20, LB: 28, LC: 32,
  LI: 21, LT: 20, LU: 20, LV: 21, LY: 25, MC: 27, MD: 24, ME: 22, MK: 19, MN: 20, MR: 27, MT: 31, MU: 30, NI: 28, NL: 18,
  NO: 15, OM: 23, PK: 24, PL: 28, PS: 29, PT: 25, QA: 29, RO: 24, RS: 22, RU: 33, SA: 24, SC: 31, SD: 18, SE: 24, SI: 19,
  SK: 24, SM: 27, SO: 23, ST: 25, SV: 28, TL: 23, TN: 24, TR: 26, UA: 29, VA: 22, VG: 24, XK: 20, YE: 30,
};

/** Letters to numbers (A=10 … Z=35), digits kept: the step IBAN, LEI and ISIN checks share. */
const expand = (s: string) => s.toUpperCase().replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));

/** Remainder of a long digit string mod 97, in chunks so it never loses precision. */
export function mod97(digits: string): number {
  let r = 0;
  for (let i = 0; i < digits.length; i += 7) r = Number(String(r) + digits.slice(i, i + 7)) % 97;
  return r;
}

/** ISO 13616: move the first four characters to the end; the number mod 97 must be 1. */
export const ibanChecksumOk = (iban: string) => mod97(expand(iban.slice(4) + iban.slice(0, 4))) === 1;

/** ISO 17442: the whole LEI as a number mod 97 must be 1. */
export const leiChecksumOk = (lei: string) => mod97(expand(lei)) === 1;

/** ISO 6166: Luhn over the expanded digits; the last digit is the check digit. */
export function isinCheckDigit(first11: string): number {
  const digits = expand(first11);
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 0) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return (10 - (sum % 10)) % 10;
}
export const isinOk = (isin: string) => /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/.test(isin) && isinCheckDigit(isin.slice(0, 11)) === Number(isin[11]);
