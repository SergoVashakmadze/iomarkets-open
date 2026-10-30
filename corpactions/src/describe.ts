// Plain words for an event, and its tokenized versions in the Asset Map. No event data is
// imported here, so the page can load the feed itself (lazily) and still use these.

import { ENTRIES, type Entry } from '../../assetmap/src/index.ts';
import type { CorporateAction } from './types.ts';

/**
 * Asset Map entries that track this company's stock: its tokenized versions, if any. Matched on
 * the FIGI when both sides have one, else on the ticker of a US-listed underlying.
 */
export const tokenizedVersions = (e: CorporateAction) =>
  ENTRIES.filter((a) => {
    const u = a.security.underlying;
    if (!u) return !!e.company.figi && a.security.figi === e.company.figi;
    if (u.figi && e.company.figi) return u.figi === e.company.figi;
    return !!e.company.ticker && u.ticker === e.company.ticker && /^(?:XNAS|XNYS|ARCX|XASE|BATS)$/.test(u.exchange);
  });

/** Issuers whose tokenized stocks are the shares themselves (their docs: "legal shares of public companies, tokenized onchain"). */
const SHARE_TOKEN_ISSUERS = ['Superstate'];

/** What a corporate action does to a token that tracks the stock, in the issuer's words where it says. */
export function tokenEffect(e: CorporateAction, tokens: Entry[] = []): string {
  // Superstate's tokenized equities are the shares themselves, recorded onchain, not trackers with a multiplier.
  if (tokens.length && tokens.every((a) => SHARE_TOKEN_ISSUERS.includes(a.security.issuer)))
    return 'each token is a share of the stock itself, so the event applies to its holders as to any shareholder';
  if (e.type === 'dividend') return 'the issuer reinvests the dividend, so the token’s multiplier rises around the ex-date';
  if (e.type === 'split' || e.type === 'reverse-split') return `the token’s multiplier moves by ${e.ratio!.new}:${e.ratio!.old} when the split takes effect`;
  return 'the stock stops trading at the merger, and what the token becomes is set by the issuer’s terms';
}

/** One line for a person or an agent: what happens, to whom, when. */
export function describe(e: CorporateAction): string {
  const who = `${e.company.name}${e.company.ticker ? ` (${e.company.ticker})` : ''}`;
  if (e.type === 'dividend')
    return `${who}: ${e.frequency && e.frequency !== 'other' ? `${e.frequency} ` : ''}cash dividend of $${e.cash!.amount} a share; ex-date ${e.dates.ex}${e.exDateRule ? ' (T+1 rule: the record date)' : ''}, record ${e.dates.record}, paid ${e.dates.pay}.`;
  if (e.type === 'split' || e.type === 'reverse-split')
    return `${who}: ${e.type === 'split' ? 'stock split' : 'reverse stock split'}, ${e.ratio!.new} new share${e.ratio!.new === 1 ? '' : 's'} for every ${e.ratio!.old} held, effective ${e.dates.effective}.`;
  const terms = [e.cash ? `$${e.cash.amount} in cash` : '', e.ratio ? `${e.ratio.new} ${e.acquirer ?? 'acquirer'} share${e.ratio.new === 1 ? '' : 's'}` : ''].filter(Boolean).join(' and ');
  return `${who}: acquired${e.acquirer ? ` by ${e.acquirer}` : ''}, effective ${e.dates.effective}; each share became ${terms}.`;
}

/** An event as the API and webhooks send it: with its plain-words summary and its tokenized versions. */
export const eventForApi = (e: CorporateAction) => ({
  ...e,
  summary: describe(e),
  tokenized: tokenizedVersions(e).map((a) => ({ id: a.id, name: a.security.name, symbol: a.security.ticker ?? null, chains: [...new Set(a.tokens.map((t) => t.chain))], effect: tokenEffect(e, [a]) })),
});
