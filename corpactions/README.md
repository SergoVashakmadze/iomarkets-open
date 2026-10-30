# Corporate actions feed

A free, open feed of the corporate actions of US-listed companies, read from the 8-K filings (and the press releases
filed with them) on SEC EDGAR. Each event keeps the sentence it came from and links its filing, and each is also written
as an ISO 20022 `seev.031.001.14` corporate action notification.

| Type | ISO code | What the filing must state for it to go in |
|---|---|---|
| `dividend` | `DVCA` | A cash amount per common share, the record date and the payment date |
| `split` | `SPLF` | The ratio and the date it takes effect (or is distributed) |
| `reverse-split` | `SPLR` | The ratio and the date it takes effect |
| `merger` | `MRGR` | A completed merger reported by the company acquired (8-K items 2.01 with 3.01 or 5.01), its closing date, and cash or shares per share |

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
| Find filings: EDGAR full-text search, one query per kind of action, 8-Ks only | `src/edgar.ts` (`QUERIES`) |
| Read each document: HTML to text, sentences, dates, amounts, ratios | `src/text.ts` |
| Extract events, leaving out anything not stated in full | `src/extract.ts` |
| FIGIs for the tickers from OpenFIGI (no key; cached in `data/figi.json`) | `src/figi.ts` |
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
