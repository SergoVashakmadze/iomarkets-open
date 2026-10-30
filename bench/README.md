# ISO 20022 Test Bench

Free, open checks for the ISO 20022 messages banks and fintechs exchange every day. Paste a
message and get a report: schema checks against the official ISO 20022 base schema first, then
business rules, each failure with its line and a plain reason.

| Message | What it is |
|---|---|
| `pacs.008.001.08` | FI to FI customer credit transfer: the main cross-border and high-value payment (the version SWIFT CBPR+ uses) |
| `pacs.009.001.08` | Financial institution credit transfer, including cover payments |
| `pain.001.001.09` | Customer credit transfer initiation: a company's payment batch to its bank |
| `camt.053.001.08` | Bank to customer statement |
| `seev.031.001.14` | Corporate action notification |

Use it on the web at <https://iomarkets.tech/test-bench>, from an AI assistant through the
MCP server at `https://iomarkets.tech/mcp` (tool `validate_message`), over HTTP
(`POST https://iomarkets.tech/api/test-bench/validate`), from the command line, or in CI.

## What it checks

**Schema** (the XSD, re-implemented so it runs in a browser, a Worker or Node with no
dependencies): elements, order, how often each may occur, choices, text lengths, code lists,
patterns, decimals and digits, real calendar dates, the `Ccy` attribute, namespaces. A
differential test runs every sample and 200 random mutations through libxml2 as well, and fails
if the two ever disagree on whether a message is schema-valid (`tests/bench-samples.test.ts`).

**Business rules**, which run once the schema passes:

- every message, by data type: IBAN check digits and length (ISO 13616), BIC country, LEI
  check digits (ISO 17442), ISIN check digit (ISO 6166), country codes (ISO 3166), currency
  codes and the number of decimals each currency allows (ISO 4217: no decimals for JPY, three for KWD);
- the cross-element rules ISO 20022 publishes with each message: transaction counts and control
  sums, totals in one currency, settlement date in the group header or in every transaction, no
  agent in both places, settlement method against reimbursement agents, intermediary agents
  filled in order, an exchange rate when instructed and settled currencies differ, cheques
  without creditor accounts, statement balances that follow from their entries;
- market practice as warnings (CBPR+, SMPG): a UETR on every payment, a default option on a
  choice event, ex-date ≤ record date ≤ payment date.

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

`samples/index.ts` holds a valid message for each type and 26 broken ones, each made by one
small change and labelled with the code it must raise. `samples/xml/` has them as files
(regenerate with `node bench/cli.ts --samples bench/samples/xml`). Every party, account and
security in them is made up; the identifiers carry correct check digits.

## Schemas and licence

`schemas/` holds the ISO 20022 base message schemas, unmodified. ISO 20022 publishes the
message definitions and their XSDs for anyone to download and use from
[iso20022.org](https://www.iso20022.org/iso-20022-message-definitions). These copies were taken on
2026-10-29 from public mirrors, and two independent mirrors were checked to be byte-identical (apart
from line endings) for every file that both hold. SHA-256:

| File | SHA-256 |
|---|---|
| `camt.053.001.08.xsd` | `ca0b135cc8e2dde5b2f99af6b6c514a8f29d6e7c6cf98e9ea84d247189868ff5` |
| `pacs.008.001.08.xsd` | `9bb360555d1981be8635aa3ed295abfe8b2d221d316193434114ad722107dcde` |
| `pacs.009.001.08.xsd` | `b4b01e4af3f47152c84edb04a7e61d33c6929d82ef9ed05e9525177ae74dcb52` |
| `pain.001.001.09.xsd` | `05440a7e84f695e7dbc6677082f43623cd7393881b76a5e8d648ae21d7d728e3` |
| `seev.031.001.14.xsd` | `4fc59904b4aa8f8c25b845a37bcf043050957f69afc2c3d36faebef40f0fdf60` |

Market usage guidelines such as SWIFT's CBPR+ sit behind a MyStandards login and are not
redistributed here. The bench checks the base schemas only; its CBPR+ warnings come from public
market practice, not from the guideline files.

`models/` is compiled from `schemas/` by `node bench/scripts/compile-xsd.ts`; a test fails if
they drift. To add a message version: put its XSD in `schemas/`, compile, add it to `MESSAGES`
in `src/index.ts` and a valid sample to `samples/`.
