// The sample library: a valid message for each type and broken ones, each made by one
// small change to a valid sample, with the issue code it must raise. Anyone can use
// them in their own tests: they are written out as files to bench/samples/xml/ by
// bench/scripts/write-samples.ts, served on the page, and returned by the MCP tool
// get_sample. tests/bench-samples.test.ts checks every sample gives its expected codes,
// and that libxml2 agrees with the bench on which ones are schema-valid.

import { CAMT_053, CAMT_054, PACS_002, PACS_004, PACS_008, PACS_009, PAIN_001, SEEV_031 } from './valid.ts';

export type Sample = {
  /** File name without .xml, e.g. pacs.008-iban-checksum. */
  id: string;
  message: string;
  title: string;
  /** True for a valid message (warnings allowed). */
  valid: boolean;
  /** Issue codes the bench must report. */
  expect: string[];
  xml: string;
};

/** Apply text replacements; throws if one doesn't apply, so a sample can't silently stop being broken. */
function mutate(xml: string, ...edits: [string, string][]): string {
  for (const [from, to] of edits) {
    if (!xml.includes(from)) throw new Error(`sample edit not found: ${from}`);
    xml = xml.replace(from, to);
  }
  return xml;
}

const P8 = 'pacs.008.001.08', P9 = 'pacs.009.001.08', P2 = 'pacs.002.001.10', P4 = 'pacs.004.001.09', PN = 'pain.001.001.09', C53 = 'camt.053.001.08', C54 = 'camt.054.001.08', S31 = 'seev.031.001.14';

const ok = (id: string, message: string, title: string, xml: string): Sample => ({ id, message, title, valid: true, expect: [], xml });
const bad = (id: string, message: string, title: string, expect: string[], xml: string): Sample => ({ id, message, title, valid: false, expect, xml });

