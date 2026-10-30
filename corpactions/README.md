# Corporate actions feed

A free, open feed of the corporate actions of US-listed companies, read from their filings (and the press releases
filed with them) on SEC EDGAR: the 8-Ks of US companies and the 6-Ks of foreign private issuers. Each event keeps the
sentence it came from (or, for a dividend stated only in a table, the table's rows: see "Tables" below) and links its
filing (`source.form` says which), and each is also written as an ISO 20022 `seev.031.001.14` corporate action
notification.

| Type | ISO code | What the filing must state for it to go in |
|---|---|---|
| `dividend` | `DVCA` | A cash amount per common share, the record date and the payment date |
| `split` | `SPLF` | The ratio and the date it takes effect (or is distributed) |
| `reverse-split` | `SPLR` | The ratio and the date it takes effect |
| `merger` | `MRGR` | A completed merger reported by the company acquired (8-K items 2.01 with 3.01 or 5.01), its closing date, and cash or shares per share |

6-Ks ask for more before an event goes in: see "6-K filings" below. A dividend whose amount and dates are only in a
table is read from the filing's own HTML table, under the same rules: see "Tables".

Use it on the web at <https://iomarkets.tech/corporate-actions>, from an AI assistant through the MCP server at
`https://iomarkets.tech/mcp` (tools `list_corporate_actions`, `holdings_calendar`, `get_corporate_action`), or over HTTP:

```bash
curl https://iomarkets.tech/api/corporate-actions                       # the whole feed
curl -X POST https://iomarkets.tech/api/corporate-actions \
  -H 'content-type: application/json' \
  -d '{"holdings":["POOL","HBAN"],"from":"2026-11-02","to":"2026-11-08"}'  # tickers, CIKs or FIGIs
curl -X POST https://iomarkets.tech/api/corporate-actions \
  -H 'content-type: application/json' \
  -d '{"id":"dividend-0000945841-2026-11-25","format":"seev.031"}'         # one event as ISO 20022 XML
```

## How it is built

| Step | Where |
|---|---|
| Find filings: EDGAR full-text search, one query per kind of action, for 8-Ks and for 6-Ks | `src/edgar.ts` (`QUERIES`) |
| Which of a 6-K issuer's tickers trade on a US exchange: SEC's `company_tickers_exchange.json` (one request a run) | `src/edgar.ts` (`usTickers`) |
| Read each document: HTML to text, sentences, dates (day first too, for 6-Ks), amounts, ratios | `src/text.ts` |
| Extract events, leaving out anything not stated in full | `src/extract.ts` (8-K), `src/extract6k.ts` (6-K) |
| Dividends stated only in a table: the filing's `<table>` markup as a grid (colspan, a `$` in its own cell), one dividend per row or column | `src/tables.ts`, `src/extractTable.ts` (`extractAll`: sentences first, then tables) |
| FIGIs for the tickers from OpenFIGI (no key; cached in `data/figi.json`); for 6-K tickers also the security type (`data/figi-kinds.json`), so an amount per share is never filed under an ADS | `src/figi.ts`, `fitsListing` in `src/extract6k.ts` |
| Merge, de-duplicate, drop events 30 days after their last date | `src/query.ts`, `scripts/ingest.ts` |
| Each event as `seev.031.001.14` | `src/seev031.ts` |
| Calendar file (`.ics`) for holdings | `src/ics.ts` |

`node corpactions/scripts/ingest.ts` reads the last four days. `--from` and `--to` pick the days, and `--cache <dir>`
keeps every EDGAR answer on disk so changes to `extract.ts` can be re-run without asking EDGAR again. SEC's fair-access
rules: a User-Agent naming who is asking (`USER_AGENT` in `src/edgar.ts`) and at most 10 requests a second (this
waits 150 ms between requests). `.github/workflows/corporate-actions.yml` runs it every weekday and commits the data.

## Precision over recall

An event goes in only when the filing states every fact the event needs. Each rule was checked against real filings
from September and October 2026; `tests/corpactions-extract.test.ts` holds their sentences. Left out on purpose:

- dividends on preferred stock, stock dividends, and amounts that are only comparisons ("compared to $0.37 in the prior
  quarter");
- dividends announced without "per share" (an earnings highlight saying "Dividend of $0.77");
- proposed splits, ratio ranges, splits awaiting a vote, and the "adjusted for any split" boilerplate;
- mergers with cash-or-stock elections, and mergers reported only by the acquirer;
- companies with no ticker on EDGAR (non-traded funds, co-registrant subsidiaries).

So the feed is not complete. A 2026-09-01 to 2026-10-29 backfill read 1,986 documents and kept 389 events; a sample of
29 dividends matched their filings exactly. **Check the filing before acting on an event.** Nothing here is investment
advice.

## 6-K filings

Foreign private issuers file 6-Ks: free-form, in many markets' conventions. The 6-K reader (`src/extract6k.ts`) keeps
the 8-K rule (every fact stated, or no event) and asks for more:

- **The currency is stated.** `US$`, `€`, `KRW`, `pence`, `CAD`… and the amount is kept in it, never converted
  (`cash.currency`, and `Ccy` in `seev.031`). A bare `$` or "cents" counts only when the filing says which dollars
  ("All currency is expressed in Canadian dollars"), or names no market outside the US and no other dollar.
- **The amount and dates are for the security that trades in the US.** If the filing mentions American depositary
  shares, only an amount per ADS, with dates stated for ADS holders, is read, and the event says `instrument: "ADS"`.
  Otherwise the shares must be named on a US exchange ("(NYSE: TAC)"). Then `ingest()` checks OpenFIGI's security type
  for the ticker: an event per share for a ticker that is a depositary receipt (or per ADS for one that isn't) is left
  out. This is what keeps Shell's US$0.3906 per ordinary share off `SHEL`, whose ADS is two shares.
- **Only US-listed issuers.** A filer whose tickers SEC lists only as OTC, or not at all, is left out, as an 8-K filer with
  no ticker is. No FIGI from OpenFIGI: the event keeps CIK and ticker, as for 8-Ks.
- **Left out:** proposed, recommended (subject to a general meeting), forecast, expected or anticipated dividends and
  dates ("expected to be paid on or around"); scrip dividends and any cash-or-shares election; distributions of capital
  (share premium, reserves, "in place of the dividend"); approximate amounts ("~$0.12"); timetables for two markets
  whose columns aren't said in words; numeric dates (11/10/2026: day and month order differ by country);
  "respectively" lists.
- **Splits** only for issuers whose shares themselves trade in the US. **ADS ratio changes are not splits.** A depositary
  changing how many shares an ADS represents ("the same effect as a one-for-seven reverse ADS split") changes no shares
  of the company, its FIGI and its holders at home are untouched, and the date is the depositary's: it is left out,
  as is any split in a filing that mentions ADSs (the ratio may absorb it). Splits the company only "expects to" or
  "plans to" make are left out.
- **Mergers** only when the filer says it was the company acquired (it became a subsidiary, or its shares ceased to
  trade), gives the cash per share (or per ADS) with its currency, and states the effective date. "Today announced the
  completion" is not a date. Elections are left out.
- **Ex-date.** Only one stated for the US market (NYSE, Nasdaq, ADSs), or in a filing that names no other market;
  otherwise the T+1 rule, as for 8-Ks.

### How well it does: 50 real 6-Ks

`fixtures/6-k/` holds the text of 50 real 6-K documents (September and October 2026, a few earlier mergers), each
with its accession number, its EDGAR address, its US tickers and OpenFIGI security type, and, labelled by hand in
`index.json`, every event a careful reader finds stated in it for the US security. `tests/corpactions-6k.test.ts` runs
the reader on all of them:

| | Filings | Events stated | Read correctly | Read wrongly |
|---|---|---|---|---|
| Dividends | 26 | 8 | 2 (TransAlta CAD, HSBC per ADS) | 0 |
| Splits and ADS ratio changes | 16 | 11 | 9 (8 reverse, 1 forward) | 0 |
| Mergers | 8 | 1 | 1 (Perfect Corp) | 0 |
| **All** | **50** | **20** | **12** | **0** |

**Precision 12/12 = 1.0; recall 12/20 = 0.6** from the sentences. With the tables (below), Shell's ADS dividend is read
too: **13/13, recall 13/20.** The 7 misses are left out on purpose: Unilever (its "table" is slide images with a text
layer, no `<table>`), CMB.TECH (a dividend and a share premium repayment in one distribution), TotalEnergies (the NYSE
record date is only in a footnote under its two-market timetable), numeric dates (Gerdau), a bare `$` beside a foreign
market (Scorpio Tankers), a split the company "expects to implement" (Kandi), and one furnished weeks after it took
effect (Gauzy). The other 30
filings state no event in full for the US security: per-share amounts of ADS issuers (Shinhan, KT, BBVA, Equinor, Nokia,
Nomura), "anticipated" or "expected" dates, scrip and cash-or-shares elections, distributions from reserves (Eni),
approximate amounts, results that mention past dividends or splits, proposals, two ADS ratio changes, OTC-only
issuers, and merger notices without a closing date or terms.

## Tables

Some dividends are stated only in a table: a REIT's or BDC's months ("Month | Amount Per Share | Record Date | Payment
Date"), a UK issuer's timetable ("Ex-Dividend Date for ADSs | November 13, 2026 ... Payment date | December 21, 2026").
`src/extractTable.ts` reads them from the filing's own `<table>` markup (`src/tables.ts`; no OCR, no images, no PDFs)
with the rules above, and asks the same of a table as of a sentence:

- **Every value in one cell.** A record date and a payment date, each a single date with its year in its own cell
  (numeric dates, "on or about", "15 days prior to" are not dates), and an amount with its currency (in the cell, or in
  its label: "Shell ADSs (US$)", "(yen)", "US cents per share") and its unit (per share or per ADS, from the cell, the
  label, the row, or the table's heading). An ex-date only when the table has one for the US security, or names no
  other market; else the T+1 rule. "Ex-Dividend and Record Date" is both.
- **One dividend per row or per column.** Labels across the top (one dividend a row, e.g. three months) or down the
  side (one a column). Several rows or columns are several dividends only when they are periods (months, quarters,
  "FQ3"); when they are markets, classes or series ("Euronext | NYSE", "Series A", "Class E | Class FA"), only the one
  that names the US security ("NYSE (ADR program)", "for ADSs") is read, and none if no row or column says so. A column
  that appears twice, or two cells that differ for the same thing, is not read.
- **The amount from outside the table** only when the table has none and is one dividend: from the sentence that
  introduces it, if that sentence declares the dividend and gives one amount for the US security, or else from the
  document's only small table of amounts for that unit (Shell's "Per ADS ... 0.7812").
- **Left out:** any table with a row paid before the filing (a table of past dividends, whatever else it lists) or that
  "were declared" in a period; guidance ("announced guidance on the October 2026 cash dividend"); estimates ("expected", "anticipated", "provisional", "forecast", "proposed", "subject
  to approval", "on or about"); scrip, elections, stock dividends, distributions of capital, interest on capital;
  preferred stock (by name, or by "perpetual", "liquidation preference", "per annum dividend rate"), another of the
  filer's tickers named in or before the table (Strategy's STRC, DeFi Development's CHAD); and, for 6-Ks, everything
  the sentence reader leaves out: a per-share amount when the US security is the ADS, dates the table doesn't give for
  ADS holders.
- **A dividend already read from the sentences stays as it is**: the tables add only what they alone state.

**The quote is the table.** `source.quote` gives the table's heading (and the sentence before it, when the amount came
from there), then the rows the event was read from, each in `[square brackets]` with its cells joined by ` | `, as the
filing renders them, and `source.table` is `true`: `Distribution Payable in November 2026 [Ex-Dividend and Record Date |
Payment Date | Total Distribution Per Share] [November 10, 2026 | November 17, 2026 | $0.47]`. A `$` or `%` in a cell of
its own is shown stuck to its number, as a browser shows it. Each row can be found in the filing as it reads.

### How well it does: 34 more real filings

`fixtures/tables/` holds 34 real filings (13 8-Ks, 21 6-Ks; July to October 2026) found by EDGAR full-text search for
dividend timetables: the tables that state a dividend, and the ones that look like it and don't. Each is the document as
filed (`.htm.gz`), with its accession number, and its events labelled by hand in `index.json`; the 50 6-K fixtures now
carry their HTML too. `tests/corpactions-tables.test.ts` runs the whole reader (sentences, then tables, then the
OpenFIGI check) on all 84:

| | Filings | Events stated | Read correctly | Read wrongly |
|---|---|---|---|---|
| 8-K table dividends (Armour twice, Saratoga, UDR, Hercules, SmartStop) | 6 | 10 | 10 | 0 |
| 6-K table dividends (Shell twice, LogProStyle twice) | 4 | 8 | 7 | 0 |
| Missed on purpose (Caledonia, OceanaGold, Barclays, Rogers) | 4 | 4 | 0 | 0 |
| Tricky negatives | 20 | 0 | 0 | 0 |
| The 50 6-K fixtures | 50 | 20 | 13 | 0 |
| **All** | **84** | **42** | **30** | **0** |

**Precision 30/30 = 1.0; recall 30/42 = 0.71** (18 of the 30 from tables). The new misses: LogProStyle's installment
paid on the day it filed (stated only in sentences that declare nothing), Caledonia ("14 United States cents on each of
the Company's shares", not "per share"), OceanaGold (the amount three sentences before its table, beside the TSX),
Barclays (its table is the ordinary shares' timetable; the ADS amount and ex-date are prose under it) and Rogers (a
sentence in an MD&A that names no US exchange). The negatives are the tables that look like dividends: Armour's "guidance" for next month's dividend (same table as the declaration a week later), Strategy's
daily STRC (preferred) dividends in two column groups and its year of past ones, Strive's SATA and DeFi Development's
CHAD preferred, Microsoft's and Amdocs' tables of dividends declared and paid, Mid-America's quarters with numeric dates,
Boyd's and OR Royalties' past dividends, Shell's next-year timetable with no amounts, BAT's proposed two-market
timetable, Prudential's scrip, Shinhan's "(Expected) Payment Date", POSCO's "Provisional" date, GSK, RELX, Harmony,
Woodside, Gravity and SK Telecom (per-share amounts for an ADS).

Two sentence-reader fixes came with it: a "targeted annualized dividend of $1.60 per share" is no longer read as the
dividend (SmartStop's monthly $0.13589041 is in its table), and an 8-K's ticker is the one its cover lists for the
common stock before EDGAR's first (Hercules is HTGC, not its HCXY notes). A filing that says it lists shares "rather
than through American Depositary Receipts (ADRs)", or a hotel's "average daily rate (ADR)", no longer counts as
speaking of ADSs.

## Dates and identifiers

- **Ex-date.** When the filing gives none, the ex-date is the record date (`exDateRule: true`), as under US T+1
  settlement since 28 May 2024. Exchanges set a different ex-date for large special dividends; the filing usually
  says so then.
- **Splits reported twice** (the charter amendment's effective time, then the first split-adjusted trading day) are
  kept once, at the later date.
- **Identifiers.** Companies by SEC CIK and ticker; the common stock by its OpenFIGI composite FIGI. No CUSIPs or US
  ISINs, which are licensed. In `seev.031` the security is `OthrId` entries with proprietary types `FIGI` and
  `TICKER`, and its name in `Desc`.

## Tie-ins

- Every event's `seev.031` message is valid against the base schema and the Test Bench's business rules, with no
  warnings; `tests/corpactions.test.ts` checks every event in `data/events.json`.
- `tokenizedVersions(event)` finds Asset Map entries whose underlying is the event's stock: by FIGI when both have
  one, else by a US-listed ticker. With the 30 xStocks in the map, 4 events in the backfill link to tokens (Broadcom,
  Oracle and Micron dividends, and Sandisk's 8-for-1 split on 19 November). `tokenEffect(event)` says what each does
  to the token. MCP `token_corporate_actions` goes from a token contract to its stock's events in one call.
- **Checked against the issuer's own list.** xStocks publishes the corporate actions it applies
  (`/api/v2/public/corporate-actions/upcoming`). On 2026-10-29, 72 dividends were for tickers both cover. 27 had
  events near the same date on both sides, and 25 of those matched to the cent. The other two are explained: ACN, which
  xStocks records net of Ireland's 25% withholding ($1.2825 against the $1.71 declared), and APH, which split
  2-for-1 between declaring $0.25 and paying it, so xStocks shows $0.125. The feed's amount is as declared and is not
  adjusted for a split that comes later. The remaining 45 were November and December events not yet in the
  issuer's list, so the feed was ahead of it. The issuer's split list matched ours inside the backfill window.
