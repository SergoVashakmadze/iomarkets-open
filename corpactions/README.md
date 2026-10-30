# Corporate actions feed

A free, open feed of the corporate actions of US-listed companies, read from their filings (and the press releases
filed with them) on SEC EDGAR: the 8-Ks of US companies and the 6-Ks of foreign private issuers. Each event keeps the
sentence it came from and links its filing (`source.form` says which), and each is also written as an ISO 20022
`seev.031.001.14` corporate action notification.

| Type | ISO code | What the filing must state for it to go in |
|---|---|---|
| `dividend` | `DVCA` | A cash amount per common share, the record date and the payment date |
| `split` | `SPLF` | The ratio and the date it takes effect (or is distributed) |
| `reverse-split` | `SPLR` | The ratio and the date it takes effect |
| `merger` | `MRGR` | A completed merger reported by the company acquired (8-K items 2.01 with 3.01 or 5.01), its closing date, and cash or shares per share |

6-Ks ask for more before an event goes in: see "6-K filings" below.

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

**Precision 12/12 = 1.0; recall 12/20 = 0.6.** The 8 misses are left out on purpose: tables (Unilever, Shell, CMB.TECH,
TotalEnergies' two-market timetable), numeric dates (Gerdau), a bare `$` beside a foreign market (Scorpio Tankers), a
split the company "expects to implement" (Kandi), and one furnished weeks after it took effect (Gauzy). The other 30
filings state no event in full for the US security: per-share amounts of ADS issuers (Shinhan, KT, BBVA, Equinor, Nokia,
Nomura), "anticipated" or "expected" dates, scrip and cash-or-shares elections, distributions from reserves (Eni),
approximate amounts, results that mention past dividends or splits, proposals, two ADS ratio changes, OTC-only
issuers, and merger notices without a closing date or terms.

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
