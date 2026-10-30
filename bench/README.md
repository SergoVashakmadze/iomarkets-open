# ISO 20022 Test Bench

Free, open checks for the ISO 20022 messages banks and fintechs exchange every day. Paste a
message and get a report: schema checks against the official ISO 20022 base schema first, then
business rules, each failure with its line and a plain reason.

| Message | What it is |
|---|---|
| `pacs.008.001.08` | FI to FI customer credit transfer: the main cross-border and high-value payment (the version SWIFT CBPR+ uses) |
| `pacs.009.001.08` | Financial institution credit transfer, including cover payments |
| `pacs.002.001.10` | FI to FI payment status report: accepted, pending or rejected, with the reason (the version CBPR+ uses) |
| `pacs.004.001.09` | Payment return: a settled payment sent back, with the reason and any charges (the version CBPR+ uses) |
| `pain.001.001.09` | Customer credit transfer initiation: a company's payment batch to its bank |
| `camt.053.001.08` | Bank to customer statement |
| `camt.054.001.08` | Bank to customer debit/credit notification: money in or out of an account, as it happens |
| `seev.031.001.14` | Corporate action notification |

Use it on the web at <https://iomarkets.tech/test-bench>, from an AI assistant through the
MCP server at `https://iomarkets.tech/mcp` (tool `validate_message`), over HTTP
(`POST https://iomarkets.tech/api/test-bench/validate`), from the command line, or in CI.

## What it checks

**Schema** (the XSD, re-implemented so it runs in a browser, a Worker or Node with no
dependencies): elements, order, how often each may occur, choices, text lengths, code lists,
patterns, decimals and digits, real calendar dates, the `Ccy` attribute, namespaces. A
differential test runs every sample and 320 random mutations (40 of each valid sample) through libxml2 as well, and fails
if the two ever disagree on whether a message is schema-valid (`tests/bench-samples.test.ts`).

**Business rules**, which run once the schema passes:

- every message, by data type: IBAN check digits and length (ISO 13616), BIC country, LEI
  check digits (ISO 17442), ISIN check digit (ISO 6166), country codes (ISO 3166), currency
  codes and the number of decimals each currency allows (ISO 4217: no decimals for JPY, three for KWD);
- the cross-element rules ISO 20022 publishes with each message: transaction counts and control
  sums, totals in one currency, settlement date in the group header or in every transaction, no
  agent in both places, settlement method against reimbursement agents and clearing systems,
  intermediary agents filled in order, an exchange rate when instructed and settled currencies
  differ, cheques without creditor accounts, statement balances that follow from their entries;
  status reports whose group and transaction statuses agree (no rejected transaction in an
  accepted or pending group, only rejected ones in a rejected group, none in a group only
  received) and that name the original message once or per transaction; returns whose totals
  match, with no transactions and no control sum when the whole message is returned, charges
  only with the amount before charges, and no cover settlement for a returned direct debit;
  notifications paginated once, with summaries that add up and bank transaction codes that are
  not empty; a narrative whenever the reason code is NARR;
- market practice and ISO guidelines as warnings (CBPR+, SMPG): a UETR on every payment (and the
  original UETR in status reports and returns), a reason on every return, a reference on every
  notified transaction, a default option on a choice event, ex-date ≤ record date ≤ payment date.

Codes are stable (`IBAN_CHECKSUM`, `BALANCE_MISMATCH`, …), so tests can match on them.

## Command line

Node 24 runs it as it is: no build, no install.

```bash
node bench/cli.ts payment.xml statements/*.xml   # exit 1 if any fails
node bench/cli.ts --json payment.xml             # the report as JSON
node bench/cli.ts --samples ./samples            # write the sample library
node bench/cli.ts --help
```

## GitHub Action

```yaml
- uses: SergoVashakmadze/iomarkets-open/bench@main
  with:
    files: test/fixtures/**/*.xml
    strict: false
```

Each issue becomes an annotation on its file and line.

## Sample library

`samples/index.ts` holds a valid message for each type and 39 broken ones, each made by one
small change and labelled with the code it must raise. `samples/xml/` has them as files
(regenerate with `node bench/cli.ts --samples bench/samples/xml`). Every party, account and
security in them is made up; the identifiers carry correct check digits.

