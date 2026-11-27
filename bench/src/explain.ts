// A plain-English walkthrough of an ISO 20022 message. The bench's models (bench/models/*.json) describe structure
// only, with no element documentation, so the meanings here are a hand-written glossary of common element names,
// as the ISO 20022 message definitions use them. An element not in the glossary is listed as unknown: its meaning
// is never guessed. Pure; uses the same parser and the same identifier checks as the Test Bench.
import { parseXml, XmlError, type XmlElement } from './xml.ts';
import { checkBic, checkCountry, checkCurrency, checkIban, checkLei } from './identifiers.ts';
import { minorUnits } from './codes.ts';
import { MESSAGES, NS_PREFIX } from './index.ts';

export const MAX_EXPLAIN = 2_000_000;

type G = [label: string, meaning: string];
/** name → [label, meaning]. Blocks (elements with children) and leaves share one table, as the names are the same in every message. */
export const GLOSSARY: Record<string, G> = {
  Document: ['Message', 'The envelope of an ISO 20022 message.'],
  FIToFICstmrCdtTrf: ['Customer credit transfer', 'A bank-to-bank payment carrying a customer’s transfer (pacs.008).'],
  FICdtTrf: ['Bank credit transfer', 'A payment between banks (pacs.009).'],
  FIToFIPmtStsRpt: ['Payment status report', 'A bank reporting the status of payments it received (pacs.002).'],
  PmtRtr: ['Payment return', 'A bank returning the money of a settled payment (pacs.004).'],
  CstmrCdtTrfInitn: ['Payment initiation', 'A customer asking their bank to pay (pain.001).'],
  BkToCstmrStmt: ['Bank statement', 'The account statement a bank sends its customer (camt.053).'],
  BkToCstmrDbtCdtNtfctn: ['Debit/credit notification', 'A bank reporting money in or out as it happens (camt.054).'],
  CorpActnNtfctn: ['Corporate action notification', 'An announcement of a dividend, split, merger or similar (seev.031).'],
  GrpHdr: ['Group header', 'Facts about the whole message: who sent it, when, and how many payments it holds.'],
  MsgId: ['Message ID', 'The sender’s reference for this message. Receivers use it to spot duplicates.'],
  CreDtTm: ['Created', 'When the message or statement was created.'],
  NbOfTxs: ['Number of transactions', 'How many payments the message says it contains. Must equal the real count.'],
  CtrlSum: ['Control sum', 'The sum of all the amounts, a checksum that the message is complete.'],
  TtlIntrBkSttlmAmt: ['Total settlement amount', 'The total of the interbank settlement amounts in the message.'],
  IntrBkSttlmDt: ['Settlement date', 'The date the banks settle the payment between themselves.'],
  SttlmInf: ['Settlement information', 'How the banks settle: through accounts they hold with each other, or a clearing system.'],
  SttlmMtd: ['Settlement method', 'INDA/INGA: settled through accounts held with the instructed/instructing agent; CLRG: a clearing system; COVE: a separate cover payment.'],
  PmtInf: ['Payment instruction', 'One batch of payments from the same debtor account with the same execution date.'],
  PmtInfId: ['Payment information ID', 'The sender’s reference for this batch.'],
  PmtMtd: ['Payment method', 'TRF means a credit transfer.'],
  BtchBookg: ['Batch booking', 'Whether the debtor wants the payments booked as one lump or one by one.'],
  ReqdExctnDt: ['Requested execution date', 'The date the debtor wants the payment made.'],
  CdtTrfTxInf: ['Credit transfer transaction', 'One payment: its references, amount, parties and details.'],
  PmtId: ['Payment identification', 'The references that identify this payment.'],
  InstrId: ['Instruction ID', 'A reference the instructing party gave this single instruction, passed between banks.'],
  EndToEndId: ['End-to-end ID', 'The reference set by the originator, delivered unchanged to the beneficiary. The usual key back to an invoice.'],
  TxId: ['Transaction ID', 'A reference for the transaction in the interbank leg.'],
  UETR: ['UETR', 'A universally unique tracking number (a UUID) that follows a payment across every bank on its way, so it can be tracked.'],
  ClrSysRef: ['Clearing system reference', 'The clearing system’s own reference for the payment.'],
  PmtTpInf: ['Payment type information', 'How the payment is to be handled (urgency, service level, purpose category).'],
  SvcLvl: ['Service level', 'An agreed service level for the payment, such as SEPA or a scheme code.'],
  LclInstrm: ['Local instrument', 'A local scheme or product code for the payment.'],
  CtgyPurp: ['Category purpose', 'A code for the kind of payment, for example salary.'],
  Purp: ['Purpose', 'Why the payment is made, as a code.'],
  IntrBkSttlmAmt: ['Interbank settlement amount', 'The amount the banks settle between themselves, with its currency.'],
  InstdAmt: ['Instructed amount', 'The amount the debtor asked to be sent, in the debtor’s chosen currency. Differs from the settlement amount if there is a currency conversion.'],
  Amt: ['Amount', 'An amount of money, with its currency.'],
  EqvtAmt: ['Equivalent amount', 'The amount expressed in another currency.'],
  InstdAmtOrEqvt: ['Instructed amount', 'The amount and currency requested.'],
  XchgRate: ['Exchange rate', 'The rate used if the currency was converted on the way.'],
  ChrgBr: ['Charge bearer', 'Who pays the bank charges: DEBT (the sender pays all), CRED (the receiver pays all), SHAR (each pays their own bank), SLEV (as the scheme’s rules say).'],
  ChrgsInf: ['Charges information', 'A charge taken on the way, who took it and how much.'],
  InstgAgt: ['Instructing agent', 'The bank that sends this instruction.'],
  InstdAgt: ['Instructed agent', 'The bank that receives this instruction.'],
  IntrmyAgt1: ['Intermediary bank 1', 'The first bank between the sender’s bank and the beneficiary’s bank.'],
  IntrmyAgt2: ['Intermediary bank 2', 'The second intermediary bank.'],
  DbtrAgt: ['Debtor’s bank', 'The bank where the payer holds the account.'],
  CdtrAgt: ['Creditor’s bank', 'The bank where the beneficiary holds the account.'],
  Dbtr: ['Debtor (payer)', 'The party whose account is debited.'],
  Cdtr: ['Creditor (beneficiary)', 'The party who is paid.'],
  UltmtDbtr: ['Ultimate debtor', 'The party that really owes the money, when it is not the account holder.'],
  UltmtCdtr: ['Ultimate creditor', 'The party the money is finally for, when it is not the account holder.'],
  InitgPty: ['Initiating party', 'The party that sent the instruction to the bank.'],
  DbtrAcct: ['Debtor account', 'The payer’s account.'],
  CdtrAcct: ['Creditor account', 'The beneficiary’s account.'],
  Acct: ['Account', 'The account the statement or instruction is about.'],
  FinInstnId: ['Financial institution', 'Identifies a bank.'],
  BrnchId: ['Branch', 'A branch of a bank.'],
  Nm: ['Name', 'A name.'],
  PstlAdr: ['Postal address', 'An address, either as structured fields or as free text lines.'],
  StrtNm: ['Street', 'Street name.'],
  BldgNb: ['Building number', 'The building number.'],
  BldgNm: ['Building name', 'The building name.'],
  PstCd: ['Postal code', 'The postal code.'],
  TwnNm: ['Town', 'Town or city.'],
  CtrySubDvsn: ['Country subdivision', 'State, province or county.'],
  Ctry: ['Country', 'ISO 3166 country code.'],
  AdrLine: ['Address line', 'A free-text address line (the unstructured form; some schemes want structured fields instead).'],
  Id: ['Identification', 'An identifier. What kind is given by the elements inside it.'],
  OrgId: ['Organisation identification', 'Identifies a company.'],
  PrvtId: ['Private identification', 'Identifies a person.'],
  AnyBIC: ['BIC', 'A bank or company business identifier code (ISO 9362).'],
  BICFI: ['BIC', 'The bank’s SWIFT business identifier code (ISO 9362).'],
  LEI: ['LEI', 'Legal Entity Identifier (ISO 17442): a 20-character code for a company.'],
  IBAN: ['IBAN', 'International bank account number (ISO 13616).'],
  Othr: ['Other identification', 'An identifier of a kind other than the standard ones.'],
  SchmeNm: ['Scheme name', 'Which scheme or kind of identifier the value is.'],
  Issr: ['Issuer', 'Who issued the identifier.'],
  ClrSysMmbId: ['Clearing system member ID', 'The bank’s ID inside a national clearing system.'],
  MmbId: ['Member ID', 'The member identifier in the clearing system.'],
  Ccy: ['Currency', 'ISO 4217 currency code.'],
  Tp: ['Type', 'The type of the thing it sits in.'],
  Cd: ['Code', 'A code from an external code list.'],
  Prtry: ['Proprietary', 'A code of the sender’s or scheme’s own, outside the standard lists.'],
  Ustrd: ['Remittance information (free text)', 'What the payment is for, as text for the beneficiary: an invoice number, a reference.'],
  Strd: ['Remittance information (structured)', 'What the payment is for, in structured fields such as an invoice or creditor reference.'],
  RmtInf: ['Remittance information', 'What the payment is for, for the beneficiary’s reconciliation.'],
  CdtrRefInf: ['Creditor reference', 'A structured payment reference (ISO 11649 or similar).'],
  Ref: ['Reference', 'A reference.'],
  RgltryRptg: ['Regulatory reporting', 'Information the payment must carry for authorities (balance of payments etc.).'],
  InstrForNxtAgt: ['Instruction for next agent', 'An instruction for the next bank in the chain.'],
  InstrInf: ['Instruction text', 'The text of the instruction.'],
  Stmt: ['Statement', 'One account statement.'],
  ElctrncSeqNb: ['Electronic sequence number', 'The statement’s serial number, so a missed one shows as a gap.'],
  LglSeqNb: ['Legal sequence number', 'The statement’s legal serial number.'],
  FrToDt: ['Statement period', 'The period the statement covers.'],
  FrDtTm: ['From', 'Start of the period.'],
  ToDtTm: ['To', 'End of the period.'],
  Bal: ['Balance', 'A balance on the account at a date. CdOrPrtry says which: OPBD opening booked, CLBD closing booked, CLAV closing available, ITBD interim booked.'],
  CdOrPrtry: ['Balance type', 'The kind of balance, as a code.'],
  CdtDbtInd: ['Credit or debit', 'CRDT: money in (a credit); DBIT: money out (a debit).'],
  Dt: ['Date', 'A date.'],
  DtTm: ['Date and time', 'A date with a time.'],
  Ntry: ['Entry', 'One booked item on the account: the amount, direction, dates and what it was.'],
  NtryRef: ['Entry reference', 'The bank’s reference for this entry.'],
  NtryDtls: ['Entry details', 'The transactions inside the entry.'],
  TxDtls: ['Transaction details', 'One underlying transaction of the entry.'],
  Refs: ['References', 'The references of the underlying transaction.'],
  AcctSvcrRef: ['Bank reference', 'The account servicer’s (bank’s) own reference.'],
  Sts: ['Status', 'The status of the entry or payment (BOOK booked, PDNG pending, INFO information only).'],
  BookgDt: ['Booking date', 'The date the bank booked the entry.'],
  ValDt: ['Value date', 'The date the money counts for interest and availability.'],
  BkTxCd: ['Bank transaction code', 'What kind of transaction this was, as the domain, family and sub-family codes.'],
  Domn: ['Domain', 'The top level of a bank transaction code, for example PMNT for payments.'],
  Fmly: ['Family', 'The family within the domain.'],
  SubFmlyCd: ['Sub-family code', 'The most specific level of the bank transaction code.'],
  TxsSummry: ['Transactions summary', 'Totals of the entries in the statement.'],
  TtlNtries: ['Total entries', 'Total number and sum of all entries.'],
  TtlCdtNtries: ['Total credits', 'Number and sum of credit entries.'],
  TtlDbtNtries: ['Total debits', 'Number and sum of debit entries.'],
  TtlNetNtry: ['Net total', 'Credits minus debits.'],
  NbOfNtries: ['Number of entries', 'How many entries.'],
  Sum: ['Sum', 'The total of the amounts.'],
  RltdPties: ['Related parties', 'The payer and payee of an underlying transaction.'],
  RltdAgts: ['Related agents', 'The banks of an underlying transaction.'],
  OrgnlGrpInfAndSts: ['Original group status', 'The status of the whole message this report is about.'],
  OrgnlGrpInf: ['Original group information', 'Identifies the original message being answered.'],
  OrgnlMsgId: ['Original message ID', 'The MsgId of the message this refers to.'],
  OrgnlMsgNmId: ['Original message name', 'The type of the original message, for example pacs.008.001.08.'],
  OrgnlInstrId: ['Original instruction ID', 'The InstrId of the payment this refers to.'],
  OrgnlEndToEndId: ['Original end-to-end ID', 'The EndToEndId of the payment this refers to.'],
  OrgnlTxId: ['Original transaction ID', 'The TxId of the payment this refers to.'],
  OrgnlUETR: ['Original UETR', 'The UETR of the payment this refers to.'],
  GrpSts: ['Group status', 'The status of the whole message.'],
  TxSts: ['Transaction status', 'ACSP: accepted, settlement in progress; ACSC: settlement completed; ACCC: credited to the creditor; ACTC: technically valid; PDNG: pending; RJCT: rejected.'],
  TxInfAndSts: ['Transaction status', 'The status of one payment.'],
  StsRsnInf: ['Status reason', 'Why the status is what it is.'],
  Rsn: ['Reason', 'A reason, as a code.'],
  AddtlInf: ['Additional information', 'Free text with more detail.'],
  RtrdIntrBkSttlmAmt: ['Returned amount', 'The amount sent back.'],
  RtrRsnInf: ['Return reason', 'Why the payment is being returned.'],
  RtrId: ['Return ID', 'The reference of the return.'],
  OrgnlTxRef: ['Original transaction reference', 'Details of the payment being returned.'],
  OrgnlIntrBkSttlmAmt: ['Original settlement amount', 'The amount of the original payment.'],
  CdtTrfTxInf_cov: ['Underlying customer transfer', 'The customer payment a cover payment covers.'],
  UndrlygCstmrCdtTrf: ['Underlying customer transfer', 'The customer payment a cover payment covers.'],
  CorpActnGnlInf: ['Corporate action general information', 'Which corporate action this is, and its references.'],
  EvtTp: ['Event type', 'The type of corporate action, as a code (DVCA cash dividend, SPLF forward split, MRGR merger…).'],
  EvtPrcgTp: ['Event processing type', 'How the event is processed, for example mandatory.'],
  OffclCorpActnEvtId: ['Official event ID', 'The official identifier of the event.'],
  UndrlygScty: ['Underlying security', 'The security the event is about.'],
  FinInstrmId: ['Financial instrument', 'Identifies the security: ISIN, and so on.'],
  ISIN: ['ISIN', 'International securities identification number (ISO 6166).'],
  CorpActnDtls: ['Corporate action details', 'The terms of the event: dates, amounts, options.'],
  CorpActnOptnDtls: ['Option details', 'One option holders may or will receive: cash, securities.'],
  CshMvmntDtls: ['Cash movement', 'Cash paid or received under the option.'],
  DtDtls: ['Date details', 'The key dates of the event (record, ex, payment).'],
  Mndt: ['Mandate', 'A direct debit mandate.'],
  OrgnlCreDtTm: ['Original creation time', 'When the original message was created.'],
  OrgnlNbOfTxs: ['Original number of transactions', 'How many payments the original message held.'],
  StsId: ['Status ID', 'The sender’s reference for this status.'],
  Orgtr: ['Originator of the status', 'The party that gave the status or reason.'],
  Ntfctn: ['Notification', 'One notification of entries on an account.'],
  Pty: ['Party', 'A party to the transaction.'],
  Agt: ['Agent', 'A bank in the transaction.'],
  TxInf: ['Transaction information', 'One returned payment and why.'],
  RtrdInstdAmt: ['Returned instructed amount', 'The instructed amount that is returned.'],
  TtlRtrdIntrBkSttlmAmt: ['Total returned settlement amount', 'The total of the returned interbank settlement amounts.'],
  OrgnlIntrBkSttlmDt: ['Original settlement date', 'The settlement date of the original payment.'],
  NtfctnGnlInf: ['Notification general information', 'References and status of the corporate action notification.'],
  NtfctnTp: ['Notification type', 'Whether this is a new notification, a replacement, a cancellation, and so on (a code).'],
  PrcgSts: ['Processing status', 'The processing status of the event.'],
  EvtCmpltnsSts: ['Event completeness status', 'Whether the event’s information is complete (a code).'],
  CorpActnEvtId: ['Corporate action event ID', 'The sender’s identifier of the corporate action event.'],
  MndtryVlntryEvtTp: ['Mandatory or voluntary', 'Whether holders must take part or may choose.'],
  Desc: ['Description', 'A free-text description.'],
  AcctDtls: ['Account details', 'The holder account the notification is for.'],
  ForAllAccts: ['For all accounts', 'Whether the notification applies to all accounts.'],
  AnncmntDt: ['Announcement date', 'The date the event was announced.'],
  RcrdDt: ['Record date', 'The date holders must be on record to take part.'],
  ExDvddDt: ['Ex-dividend date', 'The first day the security trades without the dividend.'],
  OptnNb: ['Option number', 'The number of the option within the event.'],
  OptnTp: ['Option type', 'The type of the option (for example cash), as a code.'],
  PmtDt: ['Payment date', 'The date the payout is made.'],
  RateAndAmtDtls: ['Rate and amount details', 'The rates and amounts of the option.'],
  GrssDvddRate: ['Gross dividend rate', 'The dividend per security before tax.'],
};

