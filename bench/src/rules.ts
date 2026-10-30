// Business rules: what a schema can't say. They run only on a schema-valid message, so
// every value they read has the shape its type promises.
//
// Three kinds, each issue saying which:
// - checks every message gets by data type: IBAN, BIC, LEI and ISIN check digits, country
//   and currency codes, amount decimals per ISO 4217;
// - the cross-element rules ISO 20022 publishes with each message definition (totals,
//   counts, "if this is present, that is not allowed");
// - market practice (CBPR+, SMPG) as warnings: what a receiving bank will usually reject.

import { COUNTRIES, CURRENCIES, IBAN_LENGTH, WITHDRAWN_CURRENCIES, ibanChecksumOk, isinOk, leiChecksumOk, minorUnits } from './codes.ts';
import type { MessageModel } from './model.ts';
import type { Issue } from './report.ts';
import type { XmlElement } from './xml.ts';

type Sink = (i: Omit<Issue, 'layer' | 'severity'> & { severity?: Issue['severity'] }) => void;

/** An element with the path it was found at. */
type Node = { el: XmlElement; path: string };

// ---- tree helpers ----------------------------------------------------------------

/** Repeating blocks get an index in their path even when there is only one. */
const INDEXED = new Set(['CdtTrfTxInf', 'PmtInf', 'Stmt', 'Ntfctn', 'Ntry', 'TxInfAndSts', 'OrgnlGrpInfAndSts', 'TxInf']);
const childrenNamed = (n: Node, name: string): Node[] => {
  const all = n.el.children.filter((c) => c.name === name);
  return all.map((el, i) => ({ el, path: all.length > 1 || INDEXED.has(name) ? `${n.path}/${name}[${i + 1}]` : `${n.path}/${name}` }));
};
/** Children along a slash path, e.g. at(tx, 'PmtId/EndToEndId'). */
const all = (n: Node, path: string): Node[] => path.split('/').reduce<Node[]>((acc, name) => acc.flatMap((x) => childrenNamed(x, name)), [n]);
const at = (n: Node, path: string): Node | undefined => all(n, path)[0];
const val = (n: Node | undefined) => n?.el.text.trim();
const has = (n: Node, path: string) => at(n, path) !== undefined;

// ---- decimals without floating point --------------------------------------------

const scaleOf = (s: string) => (s.split('.')[1] ?? '').length;
function toUnits(s: string, scale: number): bigint {
  const neg = s.startsWith('-');
  const [i, f = ''] = s.replace(/^[+-]/, '').split('.');
  const v = BigInt((i || '0') + f.padEnd(scale, '0'));
  return neg ? -v : v;
}
function fromUnits(v: bigint, scale: number): string {
  const neg = v < 0n;
  const s = (neg ? -v : v).toString().padStart(scale + 1, '0');
  const out = scale ? `${s.slice(0, -scale)}.${s.slice(-scale)}` : s;
  return (neg ? '-' : '') + out;
}
/** Sum decimal strings exactly. */
export function sumDecimal(xs: string[]): string {
  const scale = Math.max(0, ...xs.map(scaleOf));
  return fromUnits(xs.reduce((a, x) => a + toUnits(x, scale), 0n), scale);
}
export const sameDecimal = (a: string, b: string) => {
  const scale = Math.max(scaleOf(a), scaleOf(b));
  return toUnits(a, scale) === toUnits(b, scale);
};
const signed = (amount: string, ind: string | undefined) => (ind === 'DBIT' ? `-${amount}` : amount);

// ---- checks every message gets by data type ----------------------------------------

function byType(doc: XmlElement, model: MessageModel, report: Sink) {
  const walk = (el: XmlElement, typeName: string, path: string) => {
    const t = model.types[typeName];
    if (!t) return;
    if (t.k === 'seq' || t.k === 'choice') {
      const seen = new Map<string, number>();
      for (const k of el.children) {
        const p = t.els.find((e) => e.n === k.name);
        if (!p) continue;
        const n = (seen.get(k.name) ?? 0) + 1;
        seen.set(k.name, n);
        walk(k, p.t, p.max === 1 ? `${path}/${k.name}` : `${path}/${k.name}[${n}]`);
      }
      return;
    }
    const v = el.text.trim();
    const line = el.line;
    if (t.k === 'text') {
      const ccy = el.attrs.Ccy;
      if (ccy) checkCurrency(ccy, typeName.startsWith('ActiveCurrency'), `${path}/@Ccy`, line, report);
      // Rates carry up to 13 decimals by design; amounts follow the currency's minor unit.
      if (ccy && !typeName.includes('13Decimal')) {
        const units = minorUnits(ccy);
        const frac = (v.split('.')[1] ?? '').replace(/0+$/, '').length;
        if (units !== null && frac > units)
          report({ code: 'AMOUNT_DECIMALS', path, line, message: `${el.name} is ${v} ${ccy}, but ${ccy} has ${units === 0 ? 'no minor unit: amounts must be whole' : `${units} decimal place${units === 1 ? '' : 's'}`} (ISO 4217).` });
      }
      return;
    }
    if (/^(BICFI|AnyBIC)/.test(typeName)) {
      const cc = v.slice(4, 6);
      if (!COUNTRIES.has(cc)) report({ code: 'BIC_COUNTRY', path, line, message: `${el.name} ${v}: characters 5 and 6 of a BIC are its country, and "${cc}" is not an ISO 3166 country code.` });
    } else if (typeName.startsWith('IBAN')) {
      const cc = v.slice(0, 2);
      const len = IBAN_LENGTH[cc];
      if (!COUNTRIES.has(cc)) report({ code: 'IBAN_COUNTRY', path, line, message: `IBAN ${v} starts with "${cc}", which is not a country code.` });
      else if (len === undefined) report({ severity: 'warning', code: 'IBAN_COUNTRY', path, line, message: `IBAN ${v}: ${cc} is not in the SWIFT IBAN registry, so its length can't be checked.` });
      else if (v.length !== len) report({ code: 'IBAN_LENGTH', path, line, message: `IBAN ${v} is ${v.length} characters; ${cc} IBANs are ${len}.` });
      if (COUNTRIES.has(cc) && !ibanChecksumOk(v)) report({ code: 'IBAN_CHECKSUM', path, line, message: `IBAN ${v} fails its check digits (ISO 13616 mod 97): a character is mistyped or swapped.` });
    } else if (typeName.startsWith('LEI')) {
      if (!leiChecksumOk(v)) report({ code: 'LEI_CHECKSUM', path, line, message: `LEI ${v} fails its check digits (ISO 17442 mod 97).` });
    } else if (typeName.startsWith('ISIN')) {
      if (!isinOk(v)) report({ code: 'ISIN_CHECK_DIGIT', path, line, message: `ISIN ${v} fails its check digit (ISO 6166): the last digit should be computed from the first eleven characters.` });
      else if (!COUNTRIES.has(v.slice(0, 2)) && !['XS', 'EU', 'XA', 'XB', 'XC', 'XD', 'QS', 'QT'].includes(v.slice(0, 2)))
        report({ severity: 'warning', code: 'ISIN_PREFIX', path, line, message: `ISIN ${v} starts with "${v.slice(0, 2)}", which is neither a country code nor a known international prefix.` });
    } else if (typeName === 'CountryCode') {
      if (!COUNTRIES.has(v)) report({ code: 'COUNTRY_CODE', path, line, message: `${el.name} "${v}" is not an ISO 3166 country code.` });
    } else if (/CurrencyCode$/.test(typeName)) {
      checkCurrency(v, typeName.startsWith('Active'), path, line, report);
    }
  };
  walk(doc, model.root, '/Document');
}

