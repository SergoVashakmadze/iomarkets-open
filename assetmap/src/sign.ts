// Signing and checking Asset Map entries. An entry is signed over its canonical form:
// JSON with keys sorted at every level, no spaces, and without its attestations. ed25519,
// with @noble/ed25519's async API (WebCrypto), so the same code runs in Node, Workers and
// the browser.
//
// Keys rotate with an overlap (HANDOVER section 7): ASSET_MAP_KEYS lists the current key
// and the previous one. Entries are signed with the current key; a signature by any listed
// key verifies. Drop the previous key once every entry has been re-signed with the new one.

import * as ed from '@noble/ed25519';
import type { Attestation, Entry } from './types.ts';

export type PublishedKey = { id: string; publicKey: string; status: 'current' | 'previous'; since: string };

/** IoMarkets' Asset Map signing keys (public halves). The private key never enters this repo. */
export const ASSET_MAP_KEYS: PublishedKey[] = [
  { id: 'iomarkets-assetmap-2026-10', publicKey: 'f58d9460c379c4550fabd29da24d812f5fa5ad46a2bd6d6b36446caf3cde6e58', status: 'current', since: '2026-10-29' },
];

export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

/** The bytes an attestation signs. */
export const signedBytes = (e: Entry) => new TextEncoder().encode(canonical({ ...e, attestations: undefined }));

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const unhex = (h: string) => {
  if (!/^(?:[0-9a-f]{2})+$/i.test(h)) throw new Error('not hex');
  return Uint8Array.from(h.match(/.{2}/g)!.map((x) => parseInt(x, 16)));
};

export async function publicKeyOf(privateKeyHex: string): Promise<string> {
  return hex(await ed.getPublicKeyAsync(unhex(privateKeyHex)));
}

export async function signEntry(e: Entry, privateKeyHex: string, keyId: string, by = 'IoMarkets'): Promise<Attestation> {
  return { by, key: keyId, sig: hex(await ed.signAsync(signedBytes(e), unhex(privateKeyHex))) };
}

export type AttestationCheck = { by: string; key: string; ok: boolean; reason: string };

/** Check every attestation on an entry against the published keys (or the keys given). */
export async function checkAttestations(e: Entry, keys: PublishedKey[] = ASSET_MAP_KEYS): Promise<AttestationCheck[]> {
  const msg = signedBytes(e);
  return Promise.all(
    e.attestations.map(async (a) => {
      const k = keys.find((x) => x.id === a.key);
      if (!k) return { by: a.by, key: a.key, ok: false, reason: `key ${a.key} is not a published Asset Map key` };
      try {
        const ok = await ed.verifyAsync(unhex(a.sig), msg, unhex(k.publicKey));
        return { by: a.by, key: a.key, ok, reason: ok ? `signed by ${a.by} (${k.status} key)` : 'the signature does not match the entry: it was changed after signing' };
      } catch {
        return { by: a.by, key: a.key, ok: false, reason: 'the signature is malformed' };
      }
    }),
  );
}