export type Item = { depth: number; name: string; path: string; label: string | null; meaning: string | null; value: string | null; attrs: Record<string, string>; line: number; note?: string; known: boolean; block: boolean };
export type Fact = { label: string; value: string; path: string; line: number; note?: string };
export type Explanation = {
  ok: boolean;
  error?: string;
  /** e.g. pacs.008.001.08, from the namespace; null when it has none. */
  message: string | null;
  title: string | null;
  what: string | null;
  /** True when the Test Bench has a model for this message, so "Validate it" is meaningful. */
  checkable: boolean;
  summary: { parties: Fact[]; amounts: Fact[]; dates: Fact[]; identifiers: Fact[]; charges: Fact[] };
  items: Item[];
  /** Element names the glossary has no entry for: listed, never explained. */
  unknown: string[];
};

const CODE_MEANING: Record<string, Record<string, string>> = {
  ChrgBr: { DEBT: 'the sender pays all charges', CRED: 'the receiver pays all charges', SHAR: 'each side pays its own bank’s charges', SLEV: 'charges follow the scheme’s rules' },
  CdtDbtInd: { CRDT: 'money in (credit)', DBIT: 'money out (debit)' },
  SttlmMtd: { INDA: 'settled via an account the instructed agent holds', INGA: 'settled via an account the instructing agent holds', CLRG: 'settled through a clearing system', COVE: 'settled by a separate cover payment' },
  TxSts: { ACSP: 'accepted, settlement in process', ACSC: 'settlement completed', ACCC: 'accepted, credited to the creditor', ACTC: 'accepted, technically valid', ACCP: 'accepted, customer profile checked', PDNG: 'pending', RJCT: 'rejected', ACWC: 'accepted with change' },
  GrpSts: { ACSP: 'accepted, settlement in process', ACSC: 'settlement completed', ACTC: 'accepted, technically valid', PDNG: 'pending', RJCT: 'rejected', PART: 'partially accepted' },
  PmtMtd: { TRF: 'credit transfer', CHK: 'cheque', TRA: 'transfer advice' },
  Cd: {}, // context-dependent: handled by parent below
};
const STATUS_CODES: Record<string, string> = { BOOK: 'booked', PDNG: 'pending', INFO: 'information only' };
const BAL_CODES: Record<string, string> = { OPBD: 'opening booked balance', CLBD: 'closing booked balance', CLAV: 'closing available balance', ITBD: 'interim booked balance', OPAV: 'opening available balance', ITAV: 'interim available balance', FWAV: 'forward available balance', PRCD: 'previously closed booked balance' };