function checkCurrency(ccy: string, activeOnly: boolean, path: string, line: number, report: Sink) {
  if (CURRENCIES.has(ccy)) return;
  if (WITHDRAWN_CURRENCIES.has(ccy))
    report({ severity: activeOnly ? 'error' : 'warning', code: 'CURRENCY_CODE', path, line, message: `${ccy} has been withdrawn from ISO 4217${activeOnly ? '; this field takes only active currencies' : ''}.` });
  else report({ code: 'CURRENCY_CODE', path, line, message: `"${ccy}" is not an ISO 4217 currency code.` });
}

// ---- shared message rules ------------------------------------------------------------

function countAndSum(group: Node, items: Node[], amounts: (string | undefined)[], what: string, report: Sink) {
  const nb = at(group, 'NbOfTxs');
  if (nb && Number(val(nb)) !== items.length)
    report({ code: 'NB_OF_TXS', path: nb.path, line: nb.el.line, message: `NbOfTxs says ${val(nb)}, but the ${what} holds ${items.length} transaction${items.length === 1 ? '' : 's'}.` });
  const cs = at(group, 'CtrlSum');
  const known = amounts.filter((a): a is string => a !== undefined);
  if (cs && known.length === amounts.length) {
    const total = sumDecimal(known);
    if (!sameDecimal(val(cs)!, total))
      report({ code: 'CTRL_SUM', path: cs.path, line: cs.el.line, message: `CtrlSum says ${val(cs)}, but the amounts in the ${what} add up to ${total}.` });
  }
}

function duplicates(nodes: Node[], what: string, code: string, report: Sink, severity: Issue['severity'] = 'warning') {
  const seen = new Map<string, Node>();
  for (const n of nodes) {
    const v = val(n)!;
    const first = seen.get(v);
    if (first) report({ severity, code, path: n.path, line: n.el.line, message: `${what} "${v}" is used twice (first at line ${first.el.line}); it should identify one ${code === 'DUPLICATE_UETR' ? 'payment' : 'item'} only.` });
    else seen.set(v, n);
  }
}

/**
 * The settlement information rules ISO 20022 publishes with every pacs message that carries
 * SttlmInf: SettlementMethodAgentRule, …ClearingRule, …CoverAgentRule, …CoverRule,
 * ThirdReimbursementAgentRule and the reimbursement agent account rules.
 */
function settlementInfo(sttlm: Node, report: Sink) {
  const mtd = val(at(sttlm, 'SttlmMtd'));
  const reimb = ['InstgRmbrsmntAgt', 'InstdRmbrsmntAgt', 'ThrdRmbrsmntAgt'].filter((r) => has(sttlm, r));
  const flag = (r: string, message: string) => {
    const n = at(sttlm, r)!;
    report({ code: 'SETTLEMENT_METHOD', path: n.path, line: n.el.line, message });
  };
  if (mtd === 'CLRG')
    for (const r of [...(has(sttlm, 'SttlmAcct') ? ['SttlmAcct'] : []), ...reimb]) flag(r, `SttlmMtd is CLRG (settled through a clearing system), so ${r} is not allowed.`);
  if (mtd === 'INDA' || mtd === 'INGA') {
    if (reimb.length) flag(reimb[0], `SttlmMtd is ${mtd} (settled on an account between the two agents), so reimbursement agents are not allowed.`);
    if (has(sttlm, 'ClrSys')) flag('ClrSys', `SttlmMtd is ${mtd} (settled on an account between the two agents), so ClrSys is not allowed.`);
  }
  if (mtd === 'COVE') {
    if (!has(sttlm, 'InstgRmbrsmntAgt') && !has(sttlm, 'InstdRmbrsmntAgt'))
      report({ code: 'SETTLEMENT_METHOD', path: sttlm.path, line: sttlm.el.line, message: 'SttlmMtd is COVE (cover payment), so InstgRmbrsmntAgt or InstdRmbrsmntAgt must be given.' });
    for (const r of ['SttlmAcct', 'ClrSys'].filter((x) => has(sttlm, x))) flag(r, `SttlmMtd is COVE (cover payment), so ${r} is not allowed.`);
  }
  if (has(sttlm, 'ThrdRmbrsmntAgt') && !(has(sttlm, 'InstgRmbrsmntAgt') && has(sttlm, 'InstdRmbrsmntAgt')))
    flag('ThrdRmbrsmntAgt', 'ThrdRmbrsmntAgt needs both InstgRmbrsmntAgt and InstdRmbrsmntAgt.');
  for (const r of ['InstgRmbrsmntAgt', 'InstdRmbrsmntAgt', 'ThrdRmbrsmntAgt']) {
    const acct = at(sttlm, `${r}Acct`);
    if (acct && !has(sttlm, r)) report({ code: 'ACCOUNT_WITHOUT_AGENT', path: acct.path, line: acct.el.line, message: `${r}Acct is present without ${r}.` });
  }
  if (mtd === 'CLRG' && !has(sttlm, 'ClrSys'))
    report({ severity: 'warning', code: 'CLEARING_SYSTEM_MISSING', path: sttlm.path, line: sttlm.el.line, message: 'SttlmMtd is CLRG but no ClrSys says which clearing system.' });
}

