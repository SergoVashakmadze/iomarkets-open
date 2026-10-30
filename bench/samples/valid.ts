// One valid sample per message. Every party, account and security here is made up
// (Example Corp and its ISIN US9999SMPL04 don't exist), but every identifier carries
// correct check digits; the IBANs are the published ISO 13616 examples. Dates are
// 27 October 2026; the tests pass a "now" of 28 October.

export const PACS_008 = `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pacs.008.001.08">
  <FIToFICstmrCdtTrf>
    <GrpHdr>
      <MsgId>BENCH-PACS008-0001</MsgId>
      <CreDtTm>2026-10-27T09:30:00Z</CreDtTm>
      <NbOfTxs>1</NbOfTxs>
      <SttlmInf>
        <SttlmMtd>INDA</SttlmMtd>
      </SttlmInf>
    </GrpHdr>
    <CdtTrfTxInf>
      <PmtId>
        <InstrId>BENCH-INSTR-0001</InstrId>
        <EndToEndId>INV-2026-1187</EndToEndId>
        <TxId>BENCH-TX-0001</TxId>
        <UETR>8a562c67-ca16-48ba-b074-65581be6f001</UETR>
      </PmtId>
      <IntrBkSttlmAmt Ccy="EUR">25000.00</IntrBkSttlmAmt>
      <IntrBkSttlmDt>2026-10-27</IntrBkSttlmDt>
      <ChrgBr>SHAR</ChrgBr>
      <InstgAgt>
        <FinInstnId>
          <BICFI>WESTGB2LXXX</BICFI>
        </FinInstnId>
      </InstgAgt>
      <InstdAgt>
        <FinInstnId>
          <BICFI>COBADEFFXXX</BICFI>
        </FinInstnId>
      </InstdAgt>
      <Dbtr>
        <Nm>Northwind Traders Ltd</Nm>
        <PstlAdr>
          <StrtNm>Lombard Street</StrtNm>
          <BldgNb>12</BldgNb>
          <PstCd>EC3V 9AA</PstCd>
          <TwnNm>London</TwnNm>
          <Ctry>GB</Ctry>
        </PstlAdr>
        <Id>
          <OrgId>
            <LEI>5299000J2N45DDNE4Y28</LEI>
          </OrgId>
        </Id>
      </Dbtr>
      <DbtrAcct>
        <Id>
          <IBAN>GB82WEST12345698765432</IBAN>
        </Id>
      </DbtrAcct>
      <DbtrAgt>
        <FinInstnId>
          <BICFI>WESTGB2LXXX</BICFI>
        </FinInstnId>
      </DbtrAgt>
      <CdtrAgt>
        <FinInstnId>
          <BICFI>COBADEFFXXX</BICFI>
        </FinInstnId>
      </CdtrAgt>
      <Cdtr>
        <Nm>Contoso Maschinenbau GmbH</Nm>
        <PstlAdr>
          <TwnNm>Frankfurt am Main</TwnNm>
          <Ctry>DE</Ctry>
        </PstlAdr>
      </Cdtr>
      <CdtrAcct>
        <Id>
          <IBAN>DE89370400440532013000</IBAN>
        </Id>
      </CdtrAcct>
      <RmtInf>
        <Ustrd>Invoice 2026-1187, order 55410</Ustrd>
      </RmtInf>
    </CdtTrfTxInf>
  </FIToFICstmrCdtTrf>
</Document>
`;

export const PACS_009 = `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pacs.009.001.08">
  <FICdtTrf>
    <GrpHdr>
      <MsgId>BENCH-PACS009-0001</MsgId>
      <CreDtTm>2026-10-27T10:05:00+01:00</CreDtTm>
      <NbOfTxs>1</NbOfTxs>
      <TtlIntrBkSttlmAmt Ccy="USD">5000000.00</TtlIntrBkSttlmAmt>
      <IntrBkSttlmDt>2026-10-27</IntrBkSttlmDt>
      <SttlmInf>
        <SttlmMtd>INDA</SttlmMtd>
      </SttlmInf>
    </GrpHdr>
    <CdtTrfTxInf>
      <PmtId>
        <InstrId>BENCH-FI-0001</InstrId>
        <EndToEndId>FX-SWAP-77812</EndToEndId>
        <UETR>3f1d2b9e-6c4a-4e1b-9d7a-2b8c5e0a9f12</UETR>
      </PmtId>
      <IntrBkSttlmAmt Ccy="USD">5000000.00</IntrBkSttlmAmt>
      <InstgAgt>
        <FinInstnId>
          <BICFI>WESTGB2LXXX</BICFI>
        </FinInstnId>
      </InstgAgt>
      <InstdAgt>
        <FinInstnId>
          <BICFI>CHASUS33XXX</BICFI>
        </FinInstnId>
      </InstdAgt>
      <Dbtr>
        <FinInstnId>
          <BICFI>WESTGB2LXXX</BICFI>
        </FinInstnId>
      </Dbtr>
      <Cdtr>
        <FinInstnId>
          <BICFI>CHASUS33XXX</BICFI>
        </FinInstnId>
      </Cdtr>
    </CdtTrfTxInf>
  </FICdtTrf>
</Document>
`;

