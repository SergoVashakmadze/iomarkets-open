// The Notice Publisher's core: an issuer's signed, hash-chained publication of its own corporate action notices and
// token contract facts. Pure and dependency-light (only @noble/ed25519, WebCrypto): the same code runs in Node, Workers
// and the browser, and the browser page signs and verifies with it.
//
// Trust model (the same as the Tokenized Asset Map's): the ISSUER signs, IoMarkets only hosts and verifies. A record is
// signed over its canonical form (keys sorted at every level, no spaces) with the issuer's ed25519 key. Records form a
// chain per issuer: seq 1, 2, 3 ... and each names the SHA-256 of the one before it (prev), so an amendment or a
// retraction is a new entry in a visible history, never a silent edit of an old one.

import * as ed from '@noble/ed25519';

export const FORMAT = 'iomarkets-issuer-publication/1';
export const NOTICE_SCHEMA = 'https://iomarkets.org/formats/corporate-action-notice.v1.schema.json';
export const NOTICE_NS = 'https://iomarkets.org/formats/corporate-action-notice#';
export const NOTICE_CONTEXT = ['https://schema.org', { ioca: NOTICE_NS, CorporateActionNotice: 'ioca:CorporateActionNotice' }] as const;

/** Caps that keep any one issuer's chain (and a request) bounded. */
export const CAPS = { entries: 20, recordBytes: 32_000, records: 200, reason: 500, name: 120 } as const;

export type Notice = Record<string, unknown>;
export type Contract = { chain: string; address: string; symbol?: string; name?: string; isin?: string };
export type Entry = {
  /** The issuer's own id for this item, unique within its chain: 'q3-2026-dividend'. */
  id: string;
  action: 'publish' | 'amend' | 'retract';
  /** For amend and retract: the id of the active item this replaces or withdraws. */
  target?: string;
  reason?: string;
  notice?: Notice;
  contract?: Contract;
};
export type Registration = { v: 1; id: string; name: string; domain: string; publicKey: string; ticker?: string; isin?: string; figi?: string };
/**
 * A key rotation, carried by a record of its own (no entries). The record is signed by the key in force (sig) AND by the new
 * key (sig2), so neither a stolen old key nor a typo'd new key can rotate alone. Records from seq `effectiveFrom` (always the
 * record's own seq + 1) are signed with the new key. `compromisedAfterSeq` (optional) also declares the old key compromised:
 * its records after that seq stay in the history but are shown as untrusted.
 */
export type Rotation = { newKey: string; effectiveFrom: number; compromisedAfterSeq?: number; reason?: string };
export type PublicationRecord = { v: 1; issuer: string; seq: number; prev: string | null; published: string; entries: Entry[]; rotation?: Rotation };
export type SignedRecord = { record: PublicationRecord; sig: string; /** On a rotation record: the new key's signature (tagged separately). */ sig2?: string };
/** A key and the records it signs: from its first seq to `to` (inclusive; open while it is the current key). */
export type KeyPeriod = { publicKey: string; from: number; to?: number; revoked?: boolean };
export type Revocation = { key: string; afterSeq: number; atSeq: number; reason: string };
export type SignedRegistration = { registration: Registration; sig: string };

export type StateItem = {
  id: string;
  kind: 'notice' | 'contract';
  status: 'active' | 'amended' | 'retracted';
  seq: number;
  published: string;
  notice?: Notice;
  contract?: Contract;
  /** The item that replaced this one (amended) or the retraction (retracted). */
  supersededBy?: string;
  /** On an amendment: the item it replaced. On a retraction entry: the item it withdrew. */
  amends?: string;
  retracts?: string;
  reason?: string;
  /** Signed with a key the issuer later declared compromised, after the seq it named. Kept in the history, not to be relied on. */
  untrusted?: boolean;
};

// ---- canonical form, hex, hashing ---------------------------------------------------------------

export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