const PARTIES = new Set(['Dbtr', 'Cdtr', 'UltmtDbtr', 'UltmtCdtr', 'InitgPty', 'DbtrAgt', 'CdtrAgt', 'InstgAgt', 'InstdAgt', 'IntrmyAgt1', 'IntrmyAgt2']);
const ID_CHECKS: Record<string, (s: string) => { valid: boolean; message: string }> = { IBAN: checkIban, BICFI: checkBic, AnyBIC: checkBic, LEI: checkLei };
const IDS = new Set(['MsgId', 'InstrId', 'EndToEndId', 'TxId', 'UETR', 'IBAN', 'BICFI', 'AnyBIC', 'LEI', 'NtryRef', 'AcctSvcrRef', 'PmtInfId', 'ISIN', 'OrgnlMsgId', 'OrgnlEndToEndId', 'OrgnlTxId', 'OrgnlUETR', 'OrgnlInstrId', 'ClrSysRef', 'RtrId', 'OffclCorpActnEvtId']);

const fmtAmount = (v: string, ccy: string) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return `${ccy} ${v}`;
  const dp = minorUnits(ccy) ?? 2;
  return `${ccy} ${n.toLocaleString('en', { minimumFractionDigits: dp, maximumFractionDigits: Math.max(dp, 5) })}`;
};