/** pacs.008 and pacs.009: the interbank credit transfers. */
function interbank(root: Node, report: Sink, customer: boolean) {
  const grp = at(root, 'GrpHdr')!;
  const txs = childrenNamed(root, 'CdtTrfTxInf');
  const amts = txs.map((t) => at(t, 'IntrBkSttlmAmt'));
  countAndSum(grp, txs, amts.map(val), 'message', report);

  const total = at(grp, 'TtlIntrBkSttlmAmt');
  if (total) {
    const ccy = total.el.attrs.Ccy;
    const off = amts.filter((a) => a && a.el.attrs.Ccy !== ccy);
    for (const a of off)
      report({ code: 'TOTAL_CURRENCY', path: a!.path, line: a!.el.line, message: `IntrBkSttlmAmt is in ${a!.el.attrs.Ccy}, but TtlIntrBkSttlmAmt is in ${ccy}: every transaction must settle in the total's currency.` });
    if (!off.length) {
      const sum = sumDecimal(amts.map((a) => val(a)!));
      if (!sameDecimal(val(total)!, sum))
        report({ code: 'TOTAL_AMOUNT', path: total.path, line: total.el.line, message: `TtlIntrBkSttlmAmt is ${val(total)} ${ccy}, but the transactions' IntrBkSttlmAmt add up to ${sum} ${ccy}.` });
    }
  }

  const grpDate = at(grp, 'IntrBkSttlmDt');
  for (const tx of txs) {
    const d = at(tx, 'IntrBkSttlmDt');
    if (grpDate && d) report({ code: 'SETTLEMENT_DATE_TWICE', path: d.path, line: d.el.line, message: 'IntrBkSttlmDt is in the group header, so it must not be repeated in a transaction.' });
    if (!grpDate && !d) report({ code: 'SETTLEMENT_DATE_MISSING', path: tx.path, line: tx.el.line, message: 'No interbank settlement date: give IntrBkSttlmDt in the group header or in every transaction.' });
    for (const agent of ['InstgAgt', 'InstdAgt']) {
      const a = at(tx, agent);
      if (a && has(grp, agent)) report({ code: 'AGENT_TWICE', path: a.path, line: a.el.line, message: `${agent} is in the group header, so it must not also be in a transaction.` });
    }
    // Intermediary and previous instructing agents are a chain: 2 needs 1, 3 needs 2; an account needs its agent.
    for (const base of ['IntrmyAgt', 'PrvsInstgAgt']) {
      for (const n of [2, 3]) {
        const a = at(tx, `${base}${n}`);
        if (a && !has(tx, `${base}${n - 1}`)) report({ code: 'AGENT_CHAIN', path: a.path, line: a.el.line, message: `${base}${n} is present without ${base}${n - 1}: fill the chain in order.` });
      }
      for (const n of [1, 2, 3]) {
        const acct = at(tx, `${base}${n}Acct`);
        if (acct && !has(tx, `${base}${n}`)) report({ code: 'ACCOUNT_WITHOUT_AGENT', path: acct.path, line: acct.el.line, message: `${base}${n}Acct is present without ${base}${n}.` });
      }
    }
    if (customer) {
      const instd = at(tx, 'InstdAmt');
      const sttl = at(tx, 'IntrBkSttlmAmt')!;
      const xchg = at(tx, 'XchgRate');
      if (instd && instd.el.attrs.Ccy !== sttl.el.attrs.Ccy && !xchg)
        report({ code: 'EXCHANGE_RATE_MISSING', path: instd.path, line: instd.el.line, message: `InstdAmt is in ${instd.el.attrs.Ccy} and the settlement in ${sttl.el.attrs.Ccy}, so XchgRate must be given.` });
      if (instd && instd.el.attrs.Ccy === sttl.el.attrs.Ccy && xchg)
        report({ code: 'EXCHANGE_RATE_NOT_ALLOWED', path: xchg.path, line: xchg.el.line, message: 'XchgRate is given, but InstdAmt and IntrBkSttlmAmt are in the same currency.' });
      const chrgs = at(tx, 'ChrgsInf');
      if (chrgs && !instd) report({ code: 'CHARGES_WITHOUT_INSTRUCTED_AMOUNT', path: chrgs.path, line: chrgs.el.line, message: 'ChrgsInf is present, so InstdAmt (the amount before charges) must be given too.' });
      if (!has(tx, 'PmtId/UETR')) report({ severity: 'warning', code: 'UETR_MISSING', path: `${tx.path}/PmtId`, line: tx.el.line, message: 'No UETR: SWIFT CBPR+ and most RTGS systems require one on every payment (market practice).' });
    }
    if (val(at(tx, 'IntrBkSttlmAmt')) !== undefined && /^0*(\.0*)?$/.test(val(at(tx, 'IntrBkSttlmAmt'))!))
      report({ severity: 'warning', code: 'ZERO_AMOUNT', path: at(tx, 'IntrBkSttlmAmt')!.path, line: tx.el.line, message: 'The settlement amount is zero.' });
  }

  settlementInfo(at(grp, 'SttlmInf')!, report);

  duplicates(txs.map((t) => at(t, 'PmtId/UETR')).filter((x): x is Node => !!x), 'UETR', 'DUPLICATE_UETR', report, 'error');
  duplicates(txs.map((t) => at(t, 'PmtId/TxId')).filter((x): x is Node => !!x), 'TxId', 'DUPLICATE_ID', report);
}

function createdInFuture(grp: Node, now: Date, report: Sink) {
  const c = at(grp, 'CreDtTm');
  const v = val(c);
  if (!c || !v) return;
  // A time with no zone is read as UTC; a day's grace covers every zone.
  const t = Date.parse(/[Zz]|[+-]\d\d:\d\d$/.test(v) ? v : `${v}Z`);
  if (t - now.getTime() > 24 * 3600_000)
    report({ severity: 'warning', code: 'CREATED_IN_FUTURE', path: c.path, line: c.el.line, message: `CreDtTm ${v} is more than a day in the future.` });
}

// ---- pain.001 ------------------------------------------------------------------------

