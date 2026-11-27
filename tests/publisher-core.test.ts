// The Notice Publisher's pure core (publisher/src): notices, signing, the chain, the domain proof and the generators.
import { describe, expect, it, vi } from 'vitest'
import {
  applyRecord, atomFeed, buildNotice, canonical, checkDomainProof, emptyState, generateKeypair, jsonLd, llmsTxt, nextRecord, proofUrl, publicDomain, recordHash,
  robotsTxt, signRecord, signRegistration, validateNotice, validateRecord, validateRegistration, verifyChain, verifyRecord, verifyRegistration, wellKnownFile,
  type Entry, type IssuerInfo, type PublicationRecord,
} from '../publisher/src/index'
import { toNotice } from '../aicheck/src/notice'
import { EVENTS } from '../corpactions/src/index'

const notice = (o: Record<string, unknown> = {}) => buildNotice({ issuerName: 'Acme Corp', ticker: 'ACME', eventType: 'dividend', announced: '2026-12-01', exDate: '2026-12-10', paymentDate: '2026-12-20', amount: '0.27', currency: 'USD', frequency: 'quarterly', source: 'https://www.sec.gov/Archives/x', ...o } as never)
const entry = (id: string, n = notice()): Entry => ({ id, action: 'publish', notice: n })
const at = (s: string) => new Date(s)

describe('notices', () => {
  it('accepts what the feed itself produces, and what the form builds', () => {
    for (const e of EVENTS.slice(0, 40)) expect(validateNotice(toNotice(e)), e.id).toEqual([])
    expect(validateNotice(notice())).toEqual([])
  })
  it('refuses what the schema refuses', () => {
    const bad = (o: Record<string, unknown>) => validateNotice({ ...notice(), ...o })
    expect(bad({ exDate: '12/10/2026' })[0]).toMatch(/exDate/)
    expect(bad({ cash: { amount: 0.27, currency: 'USD' } })[0]).toMatch(/amount/)
    expect(bad({ cash: { amount: '1', currency: 'usd' } })[0]).toMatch(/currency/)
    expect(bad({ eventType: 'dividend', isoEventCode: 'SPLF' })[0]).toMatch(/DVCA/)
    expect(bad({ source: 'http://x' })[0]).toMatch(/https/)
    expect(bad({ surprise: 1 })[0]).toMatch(/unexpected/)
    expect(bad({ ratio: { new: 0, old: 1 } })[0]).toMatch(/ratio/)
    expect(validateNotice('x')[0]).toMatch(/object/)
  })
})

describe('keys and signatures', () => {
  it('signs a record and a registration, and a tag stops one passing as the other', async () => {
    const k = await generateKeypair()
    const rec = nextRecord('acme', null, [entry('d1')], at('2026-12-01T09:00:00.123Z'))
    expect(rec.published).toBe('2026-12-01T09:00:00Z')
    const s = await signRecord(rec, k.privateKey)
    expect(await verifyRecord(s, k.publicKey)).toBe(true)
    expect(await verifyRecord({ ...s, record: { ...rec, seq: 2 } }, k.publicKey)).toBe(false)
    expect(await verifyRecord(s, (await generateKeypair()).publicKey)).toBe(false)
    expect(await verifyRecord({ ...s, sig: 'zz' }, k.publicKey)).toBe(false)
    const reg = { v: 1 as const, id: 'acme', name: 'Acme', domain: 'investor.example.com', publicKey: k.publicKey }
    const sr = await signRegistration(reg, k.privateKey)
    expect(await verifyRegistration(sr)).toBe(true)
    expect(await verifyRegistration({ ...sr, registration: { ...reg, name: 'Evil' } })).toBe(false)
    expect(canonical({ b: 1, a: [2, { d: 1, c: undefined }] })).toBe('{"a":[2,{"d":1}],"b":1}')
  })
})

