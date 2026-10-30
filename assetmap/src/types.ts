// The Tokenized Asset Map's data model. One entry per security (a fund, a share class, or a
// tokenized stock or ETF),
// listing the token contracts that represent it, chain by chain, and where each fact came
// from. Only facts an issuer publishes itself go in: its own web page, its own public API or
// its own stellar.toml for contracts, the issuer for an ISIN, OpenFIGI for a FIGI. No CUSIPs: they
// are licensed. Entries are signed by IoMarkets (sign.ts), and an issuer can sign its own
// (issuer.ts), so trust can come from the issuer rather than from this site.

export type Chain =
  | 'ethereum' | 'polygon' | 'arbitrum' | 'avalanche' | 'base' | 'bnb' | 'mantle' | 'plume' | 'sei' | 'tempo'
  | 'optimism' | 'ink' | 'monad' | 'hyperevm' | 'xlayer'
  | 'solana' | 'stellar' | 'aptos' | 'sui' | 'xrpl' | 'noble' | 'ton' | 'tron';

export type Token = {
  chain: Chain;
  /**
   * The contract as the chain names it: a 0x address on EVM chains, a mint on Solana,
   * CODE:ISSUER on Stellar, a type tag on Aptos and Sui, CURRENCY.ISSUER on the XRP Ledger,
   * a denom on Noble, a user-friendly address on TON, a base58 address on Tron.
   */
  address: string;
  symbol: string;
  /** Which source (index into Entry.sources) lists this contract. */
  source: number;
};

export type Source = {
  url: string;
  publisher: string;
  kind: 'issuer-page' | 'issuer-api' | 'stellar-toml' | 'openfigi';
  /** The day the fact was read from it, YYYY-MM-DD. */
  checked: string;
};

export type Security = {
  name: string;
  issuer: string;
  kind: 'money-market-fund' | 'fund' | 'note' | 'tokenized-stock';
  /** OpenFIGI's FIGI for the security, when it has one. */
  figi?: string;
  /** Only as the issuer gives it. */
  isin?: string;
  ticker?: string;
  /** One sentence on what one token is. */
  token: string;
  /**
   * For a tokenized stock or ETF: the listed security it tracks, by ticker and FIGI (never its
   * US ISIN, which is licensed). The corporate actions feed matches its events to the token by these.
   */
  underlying?: { ticker: string; figi?: string; exchange: string };
};

export type Attestation = { by: string; key: string; sig: string };

export type Entry = {
  id: string;
  security: Security;
  tokens: Token[];
  sources: Source[];
  updated: string;
  /** Signatures over canonical(entry without attestations). */
  attestations: Attestation[];
};

export const CHAINS: Record<Chain, { name: string; evm: boolean; caseSensitive: boolean; explorer?: (a: string) => string }> = {
  ethereum: { name: 'Ethereum', evm: true, caseSensitive: false, explorer: (a) => `https://etherscan.io/token/${a}` },
  polygon: { name: 'Polygon', evm: true, caseSensitive: false, explorer: (a) => `https://polygonscan.com/token/${a}` },
  arbitrum: { name: 'Arbitrum One', evm: true, caseSensitive: false, explorer: (a) => `https://arbiscan.io/token/${a}` },
  avalanche: { name: 'Avalanche C-Chain', evm: true, caseSensitive: false, explorer: (a) => `https://snowtrace.io/token/${a}` },
  base: { name: 'Base', evm: true, caseSensitive: false, explorer: (a) => `https://basescan.org/token/${a}` },
  bnb: { name: 'BNB Smart Chain', evm: true, caseSensitive: false, explorer: (a) => `https://bscscan.com/token/${a}` },
  mantle: { name: 'Mantle', evm: true, caseSensitive: false },
  plume: { name: 'Plume', evm: true, caseSensitive: false },
  sei: { name: 'Sei (EVM)', evm: true, caseSensitive: false },
  tempo: { name: 'Tempo', evm: true, caseSensitive: false },
  optimism: { name: 'OP Mainnet', evm: true, caseSensitive: false, explorer: (a) => `https://optimistic.etherscan.io/token/${a}` },
  ink: { name: 'Ink', evm: true, caseSensitive: false },
  monad: { name: 'Monad', evm: true, caseSensitive: false },
  hyperevm: { name: 'HyperEVM', evm: true, caseSensitive: false },
  xlayer: { name: 'X Layer', evm: true, caseSensitive: false },
  solana: { name: 'Solana', evm: false, caseSensitive: true, explorer: (a) => `https://solscan.io/token/${a}` },
  stellar: { name: 'Stellar', evm: false, caseSensitive: true, explorer: (a) => `https://stellar.expert/explorer/public/asset/${a.replace(':', '-')}` },
  aptos: { name: 'Aptos', evm: false, caseSensitive: false },
  sui: { name: 'Sui', evm: false, caseSensitive: false },
  xrpl: { name: 'XRP Ledger', evm: false, caseSensitive: true },
  noble: { name: 'Noble', evm: false, caseSensitive: true },
  ton: { name: 'TON', evm: false, caseSensitive: true, explorer: (a) => `https://tonviewer.com/${a}` },
  tron: { name: 'Tron', evm: false, caseSensitive: true, explorer: (a) => `https://tronscan.org/#/token20/${a}` },
};

export const isChain = (c: unknown): c is Chain => typeof c === 'string' && Object.prototype.hasOwnProperty.call(CHAINS, c);