function initiation(root: Node, report: Sink) {
  const grp = at(root, 'GrpHdr')!;
  const pmts = childrenNamed(root, 'PmtInf');
  const amountOf = (tx: Node) => val(at(tx, 'Amt/InstdAmt')) ?? val(at(tx, 'Amt/EqvtAmt/Amt'));
  const allTxs = pmts.flatMap((p) => childrenNamed(p, 'CdtTrfTxInf'));
  countAndSum(grp, allTxs, allTxs.map(amountOf), 'message', report);
  // Against the message's own creation date, not the clock: an archived file stays valid.
  const created = val(at(grp, 'CreDtTm'))!.slice(0, 10);
  for (const p of pmts) {
    const txs = childrenNamed(p, 'CdtTrfTxInf');
    countAndSum(p, txs, txs.map(amountOf), 'payment information block', report);
    const mtd = val(at(p, 'PmtMtd'));
    for (const tx of txs) {
      const cheque = at(tx, 'ChqInstr');
      if (cheque && mtd !== 'CHK') report({ code: 'CHEQUE_METHOD', path: cheque.path, line: cheque.el.line, message: `ChqInstr is given, so PmtMtd must be CHK; it is ${mtd}.` });
      const acct = at(tx, 'CdtrAcct');
      if (mtd === 'CHK' && acct) report({ code: 'CHEQUE_ACCOUNT', path: acct.path, line: acct.el.line, message: 'PmtMtd is CHK (a cheque), so CdtrAcct is not allowed.' });
      if (mtd === 'TRF' && !acct) report({ severity: 'warning', code: 'CREDITOR_ACCOUNT_MISSING', path: tx.path, line: tx.el.line, message: 'A transfer with no CdtrAcct: most banks need the creditor account to pay it.' });
      for (const el of ['PmtTpInf', 'UltmtDbtr', 'ChrgBr']) {
        const inTx = at(tx, el);
        if (inTx && has(p, el)) report({ code: 'LEVEL_TWICE', path: inTx.path, line: inTx.el.line, message: `${el} is given in the payment information block, so it must not also be in a transaction.` });
      }
    }
    const chrgAgt = at(p, 'ChrgsAcctAgt');
    if (chrgAgt && !has(p, 'ChrgsAcct')) report({ code: 'CHARGES_ACCOUNT_AGENT', path: chrgAgt.path, line: chrgAgt.el.line, message: 'ChrgsAcctAgt is present without ChrgsAcct.' });
    const d = at(p, 'ReqdExctnDt/Dt') ?? at(p, 'ReqdExctnDt/DtTm');
    if (d && val(d)!.slice(0, 10) < created)
      report({ severity: 'warning', code: 'EXECUTION_DATE_PAST', path: d.path, line: d.el.line, message: `ReqdExctnDt ${val(d)} is before the message was created (${created}); banks either reject it or pay on the next business day.` });
  }
  duplicates(pmts.map((p) => at(p, 'PmtInfId')!), 'PmtInfId', 'DUPLICATE_ID', report);
  duplicates(allTxs.map((t) => at(t, 'PmtId/EndToEndId')!).filter((n) => val(n) !== 'NOTPROVIDED'), 'EndToEndId', 'DUPLICATE_ID', report);
}

// ---- camt.053 and camt.054 --------------------------------------------------------------

/** Every element named `name` below n, at any depth. */
function descendants(n: Node, name: string): Node[] {
  const out: Node[] = [];
  const walk = (x: Node) => {
    const seen = new Map<string, number>();
    for (const el of x.el.children) {
      const i = (seen.get(el.name) ?? 0) + 1;
      seen.set(el.name, i);
      const total = x.el.children.filter((c) => c.name === el.name).length;
      const child = { el, path: total > 1 || INDEXED.has(el.name) ? `${x.path}/${el.name}[${i}]` : `${x.path}/${el.name}` };
      if (el.name === name) out.push(child);
      walk(child);
    }
  };
  walk(n);
  return out;
}

/** A reason with code NARR must carry its narrative (StatusReasonRule, ReturnReasonRule). */
function narrative(reasons: Node[], report: Sink) {
  for (const r of reasons) {
    const cd = at(r, 'Rsn/Cd');
    if (cd && val(cd) === 'NARR' && !has(r, 'AddtlInf'))
      report({ code: 'NARRATIVE_MISSING', path: cd.path, line: cd.el.line, message: 'The reason code is NARR (narrative), so AddtlInf must say what the reason is.' });
  }
}

/**
 * What camt.053 statements and camt.054 notifications share: entries in the account's
 * currency, a transaction summary that adds up, bank transaction codes, unique entry references.
 */
function entries(block: Node, ntries: Node[], report: Sink) {
  const acctCcy = val(at(block, 'Acct/Ccy'));
  for (const n of ntries) {
    const amt = at(n, 'Amt')!;
    if (acctCcy && amt.el.attrs.Ccy !== acctCcy)
      report({ severity: 'warning', code: 'ENTRY_CURRENCY', path: amt.path, line: amt.el.line, message: `The entry is in ${amt.el.attrs.Ccy}, but the account is in ${acctCcy}.` });
    // DomainOrProprietaryRule, on the entry's code and on every code inside it.
    for (const tag of ['BkTxCd', 'OrgnlBkTxCd'])
      for (const c of descendants(n, tag))
        if (!has(c, 'Domn') && !has(c, 'Prtry'))
          report({ code: 'BANK_TRANSACTION_CODE', path: c.path, line: c.el.line, message: `${tag} is empty: give the ISO bank transaction code (Domn), a proprietary one (Prtry), or both.` });
  }

  const summary = at(block, 'TxsSummry/TtlNtries');
  if (summary) {
    const nb = at(summary, 'NbOfNtries');
    if (nb && Number(val(nb)) !== ntries.length)
      report({ code: 'ENTRY_COUNT', path: nb.path, line: nb.el.line, message: `TtlNtries/NbOfNtries says ${val(nb)}, but the ${block.el.name === 'Stmt' ? 'statement' : 'notification'} has ${ntries.length} entr${ntries.length === 1 ? 'y' : 'ies'}.` });
    const sum = at(summary, 'Sum');
    const plain = sumDecimal(['0', ...ntries.map((n) => val(at(n, 'Amt'))!)]);
    if (sum && !sameDecimal(val(sum)!, plain))
      report({ code: 'ENTRY_SUM', path: sum.path, line: sum.el.line, message: `TtlNtries/Sum says ${val(sum)}, but the entry amounts add up to ${plain}.` });
    const net = at(summary, 'TtlNetNtry/Amt');
    if (net) {
      const allNet = sumDecimal(['0', ...ntries.map((n) => signed(val(at(n, 'Amt'))!, val(at(n, 'CdtDbtInd'))))]);
      const stated = signed(val(net)!, val(at(summary, 'TtlNetNtry/CdtDbtInd')));
      if (!sameDecimal(stated, allNet))
        report({ code: 'ENTRY_NET', path: net.path, line: net.el.line, message: `TtlNetNtry says ${stated}, but credits minus debits is ${allNet}.` });
    }
  }
  for (const [tag, ind] of [['TxsSummry/TtlCdtNtries', 'CRDT'], ['TxsSummry/TtlDbtNtries', 'DBIT']] as const) {
    const s = at(block, tag);
    if (!s) continue;
    const side = ntries.filter((n) => val(at(n, 'CdtDbtInd')) === ind);
    const nb = at(s, 'NbOfNtries');
    if (nb && Number(val(nb)) !== side.length)
      report({ code: 'ENTRY_COUNT', path: nb.path, line: nb.el.line, message: `${tag.split('/')[1]}/NbOfNtries says ${val(nb)}, but there are ${side.length} ${ind === 'CRDT' ? 'credit' : 'debit'} entries.` });
    const sum = at(s, 'Sum');
    const total = sumDecimal(['0', ...side.map((n) => val(at(n, 'Amt'))!)]);
    if (sum && !sameDecimal(val(sum)!, total))
      report({ code: 'ENTRY_SUM', path: sum.path, line: sum.el.line, message: `${tag.split('/')[1]}/Sum says ${val(sum)}, but the ${ind === 'CRDT' ? 'credit' : 'debit'} entries add up to ${total}.` });
  }
  narrative(descendants(block, 'RtrInf'), report);
  duplicates(ntries.map((n) => at(n, 'NtryRef')).filter((x): x is Node => !!x), 'NtryRef', 'DUPLICATE_ID', report);
}