describe('records', () => {
  const rec = (o: Partial<PublicationRecord> = {}): PublicationRecord => ({ ...nextRecord('acme', null, [entry('d1')], at('2026-12-01T09:00:00Z')), ...o })
  it('validates structure', () => {
    expect(validateRecord(rec())).toEqual([])
    expect(validateRecord(rec({ seq: 1, prev: 'a'.repeat(64) }))[0]).toMatch(/first record/)
    expect(validateRecord(rec({ seq: 2, prev: null }))[0]).toMatch(/prev/)
    expect(validateRecord(rec({ published: 'yesterday' }))[0]).toMatch(/published/)
    expect(validateRecord(rec({ entries: [] }))[0]).toMatch(/at least one/)
    expect(validateRecord(rec({ entries: Array.from({ length: 21 }, (_, i) => entry(`n${i}`)) }))[0]).toMatch(/at most 20/)
    expect(validateRecord(rec({ entries: [entry('d1'), entry('d1')] })).join()).toMatch(/twice/)
    expect(validateRecord(rec({ entries: [{ id: 'r', action: 'retract', target: 'd1' }] })).join()).toMatch(/reason/)
    expect(validateRecord(rec({ entries: [{ id: 'a', action: 'amend', notice: notice() }] })).join()).toMatch(/target/)
    expect(validateRecord(rec({ entries: [{ id: 'x', action: 'publish', notice: notice(), contract: { chain: 'ethereum', address: '0xabcd' } }] })).join()).toMatch(/either/)
    expect(validateRecord(rec({ entries: [{ id: 'x', action: 'publish', notice: notice({ exDate: 'no' }) }] })).join()).toMatch(/exDate/)
    expect(validateRecord(rec({ entries: [{ id: 'c', action: 'publish', contract: { chain: 'ethereum', address: '0xabcdef0123', symbol: 'ACME', isin: 'US0378331005' } }] }))).toEqual([])
    expect(validateRecord(rec({ entries: [{ id: 'c', action: 'publish', contract: { chain: 'Ethereum', address: '?' } }] })).length).toBe(2)
  })
  it('validates registrations and domains', () => {
    const ok = { v: 1, id: 'acme', name: 'Acme', domain: 'investor.example.com', publicKey: 'a'.repeat(64) }
    expect(validateRegistration(ok)).toEqual([])
    expect(validateRegistration({ ...ok, id: 'A' })[0]).toMatch(/id/)
    expect(validateRegistration({ ...ok, domain: '127.0.0.1' })[0]).toMatch(/domain/)
    expect(validateRegistration({ ...ok, publicKey: 'nope' })[0]).toMatch(/publicKey/)
    expect(validateRegistration({ ...ok, isin: 'x' })[0]).toMatch(/isin/)
    for (const d of ['10.0.0.1', 'localhost', 'a.local', 'intranet', 'https://x.com', 'x.com/path', 'x.com:8080', '[::1]', 'user@x.com', '']) expect(publicDomain(d), d).toHaveProperty('error')
    expect(publicDomain('Investor.Example.com')).toEqual({ domain: 'investor.example.com' })
  })
})

