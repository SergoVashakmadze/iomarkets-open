// The corporate actions feed's data model. One event per corporate action of a US-listed
// company, taken from its own SEC EDGAR filing: the 8-K or the press release filed with it.
// Every event keeps the sentence it was read from and the filing's address, so anyone can
// check it. Identifiers are open ones only: the SEC's CIK, the ticker, OpenFIGI's FIGI. No
// CUSIPs or US ISINs, which are licensed.

export type EventType = 'dividend' | 'split' | 'reverse-split' | 'merger';

/** The ISO 20022 / ISO 15022 event code each type is announced with in seev.031. */
export const EVENT_CODES: Record<EventType, 'DVCA' | 'SPLF' | 'SPLR' | 'MRGR'> = {
  dividend: 'DVCA',
  split: 'SPLF',
  'reverse-split': 'SPLR',
  merger: 'MRGR',
};

export const EVENT_NAMES: Record<EventType, string> = {
  dividend: 'Cash dividend',
  split: 'Stock split',
  'reverse-split': 'Reverse stock split',
  merger: 'Merger',
};

export type Company = {
  name: string;
  /** The SEC's Central Index Key, 10 digits. */
  cik: string;
  ticker?: string;
  /** OpenFIGI's composite FIGI for the common stock (US), when it has one. */
  figi?: string;
};

export type Ratio = { new: number; old: number };

export type CorporateAction = {
  /** Stable: type, CIK and the event's key date, e.g. dividend-0000049196-2027-01-04. */
  id: string;
  type: EventType;
  company: Company;
  /** YYYY-MM-DD. */
  dates: {
    announced: string;
    record?: string;
    /** Stated in the filing, or the record date under the US T+1 rule (exDateRule). */
    ex?: string;
    pay?: string;
    /** When a split or merger takes effect. */
    effective?: string;
  };
  /** True when the ex-date was not stated and follows the T+1 rule: ex-date = record date. */
  exDateRule?: boolean;
  /** Dividend per share, or cash per share in a merger. */
  cash?: { amount: string; currency: 'USD' };
  /** Shares after : shares before, for a split; acquirer shares per share, for a stock merger. */
  ratio?: Ratio;
  frequency?: 'monthly' | 'quarterly' | 'semi-annual' | 'annual' | 'special' | 'other';
  /** Merger: who acquires the company, as the filing names it. */
  acquirer?: string;
  source: {
    url: string;
    form: string;
    accession: string;
    filed: string;
    /** The sentence(s) the event was read from, as filed. */
    quote: string;
  };
};
