# IoMarkets open tools

Free, open test and reference tools for capital-markets plumbing: the layer every bank, broker, fund and wallet
otherwise rebuilds for itself. Each runs live at [iomarkets.tech](https://iomarkets.tech), over HTTP, and for AI
assistants over MCP (`https://iomarkets.tech/mcp`). The formats they read and write are governed by
[IoMarkets.org](https://iomarkets.org/formats).

| Folder | What it is | Live |
|---|---|---|
| [`bench/`](bench/README.md) | **ISO 20022 Test Bench.** Checks pacs.008, pacs.009, pain.001, camt.053 and seev.031 messages against the base schemas, then business rules, each failure with its line and a plain reason. Library, CLI and GitHub Action; pure TypeScript, no dependencies, and tested against libxml2. | [/test-bench](https://iomarkets.tech/test-bench) |
| [`assetmap/`](assetmap/README.md) | **Tokenized Asset Map.** A signed, open list linking tokenized funds and stocks to their official token contracts, chain by chain, taken only from what issuers publish. A checker says whether a contract is the real one, and any entry can be re-checked with its issuer live. | [/asset-map](https://iomarkets.tech/asset-map) |
| [`corpactions/`](corpactions/README.md) | **Corporate actions feed.** Dividends, splits and mergers of US-listed companies, read from their own SEC EDGAR filings, each with the sentence it came from, as an ISO 20022 seev.031 message, and linked to tokenized versions of the stock in the Asset Map. | [/corporate-actions](https://iomarkets.tech/corporate-actions) |
| [`formats/`](formats/) | **The open formats** as JSON Schemas: Asset Map entry, issuer key file, corporate action event, Test Bench report. | [iomarkets.org/formats](https://iomarkets.org/formats) |

## Use it

Node 24 or later runs the TypeScript directly; nothing to build.

```bash
npm ci
npm test                                         # every tool's tests
node bench/cli.ts bench/samples/xml/pacs.008-valid.xml   # check a message
```

In GitHub Actions, check your ISO 20022 messages on every push; each problem is annotated on its line:

```yaml
- uses: SergoVashakmadze/iomarkets-open/bench@main
  with:
    files: messages/**/*.xml
```

As a library:

```ts
import { validate } from './bench/src/index.ts'
import { checkContract, ENTRIES } from './assetmap/src/index.ts'
import { EVENTS, query, toSeev031 } from './corpactions/src/index.ts'

validate(xml)                                        // { valid, errors, warnings, issues: [...] }
checkContract(ENTRIES, 'ethereum', '0x…')            // { verdict: 'official' | 'other-chain' | 'impostor' | 'unknown', … }
query(EVENTS, { holdings: ['NVDA'], from: '2026-11-01', to: '2026-11-30' })
```

## Data

- `assetmap/data/entries.json` is signed with ed25519 by IoMarkets. The public keys are in `assetmap/src/sign.ts`,
  and `checkAttestations` verifies them. Issuers can sign their own entries (`assetmap/README.md`).
- `corpactions/data/` is a snapshot of the feed. `node corpactions/scripts/ingest.ts` rebuilds it from EDGAR, and
  the live feed is at `https://iomarkets.tech/api/corporate-actions`.

## Licence

Code: [Apache-2.0](LICENSE). The format schemas in `formats/`: [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/).
The ISO 20022 schemas in `bench/schemas/` are ISO 20022's own (`NOTICE`).

This repository mirrors the tools from IoMarkets' main (private) repository, where they are developed alongside
the site. Issues and pull requests are welcome here: changes are carried over to the main repository and
published back. Contact: info@iomarkets.org.
