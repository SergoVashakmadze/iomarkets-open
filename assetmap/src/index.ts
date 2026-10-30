// The Tokenized Asset Map: a signed, open list linking securities (FIGI, and ISIN where
// the issuer gives it) to their token contracts, chain by chain. Used by the /asset-map
// page, GET/POST /api/asset-map and the MCP tools check_token_contract,
// list_tokenized_assets, get_tokenized_asset and verify_asset_with_issuer.

import data from '../data/entries.json' with { type: 'json' };
import type { Entry } from './types.ts';

export const ENTRIES = data as unknown as Entry[];

export { checkContract, normalize, search, type CheckResult, type Verdict } from './check.ts';
export { checkWithIssuer, checkIssuerSignature, stellarCurrencies, type Fetcher, type IssuerCheck } from './issuer.ts';
export { ASSET_MAP_KEYS, canonical, checkAttestations, signEntry, type PublishedKey } from './sign.ts';
export { CHAINS, isChain, type Chain, type Entry, type Security, type Source, type Token } from './types.ts';

export const entryById = (id: string) => ENTRIES.find((e) => e.id === id);
