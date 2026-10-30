// Each event as an ISO 20022 corporate action notification, seev.031.001.14: the message
// custodians send account holders. tests/corpactions.test.ts checks every event in the feed
// with the Test Bench (schema and business rules), so what this writes is always valid.
//
// The security is identified without an ISIN (US ISINs are built on licensed CUSIPs): by its
// FIGI and ticker as OthrId with proprietary types "FIGI" and "TICKER", and its name in Desc.

import { EVENT_CODES, type CorporateAction } from './types.ts';

/** The security as the event names it: the common stock, or (6-K issuers) the shares or ADSs that trade in the US. */
const securityName = (e: CorporateAction) =>
  e.instrument === 'ADS' ? `${e.company.name} American depositary shares` : /^6-K/.test(e.source.form) ? `${e.company.name} shares` : `${e.company.name} common stock`;

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const max = (s: string, n: number) => (s.length > n ? s.slice(0, n - 3) + '...' : s);

/** At most 35 characters, as CorpActnEvtId allows: DVCA0000049196-20270104, plus S for a special dividend. */
export const eventRef = (e: CorporateAction) =>
  `${EVENT_CODES[e.type]}${e.company.cik}-${(e.id.match(/(\d{4}-\d{2}-\d{2})/)?.[1] ?? e.dates.announced).replace(/-/g, '')}${e.id.endsWith('-special') ? 'S' : ''}`;

function security(e: CorporateAction, pad: string): string {
  const ids = [
    e.company.figi ? `${pad}  <OthrId>\n${pad}    <Id>${esc(e.company.figi)}</Id>\n${pad}    <Tp>\n${pad}      <Prtry>FIGI</Prtry>\n${pad}    </Tp>\n${pad}  </OthrId>` : '',
    e.company.ticker ? `${pad}  <OthrId>\n${pad}    <Id>${esc(e.company.ticker)}</Id>\n${pad}    <Tp>\n${pad}      <Prtry>TICKER</Prtry>\n${pad}    </Tp>\n${pad}  </OthrId>` : '',
  ].filter(Boolean);
  return [`${pad}<FinInstrmId>`, ...ids, `${pad}  <Desc>${esc(max(securityName(e), 140))}</Desc>`, `${pad}</FinInstrmId>`].join('\n');
}

const date = (tag: string, d: string | undefined, pad: string) => (d ? `${pad}<${tag}>\n${pad}  <Dt>${d}</Dt>\n${pad}</${tag}>` : '');
const dateTime = (tag: string, d: string | undefined, pad: string) => (d ? `${pad}<${tag}>\n${pad}  <Dt>\n${pad}    <Dt>${d}</Dt>\n${pad}  </Dt>\n${pad}</${tag}>` : '');
/** A payment date, or the code UKWN when the filing doesn't give one. */
const payDate = (d: string | undefined, pad: string) =>
  d ? date('PmtDt', d, pad) : `${pad}<PmtDt>\n${pad}  <DtCd>\n${pad}    <Cd>UKWN</Cd>\n${pad}  </DtCd>\n${pad}</PmtDt>`;
const lines = (...xs: string[]) => xs.filter(Boolean).join('\n');