function statement(root: Node, report: Sink) {
  for (const st of childrenNamed(root, 'Stmt')) {
    const ntries = childrenNamed(st, 'Ntry');
    const booked = ntries.filter((n) => (val(at(n, 'Sts/Cd')) ?? val(at(n, 'Sts/Prtry'))) === 'BOOK');
    const movement = sumDecimal(['0', ...booked.map((n) => signed(val(at(n, 'Amt'))!, val(at(n, 'CdtDbtInd'))))]);

    const bal = (codes: string[]) => all(st, 'Bal').find((b) => codes.includes(val(at(b, 'Tp/CdOrPrtry/Cd')) ?? ''));
    const open = bal(['OPBD', 'PRCD']);
    const close = bal(['CLBD']);
    const paged = has(st, 'StmtPgntn') && (val(at(st, 'StmtPgntn/LastPgInd')) === 'false' || val(at(st, 'StmtPgntn/PgNb')) !== '1');
    if (open && close && !paged) {
      const o = signed(val(at(open, 'Amt'))!, val(at(open, 'CdtDbtInd')));
      const c = signed(val(at(close, 'Amt'))!, val(at(close, 'CdtDbtInd')));
      const expected = sumDecimal([o, movement]);
      if (!sameDecimal(expected, c))
        report({ code: 'BALANCE_MISMATCH', path: close.path, line: close.el.line, message: `Opening balance ${o} plus booked entries ${movement} is ${expected}, but the closing balance (CLBD) is ${c}.` });
    } else if (!open || !close) {
      report({ severity: 'warning', code: 'BALANCES_MISSING', path: st.path, line: st.el.line, message: `The statement has no ${!open ? 'opening (OPBD)' : 'closing (CLBD)'} balance, so it can't be reconciled.` });
    }
    entries(st, ntries, report);
  }
}

function notification(root: Node, report: Sink) {
  const ntfs = childrenNamed(root, 'Ntfctn');
  // MessageOrNotificationPaginationRule.
  if (has(root, 'GrpHdr/MsgPgntn'))
    for (const n of ntfs) {
      const pg = at(n, 'NtfctnPgntn');
      if (pg) report({ code: 'PAGINATION_TWICE', path: pg.path, line: pg.el.line, message: 'The group header already has MsgPgntn, so a notification must not also have NtfctnPgntn: paginate the message or the notification, not both.' });
    }
  for (const n of ntfs) {
    const ntries = childrenNamed(n, 'Ntry');
    if (!ntries.length) report({ severity: 'warning', code: 'NO_ENTRIES', path: n.path, line: n.el.line, message: 'The notification has no entries, so it tells the customer of no debit or credit.' });
    entries(n, ntries, report);
    for (const tx of descendants(n, 'TxDtls')) {
      // ReferenceGuideline: at least one reference to identify the underlying transaction.
      const refs = at(tx, 'Refs');
      if (!refs || !refs.el.children.length)
        report({ severity: 'warning', code: 'REFERENCE_MISSING', path: tx.path, line: tx.el.line, message: 'The transaction details give no reference (EndToEndId, UETR, AcctSvcrRef…), so the customer cannot match the entry to a payment (ISO 20022 guideline).' });
      // DescriptionPresenceRule, ISINPresenceRule, OtherIdentificationPresenceRule.
      const sec = at(tx, 'FinInstrmId');
      if (sec && !has(sec, 'ISIN') && !has(sec, 'OthrId') && !has(sec, 'Desc'))
        report({ code: 'SECURITY_ID_MISSING', path: sec.path, line: sec.el.line, message: 'FinInstrmId is empty: give the ISIN, another identification (OthrId) or, as a last resort, a description (Desc).' });
    }
  }
}

// ---- pacs.002 ------------------------------------------------------------------------

/** ExternalPaymentTransactionStatus1Code, from the ISO 20022 external code sets. */
const TX_STATUSES = new Set(['ACCC', 'ACCP', 'ACFC', 'ACIS', 'ACPD', 'ACSC', 'ACSP', 'ACTC', 'ACWC', 'ACWP', 'BLCK', 'CANC', 'CPUC', 'PATC', 'PDNG', 'PRES', 'RCVD', 'RJCT']);
/** ExternalPaymentGroupStatus1Code: the transaction statuses plus PART. */
const GROUP_STATUSES = new Set([...TX_STATUSES, 'PART']);
/** Group statuses under which no transaction may be rejected (GroupStatusAcceptedRule, GroupStatusPendingRule). */
const NO_REJECT_UNDER = new Set(['ACTC', 'ACCP', 'ACSP', 'ACSC', 'ACWC', 'PDNG']);