describe('the chain', () => {
  it('links records by hash, and amendments and retractions stay visible', async () => {
    const k = await generateKeypair()
    const r1 = nextRecord('acme', null, [entry('d1'), { id: 'c1', action: 'publish', contract: { chain: 'ethereum', address: '0xabcdef0123', symbol: 'ACME' } }], at('2026-12-01T09:00:00Z'))
    const s1 = applyRecord(emptyState(), r1, await recordHash(r1)) as { state: ReturnType<typeof emptyState> }
    const r2 = nextRecord('acme', s1.state.head, [{ id: 'd1-fix', action: 'amend', target: 'd1', reason: 'ex date moved', notice: notice({ exDate: '2026-12-11' }) }], at('2026-12-02T09:00:00Z'))
    const s2 = applyRecord(s1.state, r2, await recordHash(r2)) as { state: typeof s1.state }
    const r3 = nextRecord('acme', s2.state.head, [{ id: 'c1-gone', action: 'retract', target: 'c1', reason: 'wrong chain' }], at('2026-12-03T09:00:00Z'))
    const chain = [await signRecord(r1, k.privateKey), await signRecord(r2, k.privateKey), await signRecord(r3, k.privateKey)]
    const v = await verifyChain('acme', k.publicKey, chain)
    expect(v.ok).toBe(true)
    if (!v.ok) return
    const by = Object.fromEntries(v.state.items.map((i) => [i.id, i]))
    expect(by.d1).toMatchObject({ status: 'amended', supersededBy: 'd1-fix', reason: 'ex date moved' })
    expect(by['d1-fix']).toMatchObject({ status: 'active', amends: 'd1' })
    expect(by.c1).toMatchObject({ status: 'retracted', supersededBy: 'c1-gone' })
    expect(by['c1-gone']).toMatchObject({ retracts: 'c1', reason: 'wrong chain' })
    expect(v.state.head!.seq).toBe(3)
  })
  it('rejects a tampered body, a wrong sequence, a replayed prev, reused ids, bad targets and another key', async () => {
    const k = await generateKeypair()
    const r1 = nextRecord('acme', null, [entry('d1')], at('2026-12-01T09:00:00Z'))
    const h1 = await recordHash(r1)
    const s1 = (applyRecord(emptyState(), r1, h1) as { state: ReturnType<typeof emptyState> }).state
    const head = s1.head
    const seqSkip = nextRecord('acme', head, [entry('d2')], at('2026-12-02T09:00:00Z'))
    expect(applyRecord(s1, { ...seqSkip, seq: 3 }, 'x')).toMatchObject({ error: expect.stringMatching(/sequence/) })
    expect(applyRecord(s1, { ...seqSkip, prev: 'f'.repeat(64) }, 'x')).toMatchObject({ error: expect.stringMatching(/prev/) })
    expect(applyRecord(s1, { ...seqSkip, prev: null, seq: 2 }, 'x')).toMatchObject({ error: expect.stringMatching(/prev/) })
    expect(applyRecord(s1, { ...seqSkip, entries: [entry('d1')] }, 'x')).toMatchObject({ error: expect.stringMatching(/already used/) })
    expect(applyRecord(s1, { ...seqSkip, entries: [{ id: 'z', action: 'retract', target: 'nope', reason: 'r' }] }, 'x')).toMatchObject({ error: expect.stringMatching(/not an item/) })
    expect(applyRecord(s1, { ...seqSkip, published: '2026-11-01T00:00:00Z' }, 'x')).toMatchObject({ error: expect.stringMatching(/backwards/) })
    const good = [await signRecord(r1, k.privateKey), await signRecord(seqSkip, k.privateKey)]
    expect((await verifyChain('acme', k.publicKey, good)).ok).toBe(true)
    // tamper with the first record's amount after signing
    const tampered = structuredClone(good)
    ;(tampered[0].record.entries[0].notice as { cash: { amount: string } }).cash.amount = '9.99'
    expect(await verifyChain('acme', k.publicKey, tampered)).toMatchObject({ ok: false, at: 1, error: expect.stringMatching(/changed after signing/) })
    expect(await verifyChain('acme', (await generateKeypair()).publicKey, good)).toMatchObject({ ok: false })
    expect(await verifyChain('other', k.publicKey, good)).toMatchObject({ ok: false, error: expect.stringMatching(/belongs to/) })
    // a record removed from the middle breaks the sequence
    expect(await verifyChain('acme', k.publicKey, [good[1]])).toMatchObject({ ok: false })
    // a retracted item cannot be amended again
    const r3 = { ...seqSkip, entries: [{ id: 'x1', action: 'retract' as const, target: 'd1', reason: 'r' }] }
    const s3 = (applyRecord(s1, r3, 'h3') as { state: typeof s1 }).state
    expect(applyRecord(s3, { ...r3, seq: 3, prev: 'h3', entries: [{ id: 'x2', action: 'amend', target: 'd1', notice: notice() }] }, 'h4')).toMatchObject({ error: expect.stringMatching(/already retracted/) })
  })
})

