// "Is this contract the real tokenized version of this security?" A lookup over the map,
// with the answers that matter to a wallet or exchange:
// - official: the contract is listed for that chain;
// - other-chain: the address is a listed contract, but on another chain (a common
//   mistake on EVM chains, where one address can exist on many);
// - impostor: the symbol belongs to a listed token on this chain, but the contract isn't it;
// - unknown: not in the map, which says nothing either way about a contract.

import { CHAINS, isChain, type Chain, type Entry, type Token } from './types.ts';

export type Verdict = 'official' | 'other-chain' | 'impostor' | 'unknown';

export type CheckResult = {
  verdict: Verdict;
  message: string;
  chain: Chain;
  address: string;
  match?: { entry: Entry; token: Token };
  /** For other-chain and impostor: the listed token(s) involved. */
  related: { entry: Entry; token: Token }[];
};

/** A contract written the way the map stores it: Stellar CODE-ISSUER becomes CODE:ISSUER, whitespace goes. */
export function normalize(chain: Chain, address: string): string {
  let a = address.trim();
  if (chain === 'stellar') a = a.replace(/^([A-Za-z0-9]{1,12})-(G[A-Z2-7]{55})$/, '$1:$2');
  return a;
}

const same = (chain: Chain, a: string, b: string) => (CHAINS[chain].caseSensitive ? a === b : a.toLowerCase() === b.toLowerCase());

export function checkContract(entries: Entry[], chainIn: string, addressIn: string, symbol?: string): CheckResult | { error: string } {
  const chainKey = chainIn.trim().toLowerCase();
  if (!isChain(chainKey)) return { error: `Unknown chain "${chainIn}". Chains in the map: ${Object.keys(CHAINS).join(', ')}.` };
  const chain = chainKey;
  const address = normalize(chain, addressIn);
  if (!address) return { error: 'Give the contract address.' };
  const all = entries.flatMap((entry) => entry.tokens.map((token) => ({ entry, token })));

  const hit = all.find((x) => x.token.chain === chain && same(chain, x.token.address, address));
  if (hit) {
    const isinOrFigi = hit.entry.security.isin ? `ISIN ${hit.entry.security.isin}` : hit.entry.security.figi ? `FIGI ${hit.entry.security.figi}` : 'no public ISIN or FIGI';
    return {
      verdict: 'official',
      message: `Official: ${hit.token.symbol} on ${CHAINS[chain].name} is listed by ${hit.entry.security.issuer} for ${hit.entry.security.name} (${isinOrFigi}).`,
      chain, address, match: hit, related: [],
    };
  }
  const elsewhere = all.filter((x) => x.token.chain !== chain && x.token.address.toLowerCase() === address.toLowerCase());
  if (elsewhere.length) {
    return {
      verdict: 'other-chain',
      message: `Not listed on ${CHAINS[chain].name}. This address is the ${elsewhere.map((x) => `${x.token.symbol} contract on ${CHAINS[x.token.chain].name}`).join(' and the ')}; the same address on ${CHAINS[chain].name} is a different contract, which may be anyone's.`,
      chain, address, related: elsewhere,
    };
  }
  const sym = symbol?.trim().toLowerCase();
  const namesake = sym ? all.filter((x) => x.token.chain === chain && x.token.symbol.toLowerCase() === sym) : [];
  if (namesake.length) {
    return {
      verdict: 'impostor',
      message: `Warning: ${namesake[0].entry.security.issuer}'s ${namesake[0].token.symbol} on ${CHAINS[chain].name} is ${namesake.map((x) => x.token.address).join(' or ')}, not this contract. Treat a different contract calling itself ${namesake[0].token.symbol} as an impostor.`,
      chain, address, related: namesake,
    };
  }
  return {
    verdict: 'unknown',
    message: `Not in the map. That says nothing either way: the map lists only contracts that issuers publish themselves, and it doesn't cover every tokenized asset yet.`,
    chain, address, related: [],
  };
}

/** Entries matching a free-text query: issuer, name, symbol, ticker, ISIN, FIGI. */
export function search(entries: Entry[], q: string): Entry[] {
  const s = q.trim().toLowerCase();
  if (!s) return entries;
  return entries.filter((e) =>
    [e.id, e.security.name, e.security.issuer, e.security.ticker, e.security.isin, e.security.figi, ...e.tokens.map((t) => t.symbol)]
      .filter(Boolean)
      .some((v) => v!.toLowerCase().includes(s)),
  );
}