function statusReport(root: Node, report: Sink) {
  const groups = childrenNamed(root, 'OrgnlGrpInfAndSts');
  const txs = childrenNamed(root, 'TxInfAndSts');

  for (const n of [...groups.map((g) => at(g, 'GrpSts')), ...txs.map((t) => at(t, 'TxSts'))]) {
    if (!n) continue;
    const v = val(n)!;
    if (n.el.name === 'TxSts' && v === 'PART')
      report({ code: 'STATUS_CODE', path: n.path, line: n.el.line, message: 'PART (partially accepted) is a group status; a single transaction is accepted, pending or rejected.' });
    else if (!(n.el.name === 'GrpSts' ? GROUP_STATUSES : TX_STATUSES).has(v))
      report({ severity: 'warning', code: 'STATUS_CODE', path: n.path, line: n.el.line, message: `${n.el.name} "${v}" is not in the ISO 20022 external status code list.` });
  }

  // OriginalGroupInformationAbsenceRule, …MultiplePresenceRule, …SinglePresenceRule.
  for (const tx of txs) {
    const own = at(tx, 'OrgnlGrpInf');
    if (groups.length === 1 && own)
      report({ code: 'ORIGINAL_GROUP_REFERENCE', path: own.path, line: own.el.line, message: 'The report covers one original message (one OrgnlGrpInfAndSts), so a transaction must not repeat OrgnlGrpInf.' });
    if (groups.length !== 1 && !own)
      report({ code: 'ORIGINAL_GROUP_REFERENCE', path: tx.path, line: tx.el.line, message: groups.length ? 'The report covers several original messages, so each transaction must say which one it belongs to (OrgnlGrpInf).' : 'There is no OrgnlGrpInfAndSts, so each transaction must say which original message it belongs to (OrgnlGrpInf).' });
  }

  for (const g of groups) {
    const gs = val(at(g, 'GrpSts'));
    const mine = groups.length === 1 ? txs : txs.filter((t) => val(at(t, 'OrgnlGrpInf/OrgnlMsgId')) === val(at(g, 'OrgnlMsgId')));
    if (gs) {
      // GroupStatusAcceptedRule, GroupStatusPendingRule, GroupStatusReceivedRule, GroupStatusRejectedRule.
      for (const t of mine) {
        const ts = at(t, 'TxSts');
        if (!ts) continue;
        if (gs === 'RCVD')
          report({ code: 'GROUP_STATUS', path: ts.path, line: ts.el.line, message: 'GrpSts is RCVD (received, not yet checked), so a transaction cannot have a status yet: leave TxSts out.' });
        else if (NO_REJECT_UNDER.has(gs) && val(ts) === 'RJCT')
          report({ code: 'GROUP_STATUS', path: ts.path, line: ts.el.line, message: `GrpSts is ${gs}, which says the whole group went through, but this transaction is RJCT: use GrpSts PART when only some are rejected.` });
        else if (gs === 'RJCT' && val(ts) !== 'RJCT')
          report({ code: 'GROUP_STATUS', path: ts.path, line: ts.el.line, message: `GrpSts is RJCT (the whole group is rejected), so every transaction status given must be RJCT; this one is ${val(ts)}.` });
      }
      // StatusReasonInformationRule.
      if (gs !== 'RJCT' && gs !== 'PDNG')
        for (const ai of all(g, 'StsRsnInf/AddtlInf'))
          report({ code: 'STATUS_REASON_INFO', path: ai.path, line: ai.el.line, message: `GrpSts is ${gs}; the group's StsRsnInf/AddtlInf is only allowed when the group is rejected (RJCT) or pending (PDNG).` });
    }
    // NumberOfTransactionPerStatusGuideline.
    const perSts = childrenNamed(g, 'NbOfTxsPerSts');
    if (perSts.length && gs !== 'PART')
      report({ severity: 'warning', code: 'STATUS_COUNT', path: perSts[0].path, line: perSts[0].el.line, message: `NbOfTxsPerSts should only be given when GrpSts is PART (partially accepted)${gs ? `; it is ${gs}` : ''} (ISO 20022 guideline).` });
    const orig = val(at(g, 'OrgnlNbOfTxs'));
    if (orig && perSts.length) {
      const total = perSts.reduce((a, x) => a + Number(val(at(x, 'DtldNbOfTxs'))), 0);
      if (total !== Number(orig))
        report({ severity: 'warning', code: 'STATUS_COUNT', path: perSts[0].path, line: perSts[0].el.line, message: `The counts per status add up to ${total}, but OrgnlNbOfTxs says the original message had ${orig}.` });
    }
  }

  narrative([...groups.flatMap((g) => childrenNamed(g, 'StsRsnInf')), ...txs.flatMap((t) => childrenNamed(t, 'StsRsnInf'))], report);
  for (const t of txs) {
    const sttlm = at(t, 'OrgnlTxRef/SttlmInf');
    if (sttlm) settlementInfo(sttlm, report);
    if (!has(t, 'OrgnlUETR')) report({ severity: 'warning', code: 'UETR_MISSING', path: t.path, line: t.el.line, message: 'No OrgnlUETR: SWIFT CBPR+ requires the UETR of the payment the status is about (market practice).' });
  }
  duplicates(txs.map((t) => at(t, 'StsId')).filter((x): x is Node => !!x), 'StsId', 'DUPLICATE_ID', report);
}

// ---- pacs.004 ------------------------------------------------------------------------