describe('domain proof', () => {
  const key = 'ab'.repeat(32)
  const serve = (body: unknown, init: ResponseInit = {}) => vi.fn(async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), init)) as unknown as typeof fetch
  it('passes when the domain serves the id and key, and asks for the standard URL only', async () => {
    const f = serve({ issuer: 'acme', publicKey: key.toUpperCase() })
    expect(await checkDomainProof('Investor.Example.com', 'acme', key, f)).toMatchObject({ ok: true })
    expect((f as unknown as { mock: { calls: string[][] } }).mock.calls[0][0]).toBe('https://investor.example.com/.well-known/iomarkets-issuer.json')
    expect(JSON.parse(wellKnownFile('acme', key))).toEqual({ issuer: 'acme', publicKey: key })
  })
  it('fails for a wrong key, a wrong issuer, a missing file, a home page, a 404 and an unreachable site', async () => {
    expect(await checkDomainProof('a.example.com', 'acme', key, serve({ issuer: 'acme', publicKey: 'cd'.repeat(32) }))).toMatchObject({ ok: false, reason: expect.stringMatching(/different public key/) })
    expect(await checkDomainProof('a.example.com', 'acme', key, serve({ issuer: 'other', publicKey: key }))).toMatchObject({ ok: false, reason: expect.stringMatching(/other/) })
    expect(await checkDomainProof('a.example.com', 'acme', key, serve('<!doctype html><html>'))).toMatchObject({ ok: false, reason: expect.stringMatching(/not JSON/) })
    expect(await checkDomainProof('a.example.com', 'acme', key, serve('nope', { status: 404 }))).toMatchObject({ ok: false, reason: expect.stringMatching(/404/) })
    expect(await checkDomainProof('a.example.com', 'acme', key, vi.fn(async () => { throw new Error('x') }) as never)).toMatchObject({ ok: false, reason: expect.stringMatching(/Could not reach/) })
  })
  it('refuses IP literals, local names, odd ports and credentials without fetching, and refuses redirects off the site', async () => {
    const f = serve({ issuer: 'acme', publicKey: key })
    for (const d of ['127.0.0.1', '169.254.169.254', '[::1]', 'localhost', 'router.local', 'x.internal', 'a.example.com:8080', 'user:pw@a.example.com', 'a.example.com/x', '10.0.0.5']) {
      expect((await checkDomainProof(d, 'acme', key, f)).ok, d).toBe(false)
    }
    expect(f).not.toHaveBeenCalled()
    expect(proofUrl('a.example.com:81')).toHaveProperty('error')
    for (const to of ['https://evil.example.net/x', 'http://127.0.0.1/x', 'https://a.example.com:8443/x', 'https://u:p@a.example.com/x', 'http://169.254.169.254/latest']) {
      const g = vi.fn(async () => new Response(null, { status: 302, headers: { location: to } })) as unknown as typeof fetch
      expect((await checkDomainProof('a.example.com', 'acme', key, g)).ok, to).toBe(false)
      expect(g).toHaveBeenCalledTimes(1)
    }
    // apex to www is the same site, and follows
    let n = 0
    const h = vi.fn(async () => (n++ === 0 ? new Response(null, { status: 301, headers: { location: 'https://www.example.com/.well-known/iomarkets-issuer.json' } }) : new Response(JSON.stringify({ issuer: 'acme', publicKey: key })))) as unknown as typeof fetch
    expect((await checkDomainProof('example.com', 'acme', key, h)).ok).toBe(true)
  })
})

