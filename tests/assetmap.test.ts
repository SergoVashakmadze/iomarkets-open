import { describe, expect, it } from 'vitest'
import { ASSET_MAP_KEYS, canonical, checkAttestations, checkContract, checkIssuerSignature, checkWithIssuer, CHAINS, ENTRIES, search, signEntry, stellarCurrencies, type Entry } from '../assetmap/src/index'
import { isinOk } from '../bench/src/codes'

const BENJI_ETH = '0x3DDc84940Ab509C11B20B76B466933f40b750dc9'
const ok = (r: ReturnType<typeof checkContract>) => {
  if ('error' in r) throw new Error(r.error)
  return r
}

describe('the data', () => {
  it('every entry is signed by a published key and verifies', async () => {
    for (const e of ENTRIES) {
      const r = await checkAttestations(e)
      expect(r.length, e.id).toBeGreaterThan(0)
      expect(r.every((x) => x.ok), `${e.id}: run node assetmap/scripts/sign.ts`).toBe(true)
    }
    expect(ASSET_MAP_KEYS.filter((k) => k.status === 'current')).toHaveLength(1)
  })

  it('a changed entry no longer verifies', async () => {
    const e: Entry = structuredClone(ENTRIES[0])
    e.tokens[1].address = '0x0000000000000000000000000000000000000001'
    expect((await checkAttestations(e))[0]).toMatchObject({ ok: false })
  })

  it('every contract cites an issuer source, and identifiers are well formed', () => {
    const ids = new Set<string>()
    for (const e of ENTRIES) {
      expect(ids.has(e.id)).toBe(false)
      ids.add(e.id)
      for (const t of e.tokens) {
        expect(CHAINS[t.chain], t.chain).toBeDefined()
        expect(['issuer-page', 'issuer-api', 'stellar-toml']).toContain(e.sources[t.source]?.kind)
        if (CHAINS[t.chain].evm) expect(t.address).toMatch(/^0x[0-9a-fA-F]{40}$/)
        if (t.chain === 'stellar') expect(t.address).toMatch(/^(?:[A-Za-z0-9]{1,12}:G[A-Z2-7]{55}|C[A-Z2-7]{55})$/)
        if (t.chain === 'starknet') expect(t.address).toMatch(/^0x[0-9a-fA-F]{1,64}$/)
      }
      if (e.security.isin) expect(isinOk(e.security.isin), e.security.isin).toBe(true)
      if (e.security.figi) expect(e.security.figi).toMatch(/^BBG[0-9A-Z]{9}$/)
      for (const s of e.sources) expect(s.url).toMatch(/^https:\/\//)
    }
  })
})

describe('checkContract', () => {
  it('says official, in any letter case on EVM chains', () => {
    const r = ok(checkContract(ENTRIES, 'ethereum', BENJI_ETH.toLowerCase()))
    expect(r.verdict).toBe('official')
    expect(r.match?.entry.id).toBe('franklin-fobxx')
    expect(r.message).toContain('Franklin Templeton')
  })

  it('reads Stellar assets written CODE-ISSUER', () => {
    expect(ok(checkContract(ENTRIES, 'stellar', 'USDY-GAJMPX5NBOG6TQFPQGRABJEEB2YE7RFRLUKJDZAZGAD5GFX4J7TADAZ6')).verdict).toBe('official')
  })

  it('other-chain, impostor and unknown', () => {
    expect(ok(checkContract(ENTRIES, 'polygon', BENJI_ETH)).verdict).toBe('other-chain')
    const fake = ok(checkContract(ENTRIES, 'ethereum', '0x1111111111111111111111111111111111111111', 'benji'))
    expect(fake.verdict).toBe('impostor')
    expect(fake.message).toContain(BENJI_ETH)
    expect(ok(checkContract(ENTRIES, 'ethereum', '0x1111111111111111111111111111111111111111')).verdict).toBe('unknown')
    expect(checkContract(ENTRIES, 'dogechain', BENJI_ETH)).toHaveProperty('error')
    expect(checkContract(ENTRIES, 'ethereum', ' ')).toHaveProperty('error')
  })

  it('Solana mints are case-sensitive', () => {
    expect(ok(checkContract(ENTRIES, 'solana', 'A1KLoBrKBde8Ty9qtNQUtq3C2ortoC3u7twggz7sEto6')).verdict).toBe('official')
    expect(ok(checkContract(ENTRIES, 'solana', 'a1kloBrKBde8Ty9qtNQUtq3C2ortoC3u7twggz7sEto6')).verdict).not.toBe('official')
  })

  it('searches by issuer, ticker, ISIN and FIGI', () => {
    expect(search(ENTRIES, 'ondo finance').map((e) => e.id)).toEqual(['ondo-ousg', 'ondo-usdy'])
    expect(search(ENTRIES, 'NVDA').map((e) => e.id)).toEqual(['xstocks-nvdax', 'ondo-stocks-nvdaon'])
    expect(search(ENTRIES, 'FR001400ODM9').map((e) => e.id)).toEqual(['spiko-ustbl'])
    expect(search(ENTRIES, 'FOBXX')[0].id).toBe('franklin-fobxx')
    expect(search(ENTRIES, 'LU2900381208')).toHaveLength(1)
    expect(search(ENTRIES, 'bbg00xnqn5b5')).toHaveLength(1)
  })
})

describe('checking with the issuer', () => {
  const toml = `NETWORK_PASSPHRASE="Public Global Stellar Network ; September 2015"
[[CURRENCIES]]
code="BENJI"
issuer="GBHNGLLIE3KWGKCHIKMHJ5HVZHYIK7WTBE4QF5PLAKL4CJGSEU7HZIW5"
[[CURRENCIES]]
code="gBENJI"
issuer="GD5J73EKK5IYL5XS3FBTHHX7CZIYRP7QXDL57XFWGC2WVYWT326OBXRP"
[DOCUMENTATION]
ORG_NAME="x"`

  it('reads stellar.toml currencies', () => {
    expect(stellarCurrencies(toml)).toEqual([
      { code: 'BENJI', issuer: 'GBHNGLLIE3KWGKCHIKMHJ5HVZHYIK7WTBE4QF5PLAKL4CJGSEU7HZIW5' },
      { code: 'gBENJI', issuer: 'GD5J73EKK5IYL5XS3FBTHHX7CZIYRP7QXDL57XFWGC2WVYWT326OBXRP' },
    ])
  })

  it('confirms tokens on the issuer pages, says when one is missing, and when a page is down', async () => {
    const e = ENTRIES.find((x) => x.id === 'franklin-fobxx')!
    const page = e.tokens.filter((t) => t.chain !== 'stellar').map((t) => t.address.toLowerCase()).join(' ')
    const pages: Record<string, string> = { [e.sources[0].url]: page, [e.sources[1].url]: toml }
    const r = await checkWithIssuer(e, async (u) => pages[u] ?? null)
    expect(r.every((x) => x.ok === true)).toBe(true)
    const missing = await checkWithIssuer(e, async (u) => (u === e.sources[1].url ? toml.replace('BENJI"', 'XBENJI"') : pages[u]))
    expect(missing.find((x) => x.token === 'BENJI on stellar')?.ok).toBe(false)
    expect((await checkWithIssuer(e, async () => null)).every((x) => x.ok === null)).toBe(true)
  })

  it('verifies an issuer signature against the key on its own domain', async () => {
    const priv = '11'.repeat(32)
    const { publicKeyOf } = await import('../assetmap/src/sign')
    const pub = await publicKeyOf(priv)
    const e: Entry = structuredClone(ENTRIES[4])
    e.attestations = [await signEntry(e, priv, 'issuer-1', 'Ondo Finance')]
    const keyFile = JSON.stringify({ keys: [{ id: 'issuer-1', publicKey: pub }] })
    expect(await checkIssuerSignature(e, 'ondo.finance', async () => keyFile)).toMatchObject({ ok: true })
    expect(await checkIssuerSignature(e, 'ondo.finance', async () => null)).toMatchObject({ ok: false })
  })

  it('canonical form sorts keys and drops undefined', () => {
    expect(canonical({ b: 1, a: [2, { d: undefined, c: 'x' }] })).toBe('{"a":[2,{"c":"x"}],"b":1}')
  })
})