function paymentReturn(root: Node, report: Sink) {
  const grp = at(root, 'GrpHdr')!;
  const txs = childrenNamed(root, 'TxInf');
  const grpRtr = val(at(grp, 'GrpRtr'));
  const whole = grpRtr === 'true' || grpRtr === '1';

  if (whole) {
    // GroupReturnAndTransactionInformationNotPresentRule, ControlSumAndGroupReturnRule, GroupReturnAndReturnReasonRule.
    for (const t of txs)
      report({ code: 'GROUP_RETURN', path: t.path, line: t.el.line, message: 'GrpRtr is true (the whole original message is returned), so TxInf is not allowed.' });
    const cs = at(grp, 'CtrlSum');
    if (cs) report({ code: 'GROUP_RETURN', path: cs.path, line: cs.el.line, message: 'GrpRtr is true (the whole original message is returned), so CtrlSum is not allowed.' });
    if (!has(root, 'OrgnlGrpInf/RtrRsnInf/Rsn'))
      report({ code: 'GROUP_RETURN', path: `${root.path}/OrgnlGrpInf`, line: (at(root, 'OrgnlGrpInf') ?? grp).el.line, message: 'GrpRtr is true, so OrgnlGrpInf/RtrRsnInf/Rsn must say why the whole message is returned.' });
  } else {
    // GroupReturnAndTransactionInformationPresentRule, GroupReturnAndNumberOfTransactionsRule.
    if (!txs.length) report({ code: 'GROUP_RETURN', path: root.path, line: root.el.line, message: 'GrpRtr is not true, so the message must return at least one transaction (TxInf).' });
    countAndSum(grp, txs, txs.map((t) => val(at(t, 'RtrdIntrBkSttlmAmt'))), 'message', report);
  }

  // TotalReturnedInterbankSettlementAmountRule, …AndSumRule, TotalInterbankSettlementAmountAndDateRule.
  const total = at(grp, 'TtlRtrdIntrBkSttlmAmt');
  const amts = txs.map((t) => at(t, 'RtrdIntrBkSttlmAmt')!);
  if (total) {
    const ccy = total.el.attrs.Ccy;
    const off = amts.filter((a) => a.el.attrs.Ccy !== ccy);
    for (const a of off)
      report({ code: 'TOTAL_CURRENCY', path: a.path, line: a.el.line, message: `RtrdIntrBkSttlmAmt is in ${a.el.attrs.Ccy}, but TtlRtrdIntrBkSttlmAmt is in ${ccy}: every return must settle in the total's currency.` });
    if (!off.length && txs.length) {
      const sum = sumDecimal(amts.map((a) => val(a)!));
      if (!sameDecimal(val(total)!, sum))
        report({ code: 'TOTAL_AMOUNT', path: total.path, line: total.el.line, message: `TtlRtrdIntrBkSttlmAmt is ${val(total)} ${ccy}, but the returned amounts (RtrdIntrBkSttlmAmt) add up to ${sum} ${ccy}.` });
    }
    if (!has(grp, 'IntrBkSttlmDt'))
      report({ code: 'SETTLEMENT_DATE_MISSING', path: total.path, line: total.el.line, message: 'TtlRtrdIntrBkSttlmAmt is given, so the group header must also give IntrBkSttlmDt.' });
  }

  const msgOrig = at(root, 'OrgnlGrpInf');
  const grpDate = at(grp, 'IntrBkSttlmDt');
  for (const tx of txs) {
    // OriginalGroupInformationRule.
    const own = at(tx, 'OrgnlGrpInf');
    if (msgOrig && own) report({ code: 'ORIGINAL_GROUP_REFERENCE', path: own.path, line: own.el.line, message: 'OrgnlGrpInf is given for the whole message, so a transaction must not repeat it.' });
    if (!msgOrig && !own) report({ severity: 'warning', code: 'ORIGINAL_GROUP_REFERENCE', path: tx.path, line: tx.el.line, message: 'Nothing says which message is being returned: give OrgnlGrpInf for the message or in the transaction.' });
    // GroupHeaderInterbankSettlementDateRule, TransactionInterbankSettlementDateRule.
    const d = at(tx, 'IntrBkSttlmDt');
    if (grpDate && d) report({ code: 'SETTLEMENT_DATE_TWICE', path: d.path, line: d.el.line, message: 'IntrBkSttlmDt is in the group header, so it must not be repeated in a transaction.' });
    if (!grpDate && !d) report({ code: 'SETTLEMENT_DATE_MISSING', path: tx.path, line: tx.el.line, message: 'No interbank settlement date: give IntrBkSttlmDt in the group header or in every transaction.' });
    // InstructingAgentRule, InstructedAgentRule.
    for (const agent of ['InstgAgt', 'InstdAgt']) {
      const a = at(tx, agent);
      if (a && has(grp, agent)) report({ code: 'AGENT_TWICE', path: a.path, line: a.el.line, message: `${agent} is in the group header, so it must not also be in a transaction.` });
    }
    // ReturnedInstructedAmountAndExchangeRate1Rule and 2Rule, ChargesInformationAndReturnedInstructedAmountRule.
    const instd = at(tx, 'RtrdInstdAmt');
    const sttl = at(tx, 'RtrdIntrBkSttlmAmt')!;
    const xchg = at(tx, 'XchgRate');
    if (instd && instd.el.attrs.Ccy !== sttl.el.attrs.Ccy && !xchg)
      report({ code: 'EXCHANGE_RATE_MISSING', path: instd.path, line: instd.el.line, message: `RtrdInstdAmt is in ${instd.el.attrs.Ccy} and the returned settlement amount in ${sttl.el.attrs.Ccy}, so XchgRate must be given.` });
    if (instd && instd.el.attrs.Ccy === sttl.el.attrs.Ccy && xchg)
      report({ code: 'EXCHANGE_RATE_NOT_ALLOWED', path: xchg.path, line: xchg.el.line, message: 'XchgRate is given, but RtrdInstdAmt and RtrdIntrBkSttlmAmt are in the same currency.' });
    const chrgs = at(tx, 'ChrgsInf');
    if (chrgs && !instd) report({ code: 'CHARGES_WITHOUT_INSTRUCTED_AMOUNT', path: chrgs.path, line: chrgs.el.line, message: 'ChrgsInf is present, so RtrdInstdAmt (the amount returned before charges) must be given too.' });
    if (!has(tx, 'RtrRsnInf/Rsn')) report({ severity: 'warning', code: 'RETURN_REASON_MISSING', path: tx.path, line: tx.el.line, message: 'No return reason: SWIFT CBPR+ requires RtrRsnInf/Rsn on every returned payment (market practice).' });
    if (!has(tx, 'OrgnlUETR')) report({ severity: 'warning', code: 'UETR_MISSING', path: tx.path, line: tx.el.line, message: 'No OrgnlUETR: SWIFT CBPR+ requires the UETR of the payment being returned (market practice).' });
    if (/^0*(\.0*)?$/.test(val(sttl)!)) report({ severity: 'warning', code: 'ZERO_AMOUNT', path: sttl.path, line: sttl.el.line, message: 'The returned amount is zero.' });
  }

  const sttlm = at(grp, 'SttlmInf')!;
  settlementInfo(sttlm, report);
  // NoCoverSettlementMethodRule: a returned direct debit is never settled by cover.
  const mtd = at(sttlm, 'SttlmMtd')!;
  const origNames = [val(at(root, 'OrgnlGrpInf/OrgnlMsgNmId')), ...txs.map((t) => val(at(t, 'OrgnlGrpInf/OrgnlMsgNmId')))];
  if (val(mtd) === 'COVE' && origNames.some((n) => n?.startsWith('pacs.003')))
    report({ code: 'SETTLEMENT_METHOD', path: mtd.path, line: mtd.el.line, message: 'This returns a direct debit (pacs.003), so SttlmMtd must not be COVE.' });
  narrative([...all(root, 'OrgnlGrpInf/RtrRsnInf'), ...txs.flatMap((t) => childrenNamed(t, 'RtrRsnInf'))], report);
  duplicates(txs.map((t) => at(t, 'RtrId')).filter((x): x is Node => !!x), 'RtrId', 'DUPLICATE_ID', report);
}

