// The corporate actions feed's data model. One event per corporate action of a US-listed
// company, taken from its own SEC EDGAR filing: the 8-K (US companies) or the 6-K (foreign
// private issuers), or the press release filed with it.
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
  /**
   * Dividend per share (or per ADS), or cash per share in a merger, as the filing states it: 8-K
   * amounts are in US dollars, 6-K amounts in the currency the filing names (ISO 4217).
   */
  cash?: { amount: string; currency: string };
  /**
   * What the amount and dates are for, when it is not the shares themselves: 'ADS', the American
   * depositary shares that trade in the US (6-K issuers only). Left out for the shares.
   */
  instrument?: 'ADS';
  /** Shares after : shares before, for a split; acquirer shares per share, for a stock merger. */
  ratio?: Ratio;
  frequency?: 'monthly' | 'quarterly' | 'semi-annual' | 'annual' | 'special' | 'other';
  /** Merger: who acquires the company, as the filing names it. */
  acquirer?: string;
  source: {
    url: string;
    /** The form the document was filed with: 8-K, 6-K (or an amendment, 8-K/A, 6-K/A). */
    form: string;
    accession: string;
    filed: string;
    /**
     * The sentence(s) the event was read from, as filed. When `table` is true, it also quotes the rows of the
     * filing's table it was read from, each in [square brackets] with its cells joined by " | ", after the
     * table's heading (and the sentence before it, if the amount came from there).
     */
    quote: string;
    /** True when the event was read from a table in the filing (its own HTML <table>), not only from sentences. */
    table?: true;
  };
};

/** An amount as people read it: "$1.30" for US dollars, "EUR 0.54" or "CAD 0.07" for the rest. */
export const money = (c: { amount: string; currency: string }) => (c.currency === 'USD' ? `$${c.amount}` : `${c.currency} ${c.amount}`);

/** What one unit of the security is called: "share", or "ADS" for American depositary shares. */
export const unitOf = (e: { instrument?: 'ADS' }) => (e.instrument === 'ADS' ? 'ADS' : 'share');