export const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
export function fromHex(h: string): Uint8Array {
  if (typeof h !== 'string' || !/^(?:[0-9a-f]{2})+$/i.test(h)) throw new Error('not hex');
  return Uint8Array.from(h.match(/.{2}/g)!.map((x) => parseInt(x, 16)));
}
const bytes = (s: string) => new TextEncoder().encode(s);

export async function sha256Hex(s: string): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes(s))));
}
/** The hash a later record names as its prev. */
export const recordHash = (r: PublicationRecord) => sha256Hex(canonical(r));

// ---- keys and signatures ------------------------------------------------------------------------

export async function generateKeypair(): Promise<{ privateKey: string; publicKey: string }> {
  const sk = ed.utils.randomSecretKey();
  return { privateKey: toHex(sk), publicKey: toHex(await ed.getPublicKeyAsync(sk)) };
}
export async function publicKeyOf(privateKeyHex: string): Promise<string> {
  return toHex(await ed.getPublicKeyAsync(fromHex(privateKeyHex)));
}

// A tag per kind of signed object, so a signature on one can never pass as another.
const TAG = { record: `${FORMAT}/record\n`, registration: `${FORMAT}/registration\n`, rotation: `${FORMAT}/rotation-accept\n` } as const;
const message = (kind: keyof typeof TAG, o: unknown) => bytes(TAG[kind] + canonical(o));

export async function signRecord(record: PublicationRecord, privateKeyHex: string): Promise<SignedRecord> {
  return { record, sig: toHex(await ed.signAsync(message('record', record), fromHex(privateKeyHex))) };
}
/** A rotation record signed by the old key (sig) and accepted by the new key (sig2). */
export async function signRotation(record: PublicationRecord, oldPrivateKey: string, newPrivateKey: string): Promise<SignedRecord> {
  return { record, sig: toHex(await ed.signAsync(message('record', record), fromHex(oldPrivateKey))), sig2: toHex(await ed.signAsync(message('rotation', record), fromHex(newPrivateKey))) };
}
export async function signRegistration(registration: Registration, privateKeyHex: string): Promise<SignedRegistration> {
  return { registration, sig: toHex(await ed.signAsync(message('registration', registration), fromHex(privateKeyHex))) };
}
async function verify(kind: keyof typeof TAG, o: unknown, sig: string, publicKey: string): Promise<boolean> {
  try {
    return await ed.verifyAsync(fromHex(sig), message(kind, o), fromHex(publicKey));
  } catch {
    return false;
  }
}
export const verifyRecord = (s: SignedRecord, publicKey: string) => verify('record', s.record, s.sig, publicKey);
/** The new key's acceptance on a rotation record. */
export const verifyRotationAccept = (s: SignedRecord) => (s.record.rotation && s.sig2 ? verify('rotation', s.record, s.sig2, s.record.rotation.newKey) : Promise.resolve(false));
export const verifyRegistration = (s: SignedRegistration) => verify('registration', s.registration, s.sig, s.registration.publicKey);

// ---- validation ---------------------------------------------------------------------------------

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
export const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const allowed = (o: Record<string, unknown>, keys: string[], where: string, errs: string[]) => {
  for (const k of Object.keys(o)) if (!keys.includes(k)) errs.push(`${where}: unexpected field "${k}"`);
};