describe('generators', () => {
  const issuer: IssuerInfo = { id: 'acme', name: 'Acme <Corp> & Co', domain: 'investor.example.com', ticker: 'ACME', isin: 'US0378331005', publicKey: 'ab'.repeat(32), domainVerified: false }
  const state = async () => {
    const r1 = nextRecord('acme', null, [entry('d1'), { id: 'c1', action: 'publish', contract: { chain: 'ethereum', address: '0xabcdef0123', symbol: 'ACME' } }, entry('d0')], at('2026-12-01T09:00:00Z'))
    const s1 = (applyRecord(emptyState(), r1, 'h1') as { state: ReturnType<typeof emptyState> }).state
    const r2 = nextRecord('acme', s1.head, [{ id: 'd0-x', action: 'retract', target: 'd0', reason: 'issued in error' }], at('2026-12-02T09:00:00Z'))
    return (applyRecord(s1, r2, 'h2') as { state: typeof s1 }).state
  }
  it('JSON-LD carries the issuer, its contracts and only the active notices, in the open format', async () => {
    const out = jsonLd({ ...issuer, domainVerified: true }, await state())
    const j = JSON.parse(out.replace(/^<script[^>]*>|<\/script>$/g, ''))
    expect(out).toMatch(/^<script type="application\/ld\+json">/)
    expect(j[0]).toMatchObject({ '@type': 'Corporation', name: 'Acme <Corp> & Co', tickerSymbol: 'ACME', url: 'https://investor.example.com/' })
    expect(j[0].subjectOf.url).toBe('https://iomarkets.tech/api/publisher/acme.json')
    expect(j[0].additionalProperty[0]).toMatchObject({ name: 'ACME token contract on ethereum', value: '0xabcdef0123' })
    expect(j.slice(1).map((n: { '@type': string }) => n['@type'])).toEqual(['CorporateActionNotice'])
    expect(validateNotice(j[1])).toEqual([])
  })
  it('llms.txt and robots.txt point at the signed record and the key', async () => {
    const v = { ...issuer, domainVerified: true }
    expect(llmsTxt(issuer)).toContain('UNVERIFIED')
    expect(robotsTxt(issuer)).toContain('UNVERIFIED')
    expect(jsonLd(issuer, await state())).toContain('UNVERIFIED')
    expect(llmsTxt(v)).toContain('https://iomarkets.tech/api/publisher/acme.json')
    expect(llmsTxt(v)).toContain('/.well-known/iomarkets-issuer.json')
    expect(robotsTxt(v)).toMatch(/^# Acme.*\n# https:\/\/iomarkets\.tech\/api\/publisher\/acme\.json/)
    expect(robotsTxt(v)).toContain('Allow: /.well-known/iomarkets-issuer.json')
  })
  it('the Atom feed is well-formed, escaped, newest first, with retractions and the domain status', async () => {
    const xml = atomFeed(issuer, await state())
    expect(xml.startsWith('<?xml version="1.0" encoding="utf-8"?>\n<feed xmlns="http://www.w3.org/2005/Atom">')).toBe(true)
    expect(xml).toContain('Acme &lt;Corp&gt; &amp; Co')
    expect(xml).not.toMatch(/<Corp>/)
    expect(xml).toContain('Domain investor.example.com not verified.')
    expect(atomFeed({ ...issuer, domainVerified: true }, await state())).toContain('investor.example.com verified.')
    expect(xml.indexOf('RETRACTION: d0-x')).toBeLessThan(xml.indexOf('<id>https://iomarkets.tech/issuer/acme#d1</id>'))
    expect(xml).toContain('RETRACTED: d0')
    expect((xml.match(/<entry>/g) ?? []).length).toBe((xml.match(/<\/entry>/g) ?? []).length)
    expect((xml.match(/<entry>/g) ?? []).length).toBe(4)
    expect(xml).toContain('<updated>2026-12-02T09:00:00Z</updated>')
    // every tag opened is closed (a cheap well-formedness check, no XML parser needed)
    const stack: string[] = []
    for (const m of xml.matchAll(/<(\/?)([a-zA-Z]+)[^>]*?(\/?)>/g)) { if (m[3]) continue; if (m[1]) expect(stack.pop()).toBe(m[2]); else stack.push(m[2]) }
    expect(stack).toEqual([])
  })
})