/** Parse a message and explain it block by block. Never throws. */
export function explain(xml: string): Explanation {
  const empty = { parties: [], amounts: [], dates: [], identifiers: [], charges: [] };
  const fail = (error: string): Explanation => ({ ok: false, error, message: null, title: null, what: null, checkable: false, summary: empty, items: [], unknown: [] });
  if (!xml.trim()) return fail('Paste an ISO 20022 message first.');
  if (xml.length > MAX_EXPLAIN) return fail(`The message is over ${MAX_EXPLAIN.toLocaleString('en')} characters.`);
  let doc: XmlElement;
  try {
    doc = parseXml(xml);
  } catch (e) {
    return fail(e instanceof XmlError ? `Not well-formed XML, line ${e.line}: ${e.message}` : 'Not well-formed XML.');
  }
  const message = doc.ns.startsWith(NS_PREFIX) ? doc.ns.slice(NS_PREFIX.length) : null;
  const info = MESSAGES.find((m) => m.id === message) ?? null;
  const items: Item[] = [];
  const unknown = new Set<string>();
  const summary = { parties: [] as Fact[], amounts: [] as Fact[], dates: [] as Fact[], identifiers: [] as Fact[], charges: [] as Fact[] };

  const walk = (el: XmlElement, depth: number, path: string, parents: string[]) => {
    const here = `${path}/${el.name}`;
    const g = GLOSSARY[el.name];
    const block = el.children.length > 0;
    const value = block ? null : el.text.trim();
    let note: string | undefined;
    let label = g?.[0] ?? null;
    let meaning = g?.[1] ?? null;
    if (el.name === 'Cd' && parents.length) {
      const p = parents[parents.length - 1];
      const v = value ?? '';
      if (p === 'CdOrPrtry' && BAL_CODES[v]) note = BAL_CODES[v];
      else if (p === 'Sts' && STATUS_CODES[v]) note = STATUS_CODES[v];
    } else if (value && CODE_MEANING[el.name]?.[value]) note = CODE_MEANING[el.name][value];
    if (!g) unknown.add(el.name);
    if (value && ID_CHECKS[el.name]) {
      const c = ID_CHECKS[el.name](value);
      note = c.valid ? 'check digits / structure valid' : c.message;
    }
    if (value && el.name === 'Ccy') { const c = checkCurrency(value); if (!c.valid) note = c.message; }
    if (value && el.name === 'Ctry') { const c = checkCountry(value); if (!c.valid) note = c.message; }
    items.push({ depth, name: el.name, path: here, label, meaning, value: value || null, attrs: el.attrs, line: el.line, note, known: !!g, block });

    const fact = (label2: string, v: string, n?: string): Fact => ({ label: label2, value: v, path: here, line: el.line, note: n });
    if (el.attrs.Ccy && value) summary.amounts.push(fact(`${label ?? el.name}`, fmtAmount(value, el.attrs.Ccy), note));
    else if (el.name === 'Ccy' && value && parents.includes('Acct')) summary.amounts.push(fact('Account currency', value, note));
    if (value && /Dt(Tm)?$/.test(el.name)) {
      const up = [...parents].reverse().find((n) => n !== 'Dt' && n !== 'DtTm');
      summary.dates.push(fact(el.name === 'Dt' || el.name === 'DtTm' ? (up && GLOSSARY[up]?.[0]) || 'Date' : label ?? el.name, value));
    }
    if (value && IDS.has(el.name)) summary.identifiers.push(fact(label ?? el.name, value, note));
    if (value && el.name === 'ChrgBr') summary.charges.push(fact('Charge bearer', value, note));
    if (el.name === 'ChrgsInf') summary.charges.push(fact('A charge was taken', el.children.map((c) => `${c.name}=${c.text.trim() || c.children.map((x) => x.text.trim()).join('/')}`).join(', ') || 'see details'));
    if (PARTIES.has(el.name) && block) {
      const nm = el.children.find((c) => c.name === 'Nm')?.text.trim();
      const bic = findFirst(el, 'BICFI') ?? findFirst(el, 'AnyBIC');
      const who = nm || bic || 'named by identifiers inside';
      summary.parties.push(fact(label ?? el.name, nm && bic ? `${nm} (${bic})` : who));
    }
    for (const c of el.children) walk(c, depth + 1, here, [...parents, el.name]);
  };
  walk(doc, 0, '', []);
  return {
    ok: true,
    message,
    title: info?.title ?? null,
    what: info?.what ?? null,
    checkable: !!info,
    summary,
    items,
    unknown: [...unknown],
  };
}

function findFirst(el: XmlElement, name: string): string | null {
  for (const c of el.children) {
    if (c.name === name && c.text.trim()) return c.text.trim();
    const r = findFirst(c, name);
    if (r) return r;
  }
  return null;
}