/** A notice against formats/corporate-action-notice.v1.schema.json (hand-checked, so there is no validator to ship). */
export function validateNotice(n: unknown, where = 'notice'): string[] {
  const e: string[] = [];
  if (!isObj(n)) return [`${where}: must be an object`];
  const keys = ['@context', '@type', 'conformsTo', 'eventType', 'isoEventCode', 'issuer', 'security', 'announced', 'exDate', 'recordDate', 'paymentDate', 'effectiveDate', 'cash', 'ratio', 'frequency', 'acquirer', 'source'];
  allowed(n, keys, where, e);
  for (const k of ['@context', '@type', 'conformsTo', 'eventType', 'isoEventCode', 'issuer', 'announced']) if (n[k] === undefined) e.push(`${where}: "${k}" is required`);
  if (n['@context'] !== undefined && (!Array.isArray(n['@context']) || n['@context'].length < 2)) e.push(`${where}: "@context" must be ["https://schema.org", {ioca…}]`);
  if (n['@type'] !== undefined && n['@type'] !== 'CorporateActionNotice') e.push(`${where}: "@type" must be "CorporateActionNotice"`);
  if (n.conformsTo !== undefined && n.conformsTo !== NOTICE_SCHEMA) e.push(`${where}: "conformsTo" must be ${NOTICE_SCHEMA}`);
  const types: Record<string, string> = { dividend: 'DVCA', split: 'SPLF', 'reverse-split': 'SPLR', merger: 'MRGR' };
  if (n.eventType !== undefined && !(typeof n.eventType === 'string' && n.eventType in types)) e.push(`${where}: "eventType" must be dividend, split, reverse-split or merger`);
  else if (n.isoEventCode !== undefined && typeof n.eventType === 'string' && types[n.eventType] !== n.isoEventCode) e.push(`${where}: "isoEventCode" must be ${types[n.eventType]} for ${n.eventType}`);
  else if (n.isoEventCode !== undefined && !Object.values(types).includes(n.isoEventCode as string)) e.push(`${where}: "isoEventCode" must be DVCA, SPLF, SPLR or MRGR`);
  if (n.issuer !== undefined) {
    const i = n.issuer;
    if (!isObj(i)) e.push(`${where}.issuer: must be an object`);
    else {
      allowed(i, ['@type', 'name', 'tickerSymbol', 'identifier'], `${where}.issuer`, e);
      if (i['@type'] !== 'Corporation') e.push(`${where}.issuer: "@type" must be "Corporation"`);
      if (typeof i.name !== 'string' || !i.name.trim()) e.push(`${where}.issuer: "name" is required`);
      if (i.tickerSymbol !== undefined && (typeof i.tickerSymbol !== 'string' || !i.tickerSymbol)) e.push(`${where}.issuer: "tickerSymbol" must be text`);
      if (i.identifier !== undefined) {
        const d = i.identifier;
        if (!isObj(d) || d['@type'] !== 'PropertyValue' || d.propertyID !== 'SEC CIK' || typeof d.value !== 'string' || !/^\d{10}$/.test(d.value)) e.push(`${where}.issuer: "identifier" must be {"@type":"PropertyValue","propertyID":"SEC CIK","value":"<10 digits>"}`);
      }
    }
  }
  if (n.security !== undefined) {
    const s = n.security;
    if (!isObj(s)) e.push(`${where}.security: must be an object`);
    else {
      allowed(s, ['figi', 'ticker', 'instrument'], `${where}.security`, e);
      if (s.figi !== undefined && !(typeof s.figi === 'string' && /^BBG[0-9A-Z]{9}$/.test(s.figi))) e.push(`${where}.security: "figi" must look like BBG000B9XRY4`);
      if (s.ticker !== undefined && (typeof s.ticker !== 'string' || !s.ticker)) e.push(`${where}.security: "ticker" must be text`);
      if (s.instrument !== undefined && s.instrument !== 'ADS') e.push(`${where}.security: "instrument" can only be "ADS"`);
    }
  }
  for (const k of ['announced', 'exDate', 'recordDate', 'paymentDate', 'effectiveDate']) {
    if (n[k] !== undefined && !(typeof n[k] === 'string' && DATE.test(n[k] as string) && !Number.isNaN(Date.parse(`${n[k]}T00:00:00Z`)))) e.push(`${where}: "${k}" must be a date, YYYY-MM-DD`);
  }
  if (n.cash !== undefined) {
    const c = n.cash;
    if (!isObj(c)) e.push(`${where}.cash: must be an object`);
    else {
      allowed(c, ['amount', 'currency'], `${where}.cash`, e);
      if (typeof c.amount !== 'string' || !/^\d+(\.\d+)?$/.test(c.amount)) e.push(`${where}.cash: "amount" must be a decimal string such as "0.27"`);
      if (typeof c.currency !== 'string' || !/^[A-Z]{3}$/.test(c.currency)) e.push(`${where}.cash: "currency" must be an ISO 4217 code such as USD`);
    }
  }
  if (n.ratio !== undefined) {
    const r = n.ratio;
    if (!isObj(r)) e.push(`${where}.ratio: must be an object`);
    else {
      allowed(r, ['new', 'old'], `${where}.ratio`, e);
      for (const k of ['new', 'old']) if (typeof r[k] !== 'number' || !(r[k] as number > 0) || !Number.isFinite(r[k])) e.push(`${where}.ratio: "${k}" must be a number above 0`);
    }
  }
  if (n.frequency !== undefined && !['monthly', 'quarterly', 'semi-annual', 'annual', 'special', 'other'].includes(n.frequency as string)) e.push(`${where}: "frequency" must be monthly, quarterly, semi-annual, annual, special or other`);
  if (n.acquirer !== undefined && (typeof n.acquirer !== 'string' || !n.acquirer)) e.push(`${where}: "acquirer" must be text`);
  if (n.source !== undefined && !(typeof n.source === 'string' && /^https:\/\//.test(n.source))) e.push(`${where}: "source" must be an https:// link`);
  return e;
}

const isin = (s: string) => /^[A-Z]{2}[A-Z0-9]{9}\d$/.test(s);
export function validateContract(c: unknown, where = 'contract'): string[] {
  const e: string[] = [];
  if (!isObj(c)) return [`${where}: must be an object`];
  allowed(c, ['chain', 'address', 'symbol', 'name', 'isin'], where, e);
  if (typeof c.chain !== 'string' || !/^[a-z0-9-]{2,32}$/.test(c.chain)) e.push(`${where}: "chain" must be a lower-case chain name such as ethereum`);
  if (typeof c.address !== 'string' || !/^[A-Za-z0-9:._-]{4,120}$/.test(c.address)) e.push(`${where}: "address" must be the contract address (4-120 letters, digits, : . _ -)`);
  for (const k of ['symbol', 'name'] as const) if (c[k] !== undefined && (typeof c[k] !== 'string' || !(c[k] as string) || (c[k] as string).length > CAPS.name)) e.push(`${where}: "${k}" must be text up to ${CAPS.name} characters`);
  if (c.isin !== undefined && !(typeof c.isin === 'string' && isin(c.isin))) e.push(`${where}: "isin" must be 12 characters such as US0378331005`);
  return e;
}

export function validateRegistration(r: unknown): string[] {
  const e: string[] = [];
  if (!isObj(r)) return ['registration must be an object'];
  allowed(r, ['v', 'id', 'name', 'domain', 'publicKey', 'ticker', 'isin', 'figi'], 'registration', e);
  if (r.v !== 1) e.push('registration: "v" must be 1');
  if (typeof r.id !== 'string' || !/^[a-z0-9][a-z0-9-]{1,39}$/.test(r.id)) e.push('registration: "id" must be 2-40 lower-case letters, digits or hyphens (it is your public URL: /issuer/<id>)');
  if (typeof r.name === 'string' && /[\u0000-\u001f\u007f]/.test(r.name)) e.push('registration: "name" cannot contain control characters or line breaks');
  if (typeof r.name !== 'string' || !r.name.trim() || r.name.length > CAPS.name) e.push(`registration: "name" is required (up to ${CAPS.name} characters)`);
  if (typeof r.domain !== 'string' || 'error' in publicDomain(r.domain)) e.push(`registration: "domain" must be your public site's name, such as investor.example.com (${typeof r.domain === 'string' ? (publicDomain(r.domain) as { error?: string }).error : 'required'})`);
  if (typeof r.publicKey !== 'string' || !/^[0-9a-f]{64}$/i.test(r.publicKey)) e.push('registration: "publicKey" must be 64 hex characters (an ed25519 public key)');
  if (r.ticker !== undefined && (typeof r.ticker !== 'string' || !/^[A-Za-z0-9.\-]{1,12}$/.test(r.ticker))) e.push('registration: "ticker" must be 1-12 letters, digits, . or -');
  if (r.isin !== undefined && !(typeof r.isin === 'string' && isin(r.isin))) e.push('registration: "isin" must be 12 characters such as US0378331005');
  if (r.figi !== undefined && !(typeof r.figi === 'string' && /^BBG[0-9A-Z]{9}$/.test(r.figi))) e.push('registration: "figi" must look like BBG000B9XRY4');
  return e;
}

/** A bare public host name: lower-case, a dot in it, no IP literal, no scheme, no path, no local TLD. */
export function publicDomain(raw: string): { domain: string } | { error: string } {
  const d = raw.trim().toLowerCase();
  if (!d || d.length > 253) return { error: 'give the site name' };
  if (/[/:@?#\s]/.test(d)) return { error: 'the name only, without https://, a path or a port' };
  if (/^[\d.]+$/.test(d) || d.includes('[')) return { error: 'not an IP address' };
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/.test(d)) return { error: 'not a valid public name' };
  if (/(^|\.)(localhost|local|internal|lan|home|arpa|test|invalid|example)$/.test(d) && !/(^|\.)example\.(com|org|net)$/.test(d)) return { error: 'not a public name' };
  return { domain: d };
}

export function validateRecord(r: unknown): string[] {
  const e: string[] = [];
  if (!isObj(r)) return ['record must be an object'];
  allowed(r, ['v', 'issuer', 'seq', 'prev', 'published', 'entries', 'rotation'], 'record', e);
  if (r.v !== 1) e.push('record: "v" must be 1');
  if (typeof r.issuer !== 'string' || !r.issuer) e.push('record: "issuer" is required');
  if (!Number.isInteger(r.seq) || (r.seq as number) < 1) e.push('record: "seq" must be a whole number from 1');
  if (r.prev !== null && !(typeof r.prev === 'string' && /^[0-9a-f]{64}$/.test(r.prev))) e.push('record: "prev" must be null for the first record, else the previous record\'s hash');
  if (r.seq === 1 && r.prev !== null) e.push('record: the first record has "prev": null');
  if (typeof r.seq === 'number' && r.seq > 1 && r.prev === null) e.push('record: "prev" is required after the first record');
  if (typeof r.published !== 'string' || !STAMP.test(r.published) || Number.isNaN(Date.parse(r.published))) e.push('record: "published" must be a UTC time such as 2026-12-01T09:30:00Z');
  const rot = r.rotation;
  if (rot !== undefined) {
    if (!isObj(rot)) e.push('record.rotation: must be an object');
    else {
      allowed(rot, ['newKey', 'effectiveFrom', 'compromisedAfterSeq', 'reason'], 'record.rotation', e);
      if (typeof rot.newKey !== 'string' || !/^[0-9a-f]{64}$/.test(rot.newKey)) e.push('record.rotation: "newKey" must be 64 lower-case hex characters (an ed25519 public key)');
      if (typeof r.seq === 'number' && rot.effectiveFrom !== r.seq + 1) e.push('record.rotation: "effectiveFrom" must be this record\'s seq + 1: the next record is the first signed with the new key');
      if (rot.reason !== undefined && (typeof rot.reason !== 'string' || rot.reason.length > CAPS.reason)) e.push(`record.rotation: "reason" must be text up to ${CAPS.reason} characters`);
      if (rot.compromisedAfterSeq !== undefined) {
        if (!Number.isInteger(rot.compromisedAfterSeq) || (rot.compromisedAfterSeq as number) < 0 || (typeof r.seq === 'number' && (rot.compromisedAfterSeq as number) >= r.seq)) e.push('record.rotation: "compromisedAfterSeq" must be a whole number from 0 below this record\'s seq (records after it are marked untrusted)');
        if (typeof rot.reason !== 'string' || !rot.reason.trim()) e.push('record.rotation: declaring a key compromised needs a "reason"');
      }
    }
    if (!Array.isArray(r.entries) || r.entries.length) e.push('record: a rotation record carries no entries; publish them in the next record');
  } else if (!Array.isArray(r.entries) || r.entries.length < 1) e.push('record: "entries" needs at least one entry');
  else if (r.entries.length > CAPS.entries) e.push(`record: at most ${CAPS.entries} entries per record`);
  else {
    const seen = new Set<string>();
    r.entries.forEach((x: unknown, i: number) => {
      const w = `entries[${i}]`;
      if (!isObj(x)) return void e.push(`${w}: must be an object`);
      allowed(x, ['id', 'action', 'target', 'reason', 'notice', 'contract'], w, e);
      if (typeof x.id !== 'string' || !ID_RE.test(x.id)) e.push(`${w}: "id" must be 1-64 lower-case letters, digits, . _ - (starting with a letter or digit)`);
      else if (seen.has(x.id)) e.push(`${w}: id "${x.id}" is used twice in this record`);
      else seen.add(x.id);
      if (!['publish', 'amend', 'retract'].includes(x.action as string)) return void e.push(`${w}: "action" must be publish, amend or retract`);
      if (x.reason !== undefined && (typeof x.reason !== 'string' || x.reason.length > CAPS.reason)) e.push(`${w}: "reason" must be text up to ${CAPS.reason} characters`);
      if (x.action === 'publish') {
        if (x.target !== undefined) e.push(`${w}: a publish has no "target"`);
      } else if (typeof x.target !== 'string' || !ID_RE.test(x.target)) e.push(`${w}: ${x.action} needs "target", the id of the item it ${x.action === 'amend' ? 'replaces' : 'withdraws'}`);
      else if (x.target === x.id) e.push(`${w}: "target" cannot be the entry's own id`);
      if (x.action === 'retract') {
        if (x.notice !== undefined || x.contract !== undefined) e.push(`${w}: a retraction carries no notice or contract; say why in "reason"`);
        if (typeof x.reason !== 'string' || !x.reason.trim()) e.push(`${w}: a retraction needs a "reason"`);
      } else if ((x.notice === undefined) === (x.contract === undefined)) e.push(`${w}: give either "notice" or "contract", not both or neither`);
      else if (x.notice !== undefined) e.push(...validateNotice(x.notice, `${w}.notice`));
      else e.push(...validateContract(x.contract, `${w}.contract`));
    });
  }
  return e;
}

// ---- the chain ----------------------------------------------------------------------------------

export type Head = { seq: number; hash: string; published: string };

/** The state of an issuer's items after the records so far. Nothing is deleted: amended and retracted items stay, marked. */
export type State = { items: StateItem[]; head: Head | null; /** Every key the chain has used, in order; the last is the one that signs the next record. Empty only if the root key was not given. */ keys: KeyPeriod[]; revocations: Revocation[] };
export const emptyState = (rootKey?: string): State => ({ items: [], head: null, keys: rootKey ? [{ publicKey: rootKey.toLowerCase(), from: 1 }] : [], revocations: [] });
/** The key that must sign the next record. */
export const currentKey = (s: State): string | null => s.keys[s.keys.length - 1]?.publicKey ?? null;
/** The key that signs the record at a given seq (a rotation record is signed by the key it retires). */
export const keyAtSeq = (keys: KeyPeriod[], seq: number): string | null => [...keys].reverse().find((k) => k.from <= seq)?.publicKey ?? null;

/** Apply one valid record to a state, or say why it can't follow. Mutates nothing: returns the new state. */
export function applyRecord(s: State, r: PublicationRecord, hash: string): { state: State } | { error: string } {
  if (s.head ? r.seq !== s.head.seq + 1 : r.seq !== 1) return { error: `wrong sequence number: the next record is ${s.head ? s.head.seq + 1 : 1}, not ${r.seq}` };
  if ((s.head?.hash ?? null) !== r.prev) return { error: 'prev does not match the hash of the last record: the chain would fork or a record is being replayed' };
  if (s.head && r.published < s.head.published) return { error: 'published goes backwards: it must not be earlier than the previous record' };
  const items = s.items.map((i) => ({ ...i }));
  const byId = new Map(items.map((i) => [i.id, i]));
  for (const x of r.entries) {
    if (byId.has(x.id)) return { error: `id "${x.id}" was already used: ids are never reused` };
    if (x.action !== 'publish') {
      const t = byId.get(x.target!);
      if (!t) return { error: `target "${x.target}" is not an item of this issuer` };
      if (t.status !== 'active') return { error: `target "${x.target}" is already ${t.status}` };
      t.status = x.action === 'amend' ? 'amended' : 'retracted';
      t.supersededBy = x.id;
      if (x.reason) t.reason = x.reason;
    }
    const item: StateItem = { id: x.id, kind: x.contract ? 'contract' : 'notice', status: x.action === 'retract' ? 'retracted' : 'active', seq: r.seq, published: r.published };
    if (x.action === 'retract') {
      // The retraction itself is shown as an item so the history reads in order; it points at what it withdrew.
      item.kind = byId.get(x.target!)!.kind;
      item.reason = x.reason;
      item.retracts = x.target;
    } else {
      if (x.notice) item.notice = x.notice;
      if (x.contract) item.contract = x.contract;
      if (x.reason) item.reason = x.reason;
      if (x.action === 'amend') item.amends = x.target;
    }
    items.push(item);
    byId.set(x.id, item);
  }
  let keys = s.keys;
  let revocations = s.revocations;
  if (r.rotation) {
    const cur = keys[keys.length - 1];
    const nk = r.rotation.newKey;
    if (keys.some((k) => k.publicKey === nk)) return { error: 'the new key was already used by this issuer: a rotation needs a fresh key' };
    const ca = r.rotation.compromisedAfterSeq;
    if (ca !== undefined) {
      if (cur && ca < cur.from - 1) return { error: `compromisedAfterSeq ${ca} reaches back before the key in force began (record ${cur.from}); only that key's own records can be marked` };
      for (const i of items) if (i.seq > ca) i.untrusted = true;
      revocations = [...revocations, { key: cur?.publicKey ?? '', afterSeq: ca, atSeq: r.seq, reason: r.rotation.reason! }];
    }
    keys = [...keys.slice(0, -1), ...(cur ? [{ ...cur, to: r.seq, ...(ca !== undefined ? { revoked: true } : {}) }] : []), { publicKey: nk, from: r.seq + 1 }];
  }
  return { state: { items, head: { seq: r.seq, hash, published: r.published }, keys, revocations } };
}

export type ChainResult = { ok: true; state: State } | { ok: false; error: string; at?: number };

/**
 * Re-check a whole chain from scratch: signatures, sequence, prev links, validity and the amend/retract rules. `publicKey` is
 * the key the issuer registered with (the root); later keys come from the signed rotation records in the chain, each checked
 * against the key in force at its seq and, for the rotation record itself, against the new key too.
 */
export async function verifyChain(issuerId: string, publicKey: string, chain: SignedRecord[]): Promise<ChainResult> {
  let state = emptyState(publicKey);
  for (let i = 0; i < chain.length; i++) {
    const { record, sig, sig2 } = chain[i];
    const bad = (error: string): ChainResult => ({ ok: false, error: `record ${i + 1}: ${error}`, at: i + 1 });
    if (record?.issuer !== issuerId) return bad(`belongs to "${String(record?.issuer)}", not "${issuerId}"`);
    const errs = validateRecord(record);
    if (errs.length) return bad(errs[0]);
    if (!(await verifyRecord({ record, sig }, currentKey(state)!))) return bad('the signature does not match: the record was changed after signing, or it was signed with a key that was not the issuer\'s key at this point in the chain');
    if (record.rotation) {
      if (!(await verifyRotationAccept({ record, sig, sig2 }))) return bad('a key rotation must be signed by both the old key and the new key; the new key\'s signature is missing or wrong');
    } else if (sig2 !== undefined) return bad('only a rotation record carries a second signature');
    const next = applyRecord(state, record, await recordHash(record));
    if ('error' in next) return bad(next.error);
    state = next.state;
  }
  return { ok: true, state };
}

// ---- building ------------------------------------------------------------------------------------

/** A notice in the open format from plain fields (what the /publish form does). */
export function buildNotice(f: {
  issuerName: string; ticker?: string; cik?: string; figi?: string; eventType: 'dividend' | 'split' | 'reverse-split' | 'merger';
  announced: string; exDate?: string; recordDate?: string; paymentDate?: string; effectiveDate?: string;
  amount?: string; currency?: string; ratioNew?: number; ratioOld?: number; frequency?: string; acquirer?: string; source?: string;
}): Notice {
  const code = { dividend: 'DVCA', split: 'SPLF', 'reverse-split': 'SPLR', merger: 'MRGR' }[f.eventType];
  const n: Notice = {
    '@context': NOTICE_CONTEXT, '@type': 'CorporateActionNotice', conformsTo: NOTICE_SCHEMA, eventType: f.eventType, isoEventCode: code,
    issuer: { '@type': 'Corporation', name: f.issuerName, ...(f.ticker ? { tickerSymbol: f.ticker } : {}), ...(f.cik ? { identifier: { '@type': 'PropertyValue', propertyID: 'SEC CIK', value: f.cik } } : {}) },
    announced: f.announced,
  };
  if (f.figi || f.ticker) n.security = { ...(f.figi ? { figi: f.figi } : {}), ...(f.ticker ? { ticker: f.ticker } : {}) };
  for (const k of ['exDate', 'recordDate', 'paymentDate', 'effectiveDate'] as const) if (f[k]) n[k] = f[k];
  if (f.amount && f.currency) n.cash = { amount: f.amount, currency: f.currency };
  if (f.ratioNew && f.ratioOld) n.ratio = { new: f.ratioNew, old: f.ratioOld };
  if (f.frequency) n.frequency = f.frequency;
  if (f.acquirer) n.acquirer = f.acquirer;
  if (f.source) n.source = f.source;
  return n;
}

/** A rotation record to be signed by the old key (sig) and the new key (sig2): see signRotation. */
export function rotationRecord(issuer: string, head: Head, newKey: string, opts: { compromisedAfterSeq?: number; reason?: string } = {}, now = new Date()): PublicationRecord {
  const r = nextRecord(issuer, head, [], now);
  return { ...r, rotation: { newKey: newKey.toLowerCase(), effectiveFrom: r.seq + 1, ...(opts.compromisedAfterSeq !== undefined ? { compromisedAfterSeq: opts.compromisedAfterSeq } : {}), ...(opts.reason ? { reason: opts.reason } : {}) } };
}

/** The next record for an issuer, to be signed. */
export function nextRecord(issuer: string, head: Head | null, entries: Entry[], now = new Date()): PublicationRecord {
  return { v: 1, issuer, seq: head ? head.seq + 1 : 1, prev: head?.hash ?? null, published: now.toISOString().replace(/\.\d{3}Z$/, 'Z'), entries };
}

/** The state after a list of records already accepted (signatures were checked when they were stored). */
export async function stateOf(records: PublicationRecord[], rootKey?: string): Promise<State> {
  let s = emptyState(rootKey);
  for (const r of records) {
    const n = applyRecord(s, r, await recordHash(r));
    if ('error' in n) throw new Error(`stored chain is inconsistent at seq ${r.seq}: ${n.error}`);
    s = n.state;
  }
  return s;
}
