// Checking an entry against the issuer itself, live, so trust needn't rest on this site.
//
// 1. Stellar (SEP-1): an issuer lists its assets in https://<its domain>/.well-known/stellar.toml.
//    For each Stellar token in an entry whose source is a stellar.toml, fetch that file and
//    confirm the code and issuer account are in its [[CURRENCIES]].
// 2. Any chain: the issuer's own contracts page (or its public API's answer) is fetched and must
//    contain the address.
//
// Issuers can also sign their own entries: publish an ed25519 public key at
// https://<issuer domain>/.well-known/iomarkets-asset-map.json as { "keys": [{ "id", "publicKey" }] }
// and add an attestation with that key id. checkIssuerSignature verifies it. No issuer
// has published one yet (2026-10-29); the format is in assetmap/README.md.

import * as ed from '@noble/ed25519';
import { signedBytes } from './sign.ts';
import type { Entry } from './types.ts';

export type Fetcher = (url: string) => Promise<string | null>;

export type IssuerCheck = { token: string; url: string; ok: boolean | null; reason: string };

/** The [[CURRENCIES]] code/issuer pairs in a stellar.toml. Enough of TOML for SEP-1. */
export function stellarCurrencies(toml: string): { code: string; issuer: string }[] {
  const out: { code: string; issuer: string }[] = [];
  for (const block of toml.split(/^\s*\[\[CURRENCIES\]\]\s*$/m).slice(1)) {
    const body = block.split(/^\s*\[/m)[0];
    const get = (k: string) => new RegExp(`^\\s*${k}\\s*=\\s*"([^"]*)"`, 'm').exec(body)?.[1];
    const code = get('code'), issuer = get('issuer');
    if (code && issuer) out.push({ code, issuer });
  }
  return out;
}

/** Check each token of an entry against the issuer source it cites. ok null = couldn't fetch. */
export async function checkWithIssuer(e: Entry, fetchText: Fetcher): Promise<IssuerCheck[]> {
  const pages = new Map<string, Promise<string | null>>();
  const page = (url: string) => {
    if (!pages.has(url)) pages.set(url, fetchText(url).catch(() => null));
    return pages.get(url)!;
  };
  const results: IssuerCheck[] = [];
  for (const t of e.tokens) {
    const src = e.sources[t.source];
    const label = `${t.symbol} on ${t.chain}`;
    if (!src || src.kind === 'openfigi') {
      results.push({ token: label, url: src?.url ?? '', ok: false, reason: 'no issuer source cited' });
      continue;
    }
    const text = await page(src.url);
    if (text === null) {
      results.push({ token: label, url: src.url, ok: null, reason: 'the issuer page could not be fetched just now' });
      continue;
    }
    if (src.kind === 'stellar-toml' && t.chain === 'stellar') {
      const [code, issuer] = t.address.split(':');
      const listed = stellarCurrencies(text).some((c) => c.code === code && c.issuer === issuer);
      results.push({ token: label, url: src.url, ok: listed, reason: listed ? `listed in ${new URL(src.url).hostname}'s stellar.toml` : `not in ${new URL(src.url).hostname}'s stellar.toml` });
      continue;
    }
    // A contract may be written in another case, or Stellar as CODE-ISSUER, on the page.
    const needles = [t.address, t.address.toLowerCase(), t.address.replace(':', '-')];
    const hay = text.toLowerCase();
    const found = needles.some((n) => hay.includes(n.toLowerCase())) || (t.chain === 'stellar' && t.address.includes(':') && hay.includes(t.address.split(':')[1].toLowerCase()));
    results.push({ token: label, url: src.url, ok: found, reason: found ? `found on ${new URL(src.url).hostname}` : `not found on ${new URL(src.url).hostname} (the page may load it with JavaScript, or it changed)` });
  }
  return results;
}

/** Verify an issuer's own attestation against the key it publishes on its domain. */
export async function checkIssuerSignature(e: Entry, issuerDomain: string, fetchText: Fetcher): Promise<{ ok: boolean; reason: string }> {
  const raw = await fetchText(`https://${issuerDomain}/.well-known/iomarkets-asset-map.json`).catch(() => null);
  if (!raw) return { ok: false, reason: `${issuerDomain} publishes no Asset Map key` };
  let keys: { id: string; publicKey: string }[] = [];
  try {
    keys = (JSON.parse(raw) as { keys?: { id: string; publicKey: string }[] }).keys ?? [];
  } catch {
    return { ok: false, reason: `${issuerDomain}'s key file is not valid JSON` };
  }
  for (const a of e.attestations) {
    const k = keys.find((x) => x.id === a.key);
    if (!k) continue;
    try {
      const unhex = (h: string) => Uint8Array.from(h.match(/.{2}/g)!.map((x) => parseInt(x, 16)));
      if (await ed.verifyAsync(unhex(a.sig), signedBytes(e), unhex(k.publicKey))) return { ok: true, reason: `signed by ${issuerDomain} (key ${k.id})` };
    } catch {
      // malformed: try the next attestation
    }
  }
  return { ok: false, reason: `no attestation on this entry verifies with ${issuerDomain}'s keys` };
}