## Schemas and licence

`schemas/` holds the ISO 20022 base message schemas, unmodified except that line endings are LF
(ISO ships them with CRLF). ISO 20022 publishes the message definitions and their XSDs for anyone
to download and use from [iso20022.org](https://www.iso20022.org/iso-20022-message-definitions).
The payments and cash management schemas are the 2019 maintenance release, the versions SWIFT
CBPR+ uses; `seev.031` is the 2024 release.

The first five copies were taken on 2026-10-29 from public mirrors, and two independent mirrors
were checked to be byte-identical (apart from line endings) for every file that both hold. On
2026-10-30 the 2019 files were downloaded from iso20022.org itself, from the message archive's
"Payments Clearing and Settlement V09" (`/message-set/181/download`, zip SHA-256
`5d433a6c8986136180e39923182f21c3c08a4040c085585f560b4b3679797cee`) and "Bank-to-Customer Cash
Management V08" (`/message-set/866/download`, zip SHA-256
`9290fd2a3ebc9acac25016fbb208f3270fafa8c21f7a80269590c20ebec6ca77`). `pacs.002`, `pacs.004`
and `camt.054` come from those zips, and the mirror copies of `pacs.008`, `pacs.009` and `camt.053`
match them byte for byte once line endings are LF. `pain.001.001.09` and `seev.031.001.14` have
not yet been compared with an iso20022.org download.

| File | SHA-256 (as stored, LF) | SHA-256 of ISO's file (CRLF) | Checked against iso20022.org |
|---|---|---|---|
| `camt.053.001.08.xsd` | `ca0b135cc8e2dde5b2f99af6b6c514a8f29d6e7c6cf98e9ea84d247189868ff5` | `338e9cb0c9989b5181802a7b773eece070d6815fc9d6483ac0579117bc24ccba` | yes |
| `camt.054.001.08.xsd` | `2b392a1f7e70e70902fd0d803ff85989613bd1cae351663240b0bb9243be2c28` | `13d220337d47e22cf25788807c136794a76955791df612c6947277272d440da6` | yes (taken from it) |
| `pacs.002.001.10.xsd` | `2016d5989e93376a85e515ef4874eceea46fc95d35c62292cf1577be31382404` | `d14da6304db5178b1afc7d8ed6cc6073e6e1a143fc79d9ba66d3246d4a654e90` | yes (taken from it) |
| `pacs.004.001.09.xsd` | `2491776eeee135de20edf14aa038d036dddd25fae21c7afdc8d1150e5b16f0a6` | `e2b13023bed19429bd8347ed9e13d31e6dec33fa4a8ef07dd03138d5442826b9` | yes (taken from it) |
| `pacs.008.001.08.xsd` | `9bb360555d1981be8635aa3ed295abfe8b2d221d316193434114ad722107dcde` | `cf048155f70cacd03f1f1dfadf66cba8752be93c249c267351782fd6adb023f7` | yes |
| `pacs.009.001.08.xsd` | `b4b01e4af3f47152c84edb04a7e61d33c6929d82ef9ed05e9525177ae74dcb52` | `2f695939eb9be156bf2f14a26fbeb0f3bead73037fb03fd219ad14ceb19905ec` | yes |
| `pain.001.001.09.xsd` | `05440a7e84f695e7dbc6677082f43623cd7393881b76a5e8d648ae21d7d728e3` | | not yet |
| `seev.031.001.14.xsd` | `4fc59904b4aa8f8c25b845a37bcf043050957f69afc2c3d36faebef40f0fdf60` | | not yet |

The business rules for `pacs.002`, `pacs.004` and `camt.054` follow the constraints in the same
zips' Message Definition Reports (Part 2, approved by the Payments SEG on 21 January 2019); each
rule in `src/rules.ts` names the constraint it implements.

Market usage guidelines such as SWIFT's CBPR+ sit behind a MyStandards login and are not
redistributed here. The bench checks the base schemas only; its CBPR+ warnings come from public
market practice, not from the guideline files.

`models/` is compiled from `schemas/` by `node bench/scripts/compile-xsd.ts`; a test fails if
they drift. To add a message version: put its XSD in `schemas/`, compile, add it to `MESSAGES`
in `src/index.ts` and a valid sample to `samples/`.
