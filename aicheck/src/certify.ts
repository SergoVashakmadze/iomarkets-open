// Agent-API certificates: the result of the agent-readiness check (agentready.ts) on a published API description,
// as a small signed record anyone can verify offline. Pure: it builds, reads and badges certificates; signing with
// the audit key and storage are in functions/api/certify.ts.
//
// What a certificate IS: a statement that, on checked_at, automated checks of the description published at the
// subject's URL gave this score. What it is NOT: a security audit, a penetration test, a review of the API's
// behaviour, or an endorsement of the company. The wording on /certified says so, and so does every certificate.

import type { Result } from './agentready';

export const CERT_SCHEMA = 'iomarkets.agent-api-certificate.v1';
/** Bump when the checks in agentready.ts change in a way that moves scores. */
export const CERT_ENGINE = 'iomarkets-agent-readiness/1';
export const VALID_DAYS = 365;

/** A certificate is 'verified' (and listed publicly) at this score or above... */
export const VERIFIED_MIN_SCORE = 90;
/** ...and only if none of these checks failed: money-moving tools not marked destructive, money-moving calls without an idempotency key. */
export const VERIFIED_MUST_NOT_FAIL = ['NOT_MARKED_DESTRUCTIVE', 'NO_IDEMPOTENCY'] as const;

export type Certificate = {
  schema: typeof CERT_SCHEMA;
  subject: { name: string; url: string | null; kind: 'openapi' | 'mcp' };
  score: number;
  verified: boolean;
  checks: { pass: number; warn: number; fail: number; info: number; failing: string[] };
  checked_at: string;
  expires_at: string;
  engine: string;
  spec_sha256: string;
  disclaimer: string;
};
export type SignedCertificate = Certificate & { id: string; digest: string; key_id: string; sig: string };

export const DISCLAIMER =
  'Automated checks of the published API description only. Not a security audit, a penetration test or a review of how the API behaves, and not an endorsement.';

const hex = (b: ArrayBuffer) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, '0')).join('');
export const sha256Hex = async (s: string) => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));

/** True when the result meets the 'verified' rule: score at least VERIFIED_MIN_SCORE and none of VERIFIED_MUST_NOT_FAIL failing. */
export function isVerified(r: Pick<Result, 'score' | 'issues'>): boolean {
  return r.score >= VERIFIED_MIN_SCORE && !r.issues.some((i) => i.level === 'fail' && (VERIFIED_MUST_NOT_FAIL as readonly string[]).includes(i.code));
}

const clean = (s: string) => s.replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Unnamed API';

export function buildCertificate(r: Result, o: { url: string | null; specSha256: string; now?: Date }): Certificate {
  const now = o.now ?? new Date();
  const count = (l: string) => r.checks.filter((c) => c.level === l).length;
  return {
    schema: CERT_SCHEMA,
    subject: { name: clean(r.title), url: o.url, kind: r.kind },
    score: r.score,
    verified: isVerified(r),
    checks: { pass: count('pass'), warn: count('warn'), fail: count('fail'), info: count('info'), failing: [...new Set(r.issues.filter((i) => i.level === 'fail').map((i) => i.code))].sort() },
    checked_at: now.toISOString(),
    expires_at: new Date(now.getTime() + VALID_DAYS * 86_400_000).toISOString(),
    engine: CERT_ENGINE,
    spec_sha256: o.specSha256,
    disclaimer: DISCLAIMER,
  };
}

/**
 * The text the digest covers: the fields in a fixed order as a JSON array (so no key order can change it).
 * digest = SHA-256 hex of this string; sig = ed25519 over the UTF-8 bytes of the digest, as for the audit log.
 */
export function certificatePreimage(c: Certificate): string {
  return JSON.stringify([c.schema, c.subject.name, c.subject.url, c.subject.kind, c.score, c.verified, c.checks.pass, c.checks.warn, c.checks.fail, c.checks.info, c.checks.failing, c.checked_at, c.expires_at, c.engine, c.spec_sha256]);
}
export const certificateDigest = (c: Certificate) => sha256Hex(certificatePreimage(c));
/** The certificate's id: the first 20 hex characters of its digest. */
export const idOf = (digest: string) => digest.slice(0, 20);

export const isExpired = (c: Pick<Certificate, 'expires_at'>, now = new Date()) => Date.parse(c.expires_at) <= now.getTime();

/** Reads a certificate someone pasted back; null if it is not the right shape. Strict, because it is hashed. */
export function parseCertificate(v: unknown): SignedCertificate | null {
  const o = v as Record<string, any> | null;
  if (!o || typeof o !== 'object' || o.schema !== CERT_SCHEMA) return null;
  const s = o.subject, k = o.checks;
  const ok =
    s && typeof s.name === 'string' && (s.url === null || typeof s.url === 'string') && (s.kind === 'openapi' || s.kind === 'mcp') &&
    Number.isInteger(o.score) && typeof o.verified === 'boolean' &&
    k && [k.pass, k.warn, k.fail, k.info].every(Number.isInteger) && Array.isArray(k.failing) && k.failing.every((x: unknown) => typeof x === 'string') &&
    [o.checked_at, o.expires_at, o.engine, o.spec_sha256, o.digest, o.key_id, o.sig].every((x) => typeof x === 'string');
  return ok ? (o as SignedCertificate) : null;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** A shields-style badge. Expired certificates and ones that did not reach 'verified' say so. */
export function badgeSvg(c: Pick<Certificate, 'score' | 'verified' | 'expires_at'>, now = new Date()): string {
  const right = isExpired(c, now) ? 'expired' : c.verified ? `verified ${c.score}` : `checked ${c.score}`;
  const colour = isExpired(c, now) ? '#6b7280' : c.verified ? '#059669' : '#b45309';
  const left = 'agent-ready';
  const lw = 8 + left.length * 6.2, rw = 8 + right.length * 6.2;
  const w = Math.round(lw + rw);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="20" role="img" aria-label="${esc(left)}: ${esc(right)}"><title>${esc(left)}: ${esc(right)}</title><rect width="${Math.round(lw)}" height="20" fill="#4c1d95"/><rect x="${Math.round(lw)}" width="${w - Math.round(lw)}" height="20" fill="${colour}"/><g fill="#fff" font-family="Verdana,DejaVu Sans,sans-serif" font-size="11" text-anchor="middle"><text x="${Math.round(lw / 2)}" y="14">${esc(left)}</text><text x="${Math.round(lw + (w - lw) / 2)}" y="14">${esc(right)}</text></g></svg>`;
}