export const PAIN_001 = `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.001.001.09">
  <CstmrCdtTrfInitn>
    <GrpHdr>
      <MsgId>BENCH-PAIN001-0001</MsgId>
      <CreDtTm>2026-10-27T08:00:00</CreDtTm>
      <NbOfTxs>2</NbOfTxs>
      <CtrlSum>4150.75</CtrlSum>
      <InitgPty>
        <Nm>Northwind Traders Ltd</Nm>
      </InitgPty>
    </GrpHdr>
    <PmtInf>
      <PmtInfId>SUPPLIERS-2026-10-27</PmtInfId>
      <PmtMtd>TRF</PmtMtd>
      <NbOfTxs>2</NbOfTxs>
      <CtrlSum>4150.75</CtrlSum>
      <ReqdExctnDt>
        <Dt>2026-10-28</Dt>
      </ReqdExctnDt>
      <Dbtr>
        <Nm>Northwind Traders Ltd</Nm>
      </Dbtr>
      <DbtrAcct>
        <Id>
          <IBAN>GB33BUKB20201555555555</IBAN>
        </Id>
      </DbtrAcct>
      <DbtrAgt>
        <FinInstnId>
          <BICFI>BUKBGB22XXX</BICFI>
        </FinInstnId>
      </DbtrAgt>
      <ChrgBr>SLEV</ChrgBr>
      <CdtTrfTxInf>
        <PmtId>
          <EndToEndId>SUP-4471</EndToEndId>
        </PmtId>
        <Amt>
          <InstdAmt Ccy="EUR">3200.00</InstdAmt>
        </Amt>
        <CdtrAgt>
          <FinInstnId>
            <BICFI>ABNANL2AXXX</BICFI>
          </FinInstnId>
        </CdtrAgt>
        <Cdtr>
          <Nm>Fabrikam BV</Nm>
        </Cdtr>
        <CdtrAcct>
          <Id>
            <IBAN>NL91ABNA0417164300</IBAN>
          </Id>
        </CdtrAcct>
        <RmtInf>
          <Ustrd>Invoice F-88213</Ustrd>
        </RmtInf>
      </CdtTrfTxInf>
      <CdtTrfTxInf>
        <PmtId>
          <EndToEndId>SUP-4472</EndToEndId>
        </PmtId>
        <Amt>
          <InstdAmt Ccy="EUR">950.75</InstdAmt>
        </Amt>
        <Cdtr>
          <Nm>Adatum SARL</Nm>
        </Cdtr>
        <CdtrAcct>
          <Id>
            <IBAN>FR1420041010050500013M02606</IBAN>
          </Id>
        </CdtrAcct>
      </CdtTrfTxInf>
    </PmtInf>
  </CstmrCdtTrfInitn>
</Document>
`;

