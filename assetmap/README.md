# Tokenized Asset Map

An open, signed list of which token contracts really represent which securities. Each entry links a
tokenized fund or share class (its FIGI, and its ISIN where the issuer gives one) to its token contracts, chain by
chain, and cites the issuer page each contract came from.

| Entry | Security | Contracts |
|---|---|---|
| `franklin-fobxx` | Franklin OnChain U.S. Government Money Fund (BENJI) | 8 chains |
| `franklin-onchain-lux-ib` | Franklin OnChain U.S. Government Money Fund, gBENJI share class | Stellar |
| `franklin-onchain-lux-ab-ddis` | Franklin OnChain U.S. Government Money Fund AB (Ddis) USD (grBENJI) | Stellar |
| `franklin-onchain-sg-usd-st` | Franklin OnChain U.S. Dollar Short-Term Money Market Fund A(acc)USD (sgBENJI) | Stellar |
| `ondo-ousg` | Ondo Short-Term US Government Treasuries (OUSG) | 4 chains |
| `ondo-usdy` | Ondo US Dollar Yield (USDY, rUSDY) | 12 chains |
| `xstocks-*` (30) | xStocks: tokenized US stocks and ETFs issued by Backed (NVDAx, AAPLx, SPYx, …) | 10 to 12 chains each, 351 in all |

Use it on the web at <https://iomarkets.tech/asset-map>, from an AI assistant through the MCP server at
`https://iomarkets.tech/mcp` (tools `check_token_contract`, `list_tokenized_assets`, `get_tokenized_asset`,
`verify_asset_with_issuer`), or over HTTP:

```bash
curl https://iomarkets.tech/api/asset-map                      # every entry and the public keys
curl -X POST https://iomarkets.tech/api/asset-map \
  -H 'content-type: application/json' \
  -d '{"chain":"ethereum","address":"0x3DDc84940Ab509C11B20B76B466933f40b750dc9","symbol":"BENJI"}'
```

## Verdicts

| Verdict | Meaning |
|---|---|
| `official` | The issuer lists this contract on this chain. |
| `other-chain` | The address is a listed contract, but on another chain. On EVM chains one address can exist on many chains and belong to different people. |
| `impostor` | A listed token on this chain has this symbol, but this is a different contract. |
| `unknown` | Not in the map. That says nothing either way: the map lists only what issuers publish, and doesn't cover every tokenized asset yet. |

## What goes in

Only facts an issuer publishes itself: contracts from the issuer's own contracts page, its own public API, or its
`/.well-known/stellar.toml` (SEP-1), ISINs only as the issuer gives them, FIGIs from OpenFIGI. **No CUSIPs**, and no
US ISINs derived from them: CUSIP data is licensed and can't be republished. `tests/assetmap.test.ts` fails if a
contract cites no issuer source or an identifier is malformed (ISIN check digit, FIGI shape, address format).

Every source carries the day it was read (`checked`). `verify_asset_with_issuer`, the API's page and the
"Check with the issuer now" button fetch those sources again live, so trust needn't rest on this site. The MCP
server fetches only URLs an entry cites (`server/mcp-data.ts`).

## Tokenized stocks (xStocks)

`node assetmap/scripts/import-xstocks.ts [N]` reads the issuer's own public API (`api.xstocks.fi`): every asset, its
proof of reserves and its price. It keeps the N US-listed xStocks with the most value held in reserve (shares held
times price; 30 by default), replaces the `xstocks-*` entries and leaves the rest alone. Then re-sign. Each entry cites
the asset's own API answer (`/api/v2/public/assets/<symbol>`), which lists every deployment, so "Check with the
issuer now" re-reads it.

- The token's own ISIN (a `CH…` ISIN the issuer gives) is kept. The underlying's US ISIN, which the API also gives, is
  not: US ISINs are built on licensed CUSIPs. The underlying is identified by ticker, exchange (MIC) and FIGI
  (`security.underlying`), so the corporate actions feed can match its events to the token.
- The issuer reinvests dividends and follows splits through a multiplier (its docs, "How xStocks Handles Dividends &
  Stock Splits"), so a feed event for the stock is advance notice of a multiplier change for the token.
- The issuer doesn't offer xStocks to US persons. The map is a reference for checking contracts, not an offer.
- Imported 2026-10-29. Contracts change as the issuer adds chains. Refresh monthly with
  `node assetmap/scripts/refresh-xstocks.ts`, which runs the import, signs, tests and opens a PR. An issue opens on
  the 1st of each month as a reminder.

## Signatures

Each entry is signed with ed25519 over its canonical form: JSON with keys sorted at every level, no spaces,
`attestations` left out, and `undefined` fields dropped (`canonical` in `src/sign.ts`). The public keys are
`ASSET_MAP_KEYS` in `src/sign.ts` and are returned by `GET /api/asset-map`. The page verifies every signature in
the browser.

After any edit to `data/entries.json`, re-sign:

```bash
node assetmap/scripts/sign.ts        # key from ~/.config/iomarkets/asset-map-signing.key
npm test                             # fails if an entry is unsigned or changed after signing
```

The private key never enters the repo. `node assetmap/scripts/keygen.ts [file]` makes a new one (mode 0600, refuses
to overwrite). Rotating it with an overlap is in `HANDOVER.md` section 7.

## Issuers signing their own entries

An issuer can sign its own entry, so trust comes from the issuer and not from IoMarkets:

1. Publish its public key at `https://<issuer domain>/.well-known/iomarkets-asset-map.json`:

   ```json
   { "keys": [{ "id": "franklintempleton-2026-11", "publicKey": "<64 hex characters, ed25519>" }] }
   ```

2. Sign the entry's canonical form (as above) and add
   `{ "by": "<issuer>", "key": "<that id>", "sig": "<128 hex characters>" }` to its `attestations`. `scripts/sign.ts`
   keeps attestations that aren't IoMarkets' own.

`checkIssuerSignature(entry, domain, fetch)` in `src/issuer.ts` checks one. No issuer had published a key as of
2026-10-29.

## Adding an entry

1. Find the issuer's own page listing the contracts (not an explorer, aggregator or press article).
2. Add the entry to `data/entries.json` with its `sources` and today's date in `checked`.
3. Add chains new to the map to `CHAINS` in `src/types.ts`.
4. Re-sign and run the tests.