// ---- seev.031 ------------------------------------------------------------------------

const dateOf = (n: Node | undefined) => (n ? val(at(n, 'Dt')) : undefined);

function corporateAction(root: Node, report: Sink) {
  const gen = at(root, 'CorpActnGnlInf')!;
  const evt = val(at(gen, 'EvtTp/Cd'));
  const mv = val(at(gen, 'MndtryVlntryEvtTp/Cd'));
  const ntfTp = val(at(root, 'NtfctnGnlInf/NtfctnTp'));
  const opts = childrenNamed(root, 'CorpActnOptnDtls');

  if ((ntfTp === 'REPL' || ntfTp === 'RMDR') && !has(root, 'PrvsNtfctnId'))
    report({ severity: 'warning', code: 'PREVIOUS_NOTIFICATION_MISSING', path: `${root.path}/NtfctnGnlInf/NtfctnTp`, line: at(root, 'NtfctnGnlInf/NtfctnTp')!.el.line, message: `NtfctnTp is ${ntfTp}, so PrvsNtfctnId should point at the notification it ${ntfTp === 'REPL' ? 'replaces' : 'reminds of'} (market practice).` });

  const mandatoryEvents = ['DVCA', 'SPLF', 'SPLR', 'BONU', 'CAPD', 'INTR', 'REDM', 'MCAL', 'PCAL', 'DRAW', 'LIQU', 'DECR', 'CHAN'];
  const mvNode = at(gen, 'MndtryVlntryEvtTp/Cd');
  if (evt && mv && mvNode && mandatoryEvents.includes(evt) && mv !== 'MAND')
    report({ severity: 'warning', code: 'EVENT_MANDATORY', path: mvNode.path, line: mvNode.el.line, message: `${evt} events are normally mandatory (MAND); this one is ${mv} (SMPG market practice).` });
  if ((mv === 'CHOS' || mv === 'VOLU') && opts.length < 2)
    report({ code: 'OPTIONS_MISSING', path: root.path, line: root.el.line, message: `A ${mv === 'CHOS' ? 'mandatory with choice' : 'voluntary'} event must offer options to choose from; this one has ${opts.length}.` });

  const optNbs = opts.map((o) => at(o, 'OptnNb')!);
  duplicates(optNbs, 'OptnNb', 'DUPLICATE_ID', report, 'error');
  const defaults = opts.filter((o) => val(at(o, 'DfltPrcgOrStgInstr/DfltOptnInd')) === 'true');
  if (opts.length && mv === 'CHOS' && defaults.length === 0)
    report({ severity: 'warning', code: 'DEFAULT_OPTION', path: root.path, line: root.el.line, message: 'A mandatory event with choice should mark one option as the default (DfltOptnInd true).' });
  if (defaults.length > 1)
    report({ code: 'DEFAULT_OPTION', path: defaults[1].path, line: defaults[1].el.line, message: `${defaults.length} options are marked as the default; only one can be.` });

  if (evt === 'DVCA' || evt === 'DVOP' || evt === 'DVSC') {
    const cash = opts.filter((o) => val(at(o, 'OptnTp/Cd')) === 'CASH');
    if (!cash.length) report({ code: 'CASH_OPTION_MISSING', path: root.path, line: root.el.line, message: `A ${evt} dividend needs a CASH option (CorpActnOptnDtls with OptnTp CASH).` });
    for (const o of cash) {
      const moves = childrenNamed(o, 'CshMvmntDtls');
      if (!moves.length) report({ severity: 'warning', code: 'CASH_MOVEMENT_MISSING', path: o.path, line: o.el.line, message: 'The CASH option has no CshMvmntDtls, so it says neither how much is paid nor when.' });
      if (moves.length && !moves.some((m) => has(m, 'RateAndAmtDtls/GrssDvddRate') || has(m, 'RateAndAmtDtls/NetDvddRate')))
        report({ severity: 'warning', code: 'DIVIDEND_RATE_MISSING', path: o.path, line: o.el.line, message: 'No GrssDvddRate or NetDvddRate: the notification never says what is paid per share.' });
    }
  }

  // Ex-date, record date, payment date: the order every market follows.
  const dd = at(root, 'CorpActnDtls/DtDtls');
  const ex = dateOf(dd && at(dd, 'ExDvddDt'));
  const rec = dateOf(dd && at(dd, 'RcrdDt'));
  const pays = opts.flatMap((o) => childrenNamed(o, 'CshMvmntDtls')).map((m) => ({ m, d: dateOf(at(m, 'DtDtls/PmtDt')) })).filter((x) => x.d);
  if (ex && rec && ex > rec) {
    const n = at(dd!, 'ExDvddDt')!;
    report({ severity: 'warning', code: 'DATE_ORDER', path: n.path, line: n.el.line, message: `The ex-date ${ex} is after the record date ${rec}; markets set the ex-date on or before the record date.` });
  }
  for (const p of pays) {
    if (rec && p.d! < rec) {
      const n = at(p.m, 'DtDtls/PmtDt')!;
      report({ code: 'DATE_ORDER', path: n.path, line: n.el.line, message: `The payment date ${p.d} is before the record date ${rec}: holders can't be paid before it is known who they are.` });
    }
  }
}

// ---- entry point ---------------------------------------------------------------------

export function checkRules(model: MessageModel, doc: XmlElement, report: Sink, now: Date): void {
  const id = model.id;
  byType(doc, model, report);
  const top = doc.children[0];
  if (!top) return;
  const root: Node = { el: top, path: `/Document/${top.name}` };
  const grp = at(root, 'GrpHdr');
  if (grp) createdInFuture(grp, now, report);
  if (id.startsWith('pacs.008')) interbank(root, report, true);
  else if (id.startsWith('pacs.009')) interbank(root, report, false);
  else if (id.startsWith('pain.001')) initiation(root, report);
  else if (id.startsWith('camt.053')) statement(root, report);
  else if (id.startsWith('camt.054')) notification(root, report);
  else if (id.startsWith('pacs.002')) statusReport(root, report);
  else if (id.startsWith('pacs.004')) paymentReturn(root, report);
  else if (id.startsWith('seev.031')) corporateAction(root, report);
}
