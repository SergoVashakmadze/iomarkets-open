// Proving an issuer controls its domain: the issuer serves its public key at
//   https://<domain>/.well-known/iomarkets-issuer.json   as   { "issuer": "<id>", "publicKey": "<64 hex>" }
// and IoMarkets fetches it. The fetch follows the same rules as the AI-readiness audit's (aicheck/src/audit.ts fetchSite):
// http or https on the standard ports only, a public host name (no IP literals, no local names), redirects re-checked
// and kept on the same site, 10 s, 2 MB. Nothing else is ever fetched.

import { publicDomain } from './core.ts';

export const WELL_KNOWN = '/.well-known/iomarkets-issuer.json';
const MAX_BYTES = 2 * 1024 * 1024;

export type DomainProof = { ok: boolean; reason: string; url?: string };

/** The URL for a domain's proof file, or why it can't be fetched. */
export function proofUrl(domain: string): URL | { error: string } {
  const d = publicDomain(domain);
  if ('error' in d) return { error: `That is not a public site name (${d.error}).` };
  return new URL(`https://${d.domain}${WELL_KNOWN}`);
}

/** Is a redirect target acceptable: public, standard port, no credentials, and the same site (www. either way)? */
function sameSite(next: URL, domain: string): boolean {
  if (!/^https?:$/.test(next.protocol) || next.username || next.password) return false;
  if (next.port && !['80', '443'].includes(next.port)) return false;
  const h = next.hostname.toLowerCase();
  if ('error' in publicDomain(h)) return false;
  return h === domain || h === `www.${domain}` || `www.${h}` === domain;
}

export async function checkDomainProof(domain: string, issuerId: string, publicKey: string, f: typeof fetch = fetch): Promise<DomainProof> {
  const start = proofUrl(domain);
  if ('error' in start) return { ok: false, reason: start.error };
  const d = start.hostname;
  let url = start;
  for (let hop = 0; hop < 4; hop++) {
    const r = await f(url.toString(), { redirect: 'manual', headers: { 'user-agent': 'IoMarkets-Publisher/1.0 (+https://iomarkets.tech/publish)', accept: 'application/json' }, signal: AbortSignal.timeout(10_000) }).catch(() => null);
    if (!r) return { ok: false, reason: `Could not reach ${url.hostname} (timed out or refused).`, url: start.toString() };
    if (r.status >= 300 && r.status < 400 && r.headers.get('location')) {
      let next: URL;
      try {
        next = new URL(r.headers.get('location')!, url);
      } catch {
        return { ok: false, reason: 'The proof file redirects somewhere that is not an address.', url: start.toString() };
      }
      if (!sameSite(next, d)) return { ok: false, reason: `The proof file redirects to ${next.hostname}, which is not this site. Serve it from ${d} itself.`, url: start.toString() };
      url = next;
      continue;
    }
    if (!r.ok) return { ok: false, reason: `${url.toString()} answered ${r.status}. Serve the proof file there.`, url: start.toString() };
    const len = Number(r.headers.get('content-length') ?? 0);
    if (len > MAX_BYTES) return { ok: false, reason: 'The proof file is larger than 2 MB.', url: start.toString() };
    const text = (await r.text().catch(() => '')).slice(0, MAX_BYTES);
    let j: { issuer?: unknown; publicKey?: unknown; publicKeys?: unknown };
    try {
      j = JSON.parse(text);
    } catch {
      return { ok: false, reason: 'The proof file is not JSON (a site that serves its home page for every path looks like this).', url: start.toString() };
    }
    if (j?.issuer !== issuerId) return { ok: false, reason: `The proof file names issuer "${String(j?.issuer)}", not "${issuerId}".`, url: start.toString() };
    // The file names the key in force (publicKey), and may list older ones too (publicKeys); the key in force must be there.
    const served = [j.publicKey, ...(Array.isArray(j.publicKeys) ? j.publicKeys : [])].filter((k): k is string => typeof k === 'string').map((k) => k.toLowerCase());
    if (!served.includes(publicKey.toLowerCase())) return { ok: false, reason: 'The proof file carries a different public key from the issuer’s current key.', url: start.toString() };
    return { ok: true, reason: `${d} serves this issuer's public key at ${WELL_KNOWN}.`, url: start.toString() };
  }
  return { ok: false, reason: 'Too many redirects.', url: start.toString() };
}

/** The file to host, as text. */
export const wellKnownFile = (issuerId: string, publicKey: string) => JSON.stringify({ issuer: issuerId, publicKey }, null, 2) + '\n';