function option(e: CorporateAction): string {
  const p = '      ';
  const head = (tp: 'CASH' | 'SECU') => lines(`${p}<OptnNb>001</OptnNb>`, `${p}<OptnTp>`, `${p}  <Cd>${tp}</Cd>`, `${p}</OptnTp>`, `${p}<DfltPrcgOrStgInstr>`, `${p}  <DfltOptnInd>true</DfltOptnInd>`, `${p}</DfltPrcgOrStgInstr>`);
  if (e.type === 'dividend')
    return lines(
      head('CASH'),
      `${p}<CshMvmntDtls>`,
      `${p}  <CdtDbtInd>CRDT</CdtDbtInd>`,
      `${p}  <DtDtls>`,
      payDate(e.dates.pay, `${p}    `),
      `${p}  </DtDtls>`,
      `${p}  <RateAndAmtDtls>`,
      `${p}    <GrssDvddRate>`,
      `${p}      <Amt Ccy="${e.cash!.currency}">${e.cash!.amount}</Amt>`,
      `${p}    </GrssDvddRate>`,
      `${p}  </RateAndAmtDtls>`,
      `${p}</CshMvmntDtls>`,
    );
  const securities = (ratio: { new: number; old: number }, what: string) =>
    lines(
      `${p}<SctiesMvmntDtls>`,
      `${p}  <SctyDtls>`,
      `${p}    <FinInstrmId>`,
      `${p}      <Desc>${esc(max(what, 140))}</Desc>`,
      `${p}    </FinInstrmId>`,
      `${p}  </SctyDtls>`,
      `${p}  <CdtDbtInd>CRDT</CdtDbtInd>`,
      `${p}  <DtDtls>`,
      payDate(e.dates.pay ?? e.dates.effective, `${p}    `),
      `${p}  </DtDtls>`,
      `${p}  <RateDtls>`,
      `${p}    <NewToOd>`,
      `${p}      <QtyToQty>`,
      `${p}        <Qty1>${ratio.new}</Qty1>`,
      `${p}        <Qty2>${ratio.old}</Qty2>`,
      `${p}      </QtyToQty>`,
      `${p}    </NewToOd>`,
      `${p}  </RateDtls>`,
      `${p}</SctiesMvmntDtls>`,
    );
  if (e.type === 'split' || e.type === 'reverse-split') return lines(head('SECU'), securities(e.ratio!, `${securityName(e)}, after the split`));
  // A merger: cash per share, shares of the acquirer per share, or both.
  const cash = e.cash
    ? lines(
        `${p}<CshMvmntDtls>`,
        `${p}  <CdtDbtInd>CRDT</CdtDbtInd>`,
        `${p}  <DtDtls>`,
        payDate(e.dates.pay, `${p}    `),
        `${p}  </DtDtls>`,
        `${p}  <PricDtls>`,
        `${p}    <GncCshPricRcvdPerPdct>`,
        `${p}      <AmtPric>`,
        `${p}        <AmtPricTp>ACTU</AmtPricTp>`,
        `${p}        <PricVal Ccy="${e.cash.currency}">${e.cash.amount}</PricVal>`,
        `${p}      </AmtPric>`,
        `${p}    </GncCshPricRcvdPerPdct>`,
        `${p}  </PricDtls>`,
        `${p}</CshMvmntDtls>`,
      )
    : '';
  const stock = e.ratio ? securities(e.ratio, `${e.acquirer ?? 'The acquirer'} shares`) : '';
  return lines(head(e.ratio ? 'SECU' : 'CASH'), stock, cash);
}

/** The event as a seev.031.001.14 notification. */
export function toSeev031(e: CorporateAction): string {
  const p = '      ';
  const dts = lines(
    dateTime('AnncmntDt', e.dates.announced, p),
    date('FctvDt', e.dates.effective, p),
    date('RcrdDt', e.dates.record, p),
    e.type === 'dividend' ? date('ExDvddDt', e.dates.ex, p) : '',
  );
  return `<?xml version="1.0" encoding="UTF-8"?>
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
      <CorpActnEvtId>${eventRef(e)}</CorpActnEvtId>
      <EvtTp>
        <Cd>${EVENT_CODES[e.type]}</Cd>
      </EvtTp>
      <MndtryVlntryEvtTp>
        <Cd>MAND</Cd>
      </MndtryVlntryEvtTp>
      <UndrlygScty>
${security(e, '        ')}
      </UndrlygScty>
    </CorpActnGnlInf>
    <AcctDtls>
      <ForAllAccts>
        <IdCd>GENR</IdCd>
      </ForAllAccts>
    </AcctDtls>
    <CorpActnDtls>
      <DtDtls>
${dts}
      </DtDtls>
    </CorpActnDtls>
    <CorpActnOptnDtls>
${option(e)}
    </CorpActnOptnDtls>
  </CorpActnNtfctn>
</Document>
`;
}