export const CAMT_053 = `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08">
  <BkToCstmrStmt>
    <GrpHdr>
      <MsgId>BENCH-CAMT053-20261027</MsgId>
      <CreDtTm>2026-10-27T23:15:00Z</CreDtTm>
    </GrpHdr>
    <Stmt>
      <Id>STMT-20261027-001</Id>
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
        <Amt Ccy="EUR">33750.00</Amt>
        <CdtDbtInd>CRDT</CdtDbtInd>
        <Dt>
          <Dt>2026-10-27</Dt>
        </Dt>
      </Bal>
      <TxsSummry>
        <TtlNtries>
          <NbOfNtries>2</NbOfNtries>
          <Sum>26250.00</Sum>
          <TtlNetNtry>
            <Amt>23750.00</Amt>
            <CdtDbtInd>CRDT</CdtDbtInd>
          </TtlNetNtry>
        </TtlNtries>
        <TtlCdtNtries>
          <NbOfNtries>1</NbOfNtries>
          <Sum>25000.00</Sum>
        </TtlCdtNtries>
        <TtlDbtNtries>
          <NbOfNtries>1</NbOfNtries>
          <Sum>1250.00</Sum>
        </TtlDbtNtries>
      </TxsSummry>
      <Ntry>
        <NtryRef>E-0001</NtryRef>
        <Amt Ccy="EUR">25000.00</Amt>
        <CdtDbtInd>CRDT</CdtDbtInd>
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
            <Cd>PMNT</Cd>
            <Fmly>
              <Cd>RCDT</Cd>
              <SubFmlyCd>XBCT</SubFmlyCd>
            </Fmly>
          </Domn>
        </BkTxCd>
        <NtryDtls>
          <TxDtls>
            <Refs>
              <EndToEndId>INV-2026-1187</EndToEndId>
              <UETR>8a562c67-ca16-48ba-b074-65581be6f001</UETR>
            </Refs>
          </TxDtls>
        </NtryDtls>
      </Ntry>
      <Ntry>
        <NtryRef>E-0002</NtryRef>
        <Amt Ccy="EUR">1250.00</Amt>
        <CdtDbtInd>DBIT</CdtDbtInd>
        <Sts>
          <Cd>BOOK</Cd>
        </Sts>
        <BookgDt>
          <Dt>2026-10-27</Dt>
        </BookgDt>
        <BkTxCd>
          <Domn>
            <Cd>PMNT</Cd>
            <Fmly>
              <Cd>ICDT</Cd>
              <SubFmlyCd>ESCT</SubFmlyCd>
            </Fmly>
          </Domn>
        </BkTxCd>
      </Ntry>
    </Stmt>
  </BkToCstmrStmt>
</Document>
`;

export const SEEV_031 = `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:seev.031.001.14">
  <CorpActnNtfctn>
    <NtfctnGnlInf>
      <NtfctnTp>NEWM</NtfctnTp>
      <PrcgSts>
        <Cd>
          <EvtCmpltnsSts>COMP</EvtCmpltnsSts>
          <EvtConfSts>CONF</EvtConfSts>
        </Cd>
      </PrcgSts>
    </NtfctnGnlInf>
    <CorpActnGnlInf>
      <CorpActnEvtId>DVCA-EXMPL-2026Q4</CorpActnEvtId>
      <EvtTp>
        <Cd>DVCA</Cd>
      </EvtTp>
      <MndtryVlntryEvtTp>
        <Cd>MAND</Cd>
      </MndtryVlntryEvtTp>
      <UndrlygScty>
        <FinInstrmId>
          <ISIN>US9999SMPL04</ISIN>
          <Desc>Example Corp common stock</Desc>
        </FinInstrmId>
      </UndrlygScty>
    </CorpActnGnlInf>
    <AcctDtls>
      <ForAllAccts>
        <IdCd>GENR</IdCd>
      </ForAllAccts>
    </AcctDtls>
    <CorpActnDtls>
      <DtDtls>
        <AnncmntDt>
          <Dt>
            <Dt>2026-10-20</Dt>
          </Dt>
        </AnncmntDt>
        <RcrdDt>
          <Dt>2026-11-13</Dt>
        </RcrdDt>
        <ExDvddDt>
          <Dt>2026-11-13</Dt>
        </ExDvddDt>
      </DtDtls>
    </CorpActnDtls>
    <CorpActnOptnDtls>
      <OptnNb>001</OptnNb>
      <OptnTp>
        <Cd>CASH</Cd>
      </OptnTp>
      <DfltPrcgOrStgInstr>
        <DfltOptnInd>true</DfltOptnInd>
      </DfltPrcgOrStgInstr>
      <CshMvmntDtls>
        <CdtDbtInd>CRDT</CdtDbtInd>
        <DtDtls>
          <PmtDt>
            <Dt>2026-11-20</Dt>
          </PmtDt>
        </DtDtls>
        <RateAndAmtDtls>
          <GrssDvddRate>
            <Amt Ccy="USD">0.26</Amt>
          </GrssDvddRate>
        </RateAndAmtDtls>
      </CshMvmntDtls>
    </CorpActnOptnDtls>
  </CorpActnNtfctn>
</Document>
`;
