// The corporate action notice: an open JSON-LD format (formats/corporate-action-notice.v1.schema.json, governed at
// iomarkets.org/formats) that an issuer embeds in its own announcement or investor relations page, so AI engines and
// agents read the dates and amounts instead of guessing them from prose. Built here from a feed event, and read back
// out of a page by the AI-readiness audit (audit.ts), which checks it against the feed.

import { EVENT_CODES, type CorporateAction } from '../../corpactions/src/index.ts';

export const NOTICE_TYPE = 'CorporateActionNotice';
export const NOTICE_SCHEMA = 'https://iomarkets.org/formats/corporate-action-notice.v1.schema.json';
const NS = 'https://iomarkets.org/formats/corporate-action-notice#';

/** The inline JSON-LD context: schema.org for the issuer, the format's own terms for the rest. No hosted context file needed. */
export const NOTICE_CONTEXT = ['https://schema.org', { ioca: NS, CorporateActionNotice: 'ioca:CorporateActionNotice' }] as const;

export type Notice = {
  '@context': typeof NOTICE_CONTEXT;
  '@type': typeof NOTICE_TYPE;
  conformsTo: typeof NOTICE_SCHEMA;
  eventType: CorporateAction['type'];
  isoEventCode: 'DVCA' | 'SPLF' | 'SPLR' | 'MRGR';
  issuer: { '@type': 'Corporation'; name: string; tickerSymbol?: string; identifier?: { '@type': 'PropertyValue'; propertyID: 'SEC CIK'; value: string } };
  security?: { figi?: string; ticker?: string; instrument?: 'ADS' };
  announced: string;
  exDate?: string;
  recordDate?: string;
  paymentDate?: string;
  effectiveDate?: string;
  cash?: { amount: string; currency: string };
  ratio?: { new: number; old: number };
  frequency?: CorporateAction['frequency'];
  acquirer?: string;
  /** The regulatory filing the notice restates. */
  source?: string;
};

/** A feed event as a notice, ready to paste into a page inside <script type="application/ld+json">. */
export function toNotice(e: CorporateAction): Notice {
  const n: Notice = {
    '@context': NOTICE_CONTEXT,
    '@type': NOTICE_TYPE,
    conformsTo: NOTICE_SCHEMA,
    eventType: e.type,
    isoEventCode: EVENT_CODES[e.type],
    issuer: {
      '@type': 'Corporation',
      name: e.company.name,
      ...(e.company.ticker ? { tickerSymbol: e.company.ticker } : {}),
      identifier: { '@type': 'PropertyValue', propertyID: 'SEC CIK', value: e.company.cik },
    },
    announced: e.dates.announced,
  };
  if (e.company.figi || e.company.ticker || e.instrument) n.security = { ...(e.company.figi ? { figi: e.company.figi } : {}), ...(e.company.ticker ? { ticker: e.company.ticker } : {}), ...(e.instrument ? { instrument: e.instrument } : {}) };
  if (e.dates.ex) n.exDate = e.dates.ex;
  if (e.dates.record) n.recordDate = e.dates.record;
  if (e.dates.pay) n.paymentDate = e.dates.pay;
  if (e.dates.effective) n.effectiveDate = e.dates.effective;
  if (e.cash) n.cash = { ...e.cash };
  if (e.ratio) n.ratio = { ...e.ratio };
  if (e.frequency) n.frequency = e.frequency;
  if (e.acquirer) n.acquirer = e.acquirer;
  n.source = e.source.url;
  return n;
}

/** The <script> tag an issuer pastes into the page. */
export const noticeScript = (n: Notice | Notice[]) => `<script type="application/ld+json">\n${JSON.stringify(n, null, 2)}\n</script>`;

const DATE_FIELDS = [['exDate', 'ex'], ['recordDate', 'record'], ['paymentDate', 'pay'], ['effectiveDate', 'effective']] as const;

/** Where a notice found on a page disagrees with the feed's event: field by field, empty when they match. */
export function compareNotice(n: Record<string, unknown>, e: CorporateAction): { field: string; page: string; feed: string }[] {
  const out: { field: string; page: string; feed: string }[] = [];
  for (const [f, k] of DATE_FIELDS) {
    const page = typeof n[f] === 'string' ? (n[f] as string) : undefined;
    const feed = e.dates[k];
    if (page && feed && page !== feed) out.push({ field: f, page, feed });
  }
  const cash = n.cash as { amount?: unknown; currency?: unknown } | undefined;
  if (cash && e.cash && (Number(cash.amount) !== Number(e.cash.amount) || (cash.currency && cash.currency !== e.cash.currency))) {
    out.push({ field: 'cash', page: `${String(cash.currency ?? '')} ${String(cash.amount)}`.trim(), feed: `${e.cash.currency} ${e.cash.amount}` });
  }
  const ratio = n.ratio as { new?: unknown; old?: unknown } | undefined;
  if (ratio && e.ratio && (Number(ratio.new) !== e.ratio.new || Number(ratio.old) !== e.ratio.old)) out.push({ field: 'ratio', page: `${String(ratio.new)}-for-${String(ratio.old)}`, feed: `${e.ratio.new}-for-${e.ratio.old}` });
  return out;
}
