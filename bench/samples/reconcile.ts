// The reconciliation demo: a day's camt.053 statement for a made-up company's EUR account, and
// the open items it expected that day, built so each kind of outcome appears once: matched by
// EndToEndId, by remittance text, one receipt for two invoices, matched on amount alone, a short
// payment, a bank fee nobody expected and an invoice still unpaid. The statement passes the
// Test Bench (tests/reconcile.test.ts). Served by the page's "Load the sample" and by the MCP
// tool reconcile_statement when called with sample: true. Everyone in it is made up.

const entry = (ref: string, amount: string, dir: 'CRDT' | 'DBIT', domain: string, family: string, sub: string, details = '', extra = '') => `      <Ntry>
        <NtryRef>${ref}</NtryRef>
        <Amt Ccy="EUR">${amount}</Amt>
        <CdtDbtInd>${dir}</CdtDbtInd>
        <Sts>
          <Cd>BOOK</Cd>
        </Sts>
        <BookgDt>
          <Dt>2026-10-27</Dt>
        </BookgDt>
        <ValDt>
          <Dt>2026-10-27</Dt>
        </ValDt>
        <BkTxCd>
          <Domn>
            <Cd>${domain}</Cd>
            <Fmly>
              <Cd>${family}</Cd>
              <SubFmlyCd>${sub}</SubFmlyCd>
            </Fmly>
          </Domn>
        </BkTxCd>
${details}${extra}      </Ntry>
`;

const tx = (refs: string, party: string | null, side: 'Dbtr' | 'Cdtr', ustrd?: string) => `        <NtryDtls>
          <TxDtls>
            <Refs>
${refs}            </Refs>
${party ? `            <RltdPties>
              <${side}>
                <Pty>
                  <Nm>${party}</Nm>
                </Pty>
              </${side}>
            </RltdPties>
` : ''}${ustrd ? `            <RmtInf>
              <Ustrd>${ustrd}</Ustrd>
            </RmtInf>
` : ''}          </TxDtls>
        </NtryDtls>
`;

const e2e = (id: string) => `              <EndToEndId>${id}</EndToEndId>\n`;
const none = e2e('NOTPROVIDED');

export const RECONCILE_STATEMENT = `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08">
  <BkToCstmrStmt>
    <GrpHdr>
      <MsgId>BENCH-RECON-20261027</MsgId>
      <CreDtTm>2026-10-27T23:15:00Z</CreDtTm>
    </GrpHdr>
    <Stmt>
      <Id>STMT-20261027-RECON</Id>
      <ElctrncSeqNb>306</ElctrncSeqNb>
      <CreDtTm>2026-10-27T23:15:00Z</CreDtTm>
      <Acct>
        <Id>
          <IBAN>DE89370400440532013000</IBAN>
        </Id>
        <Ccy>EUR</Ccy>
      </Acct>
      <Bal>
        <Tp>
          <CdOrPrtry>
            <Cd>OPBD</Cd>
          </CdOrPrtry>
        </Tp>
        <Amt Ccy="EUR">10000.00</Amt>
        <CdtDbtInd>CRDT</CdtDbtInd>
        <Dt>
          <Dt>2026-10-27</Dt>
        </Dt>
      </Bal>
      <Bal>
        <Tp>
          <CdOrPrtry>
            <Cd>CLBD</Cd>
          </CdOrPrtry>
        </Tp>
        <Amt Ccy="EUR">50745.00</Amt>
        <CdtDbtInd>CRDT</CdtDbtInd>
        <Dt>
          <Dt>2026-10-27</Dt>
        </Dt>
      </Bal>
      <TxsSummry>
        <TtlNtries>
          <NbOfNtries>7</NbOfNtries>
          <Sum>50115.00</Sum>
          <TtlNetNtry>
            <Amt>40745.00</Amt>
            <CdtDbtInd>CRDT</CdtDbtInd>
          </TtlNetNtry>
        </TtlNtries>
        <TtlCdtNtries>
          <NbOfNtries>4</NbOfNtries>
          <Sum>45430.00</Sum>
        </TtlCdtNtries>
        <TtlDbtNtries>
          <NbOfNtries>3</NbOfNtries>
          <Sum>4685.00</Sum>
        </TtlDbtNtries>
      </TxsSummry>
${entry('E-0001', '25000.00', 'CRDT', 'PMNT', 'RCDT', 'XBCT', tx(e2e('INV-2026-1187'), 'Northwind Trading GmbH', 'Dbtr'))}${entry('E-0002', '4180.00', 'CRDT', 'PMNT', 'RCDT', 'ESCT', tx(none, 'Bluefin Logistics BV', 'Dbtr', 'Payment invoice INV-2026-1192 thank you'))}${entry('E-0003', '9950.00', 'CRDT', 'PMNT', 'RCDT', 'XBCT', tx(e2e('INV-2026-1195'), 'Kestrel Foods SA', 'Dbtr'))}${entry('E-0004', '6300.00', 'CRDT', 'PMNT', 'RCDT', 'ESCT', tx(none, 'Orion Retail Ltd', 'Dbtr', 'INV-2026-1203 + INV-2026-1204'))}${entry('E-0005', '1250.00', 'DBIT', 'PMNT', 'ICDT', 'ESCT', tx(e2e('PO-7781'), 'Atlas Office Supply', 'Cdtr'))}${entry('E-0006', '3400.00', 'DBIT', 'PMNT', 'ICDT', 'ESCT', tx(none, 'Harbor Freight Lines', 'Cdtr'))}${entry('E-0007', '35.00', 'DBIT', 'ACMT', 'MDOP', 'CHRG', '', '        <AddtlNtryInf>Account maintenance fee, October</AddtlNtryInf>\n')}    </Stmt>
  </BkToCstmrStmt>
</Document>
`;

/** What the company expected that day: its open receivables and its payment run, as a CSV export. */
export const RECONCILE_EXPECTED = `reference,amount,currency,direction,date,counterparty
INV-2026-1187,25000.00,EUR,credit,2026-10-27,Northwind Trading GmbH
INV-2026-1192,4180.00,EUR,credit,2026-10-26,Bluefin Logistics BV
INV-2026-1195,10000.00,EUR,credit,2026-10-27,Kestrel Foods SA
INV-2026-1203,2800.00,EUR,credit,2026-10-27,Orion Retail Ltd
INV-2026-1204,3500.00,EUR,credit,2026-10-27,Orion Retail Ltd
INV-2026-1201,7500.00,EUR,credit,2026-10-27,Meridian Health Group
PO-7781,1250.00,EUR,debit,2026-10-27,Atlas Office Supply
PO-7790,3400.00,EUR,debit,2026-10-26,Harbor Freight Lines
`;