export const SAMPLES: Sample[] = [
  ok('pacs.008-valid', P8, 'A customer payment from London to Frankfurt, EUR 25,000', PACS_008),
  ok('pacs.009-valid', P9, 'A bank-to-bank payment of USD 5 million', PACS_009),
  ok('pacs.002-valid', P2, 'The London to Frankfurt payment rejected: account closed (AC04)', PACS_002),
  ok('pacs.004-valid', P4, 'The London to Frankfurt payment returned, less EUR 10 charges', PACS_004),
  ok('pain.001-valid', PN, 'A batch of two supplier payments', PAIN_001),
  ok('camt.053-valid', C53, 'An end-of-day statement with one credit and one debit', CAMT_053),
  ok('camt.054-valid', C54, 'A notification of two credits as they arrive', CAMT_054),
  ok('seev.031-valid', S31, 'A cash dividend of USD 0.26 a share', SEEV_031),
  {
    ...ok('pacs.008-in-envelope', P8, 'The payment inside a business message envelope with its AppHdr', `<?xml version="1.0" encoding="UTF-8"?>
<BizMsgEnvlp>
  <AppHdr xmlns="urn:iso:std:iso:20022:tech:xsd:head.001.001.02">
    <BizMsgIdr>BENCH-PACS008-0001</BizMsgIdr>
    <MsgDefIdr>pacs.008.001.08</MsgDefIdr>
    <CreDt>2026-10-27T09:30:00Z</CreDt>
  </AppHdr>
${PACS_008.replace(/^<\?xml[^>]*>\n/, '')}</BizMsgEnvlp>
`),
    expect: ['ENVELOPE'],
  },

  // Schema failures.
  bad('pacs.008-missing-charge-bearer', P8, 'ChrgBr (who pays the charges) left out', ['MISSING_ELEMENT'], mutate(PACS_008, ['      <ChrgBr>SHAR</ChrgBr>\n', ''])),
  bad('pacs.008-msgid-too-long', P8, 'A message id longer than 35 characters', ['TOO_LONG'], mutate(PACS_008, ['BENCH-PACS008-0001', 'BENCH-PACS008-0001-RETRY-2026-10-27-AM'])),
  bad('pacs.008-lowercase-currency', P8, 'A currency written in lower case', ['PATTERN'], mutate(PACS_008, ['Ccy="EUR"', 'Ccy="eur"'])),
  bad('pacs.008-out-of-order', P8, 'The settlement date written before the amount', ['OUT_OF_ORDER'], mutate(PACS_008,
    ['      <IntrBkSttlmAmt Ccy="EUR">25000.00</IntrBkSttlmAmt>\n      <IntrBkSttlmDt>2026-10-27</IntrBkSttlmDt>', '      <IntrBkSttlmDt>2026-10-27</IntrBkSttlmDt>\n      <IntrBkSttlmAmt Ccy="EUR">25000.00</IntrBkSttlmAmt>'])),
  bad('pacs.008-impossible-date', P8, 'A settlement date of 30 February', ['NOT_DATE'], mutate(PACS_008, ['<IntrBkSttlmDt>2026-10-27', '<IntrBkSttlmDt>2026-02-30'])),
  bad('pacs.008-unknown-element', P8, 'An element the schema does not have', ['UNEXPECTED_ELEMENT'], mutate(PACS_008, ['      <ChrgBr>SHAR</ChrgBr>', '      <ChrgBr>SHAR</ChrgBr>\n      <Priority>HIGH</Priority>'])),
  bad('pacs.008-bad-uetr', P8, 'A UETR that is not a version 4 UUID', ['PATTERN'], mutate(PACS_008, ['8a562c67-ca16-48ba-b074-65581be6f001', '8A562C67-CA16-18BA-B074-65581BE6F001'])),
  bad('pacs.008-unclosed-tag', P8, 'Not well-formed XML: a tag never closed', ['NOT_XML'], mutate(PACS_008, ['</Ustrd>', ''])),

  // Business rules.
  bad('pacs.008-iban-checksum', P8, 'An IBAN with one digit mistyped', ['IBAN_CHECKSUM'], mutate(PACS_008, ['DE89370400440532013000', 'DE89370400440532013001'])),
  bad('pacs.008-bic-country', P8, 'A BIC whose country letters are not a country', ['BIC_COUNTRY'], mutate(PACS_008, ['<BICFI>COBADEFFXXX</BICFI>', '<BICFI>COBAQQFFXXX</BICFI>'])),
  bad('pacs.008-lei-checksum', P8, 'An LEI with wrong check digits', ['LEI_CHECKSUM'], mutate(PACS_008, ['5299000J2N45DDNE4Y28', '5299000J2N45DDNE4Y29'])),
  bad('pacs.008-count-mismatch', P8, 'NbOfTxs says 2 but there is one transaction', ['NB_OF_TXS'], mutate(PACS_008, ['<NbOfTxs>1</NbOfTxs>', '<NbOfTxs>2</NbOfTxs>'])),
  bad('pacs.008-no-settlement-date', P8, 'No interbank settlement date anywhere', ['SETTLEMENT_DATE_MISSING'], mutate(PACS_008, ['      <IntrBkSttlmDt>2026-10-27</IntrBkSttlmDt>\n', ''])),
  bad('pacs.008-yen-decimals', P8, 'A yen amount with sen (JPY has no minor unit)', ['AMOUNT_DECIMALS'], mutate(PACS_008, ['<IntrBkSttlmAmt Ccy="EUR">25000.00', '<IntrBkSttlmAmt Ccy="JPY">25000.50'])),
  bad('pacs.008-fx-without-rate', P8, 'Instructed in GBP, settled in EUR, no exchange rate', ['EXCHANGE_RATE_MISSING'], mutate(PACS_008, ['      <ChrgBr>SHAR</ChrgBr>', '      <InstdAmt Ccy="GBP">21500.00</InstdAmt>\n      <ChrgBr>SHAR</ChrgBr>'])),
  bad('pacs.009-total-mismatch', P9, 'The total does not match the transaction', ['TOTAL_AMOUNT'], mutate(PACS_009, ['<TtlIntrBkSttlmAmt Ccy="USD">5000000.00', '<TtlIntrBkSttlmAmt Ccy="USD">4000000.00'])),
  bad('pacs.009-cover-without-reimbursement', P9, 'A cover payment with no reimbursement agent', ['SETTLEMENT_METHOD'], mutate(PACS_009, ['<SttlmMtd>INDA</SttlmMtd>', '<SttlmMtd>COVE</SttlmMtd>'])),
  bad('pain.001-control-sum', PN, 'The control sum is 5 cents out', ['CTRL_SUM'], mutate(PAIN_001, ['<CtrlSum>4150.75</CtrlSum>', '<CtrlSum>4150.70</CtrlSum>'])),
  bad('pain.001-cheque-with-account', PN, 'A cheque payment that names a creditor account', ['CHEQUE_ACCOUNT'], mutate(PAIN_001, ['<PmtMtd>TRF</PmtMtd>', '<PmtMtd>CHK</PmtMtd>'])),
  bad('camt.053-balance-mismatch', C53, 'The closing balance does not follow from the entries', ['BALANCE_MISMATCH'], mutate(CAMT_053, ['<Amt Ccy="EUR">33750.00</Amt>', '<Amt Ccy="EUR">33700.00</Amt>'])),
  bad('camt.053-entry-count', C53, 'The summary counts three entries; there are two', ['ENTRY_COUNT'], mutate(CAMT_053, ['<NbOfNtries>2</NbOfNtries>', '<NbOfNtries>3</NbOfNtries>'])),
  bad('seev.031-isin-check-digit', S31, 'An ISIN with the wrong check digit', ['ISIN_CHECK_DIGIT'], mutate(SEEV_031, ['US9999SMPL04', 'US9999SMPL05'])),
  bad('seev.031-paid-before-record-date', S31, 'Paid before the record date', ['DATE_ORDER'], mutate(SEEV_031, ['<Dt>2026-11-20</Dt>', '<Dt>2026-11-10</Dt>'])),
  bad('seev.031-two-statuses', S31, 'A processing status given both as a code and as a proprietary value', ['CHOICE_MANY'], mutate(SEEV_031, ['        </Cd>\n      </PrcgSts>', '        </Cd>\n        <Prtry>\n          <Id>DRAFT</Id>\n          <Issr>BENCH</Issr>\n        </Prtry>\n      </PrcgSts>'])),
  bad('seev.031-dividend-without-cash', S31, 'A cash dividend whose only option is securities', ['CASH_OPTION_MISSING'], mutate(SEEV_031, ['<Cd>CASH</Cd>', '<Cd>SECU</Cd>'])),
  bad('pacs.002-status-too-long', P2, 'A status written out as a word instead of its four-letter code', ['TOO_LONG'], mutate(PACS_002, ['<TxSts>RJCT</TxSts>', '<TxSts>REJECTED</TxSts>'])),
  bad('pacs.002-accepted-but-rejected', P2, 'The group is accepted, but its only transaction is rejected', ['GROUP_STATUS'], mutate(PACS_002, ['<GrpSts>RJCT</GrpSts>', '<GrpSts>ACSP</GrpSts>'])),
  bad('pacs.002-narrative-without-text', P2, 'Reason NARR (narrative) with no narrative', ['NARRATIVE_MISSING'], mutate(PACS_002, ['<Cd>AC04</Cd>\n        </Rsn>\n        <AddtlInf>Creditor account closed on 2026-09-30</AddtlInf>', '<Cd>NARR</Cd>\n        </Rsn>'])),
  bad('pacs.002-original-group-twice', P2, 'A transaction repeats the original message the report already names', ['ORIGINAL_GROUP_REFERENCE'], mutate(PACS_002, ['      <StsId>BENCH-STS-0001</StsId>\n', '      <StsId>BENCH-STS-0001</StsId>\n      <OrgnlGrpInf>\n        <OrgnlMsgId>BENCH-PACS008-0001</OrgnlMsgId>\n        <OrgnlMsgNmId>pacs.008.001.08</OrgnlMsgNmId>\n      </OrgnlGrpInf>\n'])),
  bad('pacs.004-missing-returned-amount', P4, 'The returned settlement amount left out', ['MISSING_ELEMENT'], mutate(PACS_004, ['      <RtrdIntrBkSttlmAmt Ccy="EUR">24990.00</RtrdIntrBkSttlmAmt>\n', ''])),
  bad('pacs.004-total-mismatch', P4, 'The total returned is the original amount, not what was sent back', ['TOTAL_AMOUNT'], mutate(PACS_004, ['<TtlRtrdIntrBkSttlmAmt Ccy="EUR">24990.00', '<TtlRtrdIntrBkSttlmAmt Ccy="EUR">25000.00'])),
  bad('pacs.004-charges-without-instructed-amount', P4, 'Charges taken, but no amount before charges', ['CHARGES_WITHOUT_INSTRUCTED_AMOUNT'], mutate(PACS_004, ['      <RtrdInstdAmt Ccy="EUR">25000.00</RtrdInstdAmt>\n', ''])),
  bad('pacs.004-group-return-with-transactions', P4, 'The whole message returned, yet a transaction listed', ['GROUP_RETURN'], mutate(PACS_004, ['      <NbOfTxs>1</NbOfTxs>\n', '      <NbOfTxs>1</NbOfTxs>\n      <GrpRtr>true</GrpRtr>\n'])),
  bad('pacs.004-fx-without-rate', P4, 'Returned in GBP before charges, settled in EUR, no exchange rate', ['EXCHANGE_RATE_MISSING'], mutate(PACS_004, ['<RtrdInstdAmt Ccy="EUR">25000.00', '<RtrdInstdAmt Ccy="GBP">21500.00'])),
  bad('camt.054-credit-spelled-out', C54, 'Credit written out instead of CRDT', ['NOT_IN_LIST'], mutate(CAMT_054, ['<CdtDbtInd>CRDT</CdtDbtInd>\n        <Sts>', '<CdtDbtInd>Credit</CdtDbtInd>\n        <Sts>'])),
  bad('camt.054-entry-sum', C54, 'The summary total is 50 cents short', ['ENTRY_SUM'], mutate(CAMT_054, ['<Sum>26800.50</Sum>\n          <TtlNetNtry>', '<Sum>26800.00</Sum>\n          <TtlNetNtry>'])),
  bad('camt.054-two-paginations', C54, 'Paginated both as a message and as a notification', ['PAGINATION_TWICE'], mutate(CAMT_054,
    ['      <CreDtTm>2026-10-27T10:05:00Z</CreDtTm>\n    </GrpHdr>', '      <CreDtTm>2026-10-27T10:05:00Z</CreDtTm>\n      <MsgPgntn>\n        <PgNb>1</PgNb>\n        <LastPgInd>true</LastPgInd>\n      </MsgPgntn>\n    </GrpHdr>'],
    ['      <Id>NTF-20261027-0001</Id>\n', '      <Id>NTF-20261027-0001</Id>\n      <NtfctnPgntn>\n        <PgNb>1</PgNb>\n        <LastPgInd>true</LastPgInd>\n      </NtfctnPgntn>\n'])),
  bad('camt.054-empty-bank-code', C54, 'An entry whose bank transaction code is empty', ['BANK_TRANSACTION_CODE'], mutate(CAMT_054, ['        <BkTxCd>\n          <Domn>\n            <Cd>PMNT</Cd>\n            <Fmly>\n              <Cd>RCDT</Cd>\n              <SubFmlyCd>ESCT</SubFmlyCd>\n            </Fmly>\n          </Domn>\n        </BkTxCd>', '        <BkTxCd>\n        </BkTxCd>'])),
  bad('pacs.008-unsupported-version', 'pacs.008.001.10', 'A pacs.008 version the bench does not load yet', ['UNKNOWN_MESSAGE'], PACS_008.replace(/pacs\.008\.001\.08/g, 'pacs.008.001.10')),
];
