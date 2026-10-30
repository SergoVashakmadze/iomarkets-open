import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { validate } from '../bench/src/index'
import { extract6k, fitsListing } from '../corpactions/src/extract6k'
import { extractAll } from '../corpactions/src/extractTable'
import type { Filing } from '../corpactions/src/extract'
import { parseListings, usTickers } from '../corpactions/src/edgar'
import { lookupFigis } from '../corpactions/src/figi'
import { describe as describeEvent } from '../corpactions/src/describe'
import { headline } from '../corpactions/src/ics'
import { toSeev031 } from '../corpactions/src/seev031'
import { DATE_ANY, dateAfter, parseDate } from '../corpactions/src/text'
import type { CorporateAction } from '../corpactions/src/types'

// Real 6-K filings (corpactions/fixtures/6-k/, README "6-K filings"): each document as filed (.htm.gz) and its text as
// the feed reads it (.txt), and in index.json what a careful reader finds in it for the security that trades in the US ("truth"),
// labelled by hand. The reader may miss events (recall) but must never state one wrongly (precision).

type Truth = Pick<CorporateAction, 'type' | 'cash' | 'ratio' | 'instrument'> & { dates: Partial<CorporateAction['dates']> }
type Fixture = { file: string; html: string; url: string; accession: string; form: string; filed: string; company: { name: string; cik: string }; tickers: string[]; securityType: string | null; kind: string; truth: Truth[]; note: string }

const DIR = new URL('../corpactions/fixtures/6-k/', import.meta.url)
const FIXTURES = JSON.parse(readFileSync(new URL('index.json', DIR), 'utf8')) as Fixture[]
const textOf = (f: Fixture) => readFileSync(new URL(f.file, DIR), 'utf8')
const htmlOf = (f: Fixture) => gunzipSync(readFileSync(new URL(f.html, DIR))).toString('utf8')
const filingOf = (f: Fixture): Filing => ({ company: f.company, tickers: f.tickers, form: f.form, accession: f.accession, filed: f.filed, url: f.url, items: [], text: textOf(f), html: htmlOf(f) })
/** What the feed keeps from one filing: its sentences (extract6k) and tables (extractTable.ts), then the OpenFIGI security type check ingest() does. */
const read = (f: Fixture) => extractAll(filingOf(f)).filter((e) => fitsListing(e, f.securityType))

const same = (e: CorporateAction, t: Truth) =>
  e.type === t.type &&
  (e.instrument ?? null) === (t.instrument ?? null) &&
  JSON.stringify(e.cash ?? null) === JSON.stringify(t.cash ?? null) &&
  JSON.stringify(e.ratio ?? null) === JSON.stringify(t.ratio ?? null) &&
  Object.entries(t.dates).every(([k, v]) => e.dates[k as keyof CorporateAction['dates']] === v)

describe('6-K fixtures: real filings', () => {
  const results = FIXTURES.map((f) => ({ f, events: read(f) }))
  const emitted = results.flatMap(({ f, events }) => events.map((e) => ({ f, e, right: f.truth.some((t) => same(e, t)) })))
  const truths = results.flatMap(({ f, events }) => f.truth.map((t) => ({ f, found: events.some((e) => same(e, t)) })))

  it('are what they say: 50 filings, with accession numbers and EDGAR addresses', () => {
    expect(FIXTURES).toHaveLength(50)
    for (const f of FIXTURES) {
      expect(f.accession, f.file).toMatch(/^\d{10}-\d{2}-\d{6}$/)
      expect(f.url, f.file).toBe(`https://www.sec.gov/Archives/edgar/data/${Number(f.company.cik)}/${f.accession.replace(/-/g, '')}/${f.url.split('/').pop()}`)
      expect(f.form, f.file).toMatch(/^6-K/)
      expect(textOf(f).length, f.file).toBeGreaterThan(500)
    }
    const kinds = (k: RegExp) => FIXTURES.filter((f) => k.test(f.kind)).length
    expect({ dividends: kinds(/^dividend/), splits: kinds(/^split|ads-ratio/), mergers: kinds(/^merger/) }).toEqual({ dividends: 26, splits: 16, mergers: 8 })
  })

  it('precision 1: every event read is in the filing, as stated', () => {
    const wrong = emitted.filter((x) => !x.right).map((x) => `${x.f.file}: ${describeEvent(x.e)}`)
    expect(wrong).toEqual([])
    expect(emitted).toHaveLength(13)
  })

  it('recall: 13 of the 20 events the filings state, every miss one the reader leaves out on purpose', () => {
    expect(truths.filter((t) => t.found)).toHaveLength(13)
    expect(truths).toHaveLength(20)
    const missed = truths.filter((t) => !t.found).map((t) => t.f.kind)
    expect(missed.every((k) => k.endsWith('-missed'))).toBe(true)
    // Each event type has true positives.
    const found = new Set(emitted.map((x) => x.e.type))
    expect([...found].sort()).toEqual(['dividend', 'merger', 'reverse-split', 'split'])
  })

  it('reads nothing from the negatives: proposals, elections, past events, ADS ratio changes, OTC-only issuers', () => {
    for (const { f, events } of results.filter((r) => /negative|ads-ratio/.test(r.f.kind))) expect(events.map(describeEvent), `${f.file}: ${f.note}`).toEqual([])
  })

  it('each event quotes its filing, links it, says it is a 6-K, and is valid seev.031 with no warnings', () => {
    for (const { f, e } of emitted) {
      expect(e.source).toMatchObject({ url: f.url, form: '6-K', accession: f.accession, filed: f.filed })
      // A table event's quote (rows in [brackets]) is checked against the filing's tables in corpactions-tables.test.ts.
      if (!e.source.table) for (const part of e.source.quote.split('...').map((s) => s.trim()).filter((s) => s.length > 20)) expect(textOf(f), e.id).toContain(part)
      const r = validate(toSeev031(e))
      expect(r.issues.map((i) => `${i.code} ${i.message}`), e.id).toEqual([])
      expect(e.company.ticker, e.id).toBe(f.tickers[0])
    }
  })

  it('says the currency and the security', () => {
    const by = (file: string) => results.find((r) => r.f.file.startsWith(file))!.events[0]
    const tac = by('0001171843-26-006868')
    expect(describeEvent(tac)).toBe('TRANSALTA CORP (TAC): quarterly cash dividend of CAD 0.07 a share; ex-date 2026-12-01 (T+1 rule: the record date), record 2026-12-01, paid 2027-01-01.')
    expect(toSeev031(tac)).toContain('<Amt Ccy="CAD">0.07</Amt>')
    expect(toSeev031(tac)).toContain('<Desc>TRANSALTA CORP shares</Desc>')
    const hsbc = by('0001654954-26-008329')
    expect(describeEvent(hsbc)).toBe('HSBC HOLDINGS PLC (HSBC ADS): cash dividend of $0.50 an ADS; ex-date 2026-08-14 (T+1 rule: the record date), record 2026-08-14, paid 2026-09-25.')
    expect(toSeev031(hsbc)).toContain('<Desc>HSBC HOLDINGS PLC American depositary shares</Desc>')
    expect(headline(hsbc)).toBe('HSBC cash dividend $0.50 per ADS')
    expect(hsbc.source.quote).toContain('US$0.50 per ADS')
    expect(describeEvent(by('0001104659-26-118301'))).toBe('Perfect Corp. (PERF): acquired, effective 2026-10-23; each share became $2.00 in cash.')
  })
})

// Sentences cut from the fixtures and changed one fact at a time.
const filing = (text: string, over: Partial<Filing> = {}): Filing => ({
  company: { name: 'Example plc', cik: '0000000002' }, tickers: ['EXPL'], form: '6-K', accession: '0000000002-26-000001', filed: '2026-10-28',
  url: 'https://www.sec.gov/Archives/edgar/data/2/000000000226000001/ex99.htm', items: [], text, ...over,
})

describe('the 6-K reader, rule by rule', () => {
  const tac = 'The Board of Directors of Example plc (TSX: EX) (NYSE: EXPL) declared a quarterly dividend of $0.07 per common share payable on January 1, 2027, to shareholders of record at the close of business on December 1, 2026. All currency is expressed in Canadian dollars (unless otherwise noted).'

  it('reads dates day first, and never numeric ones', () => {
    expect(parseDate('15 October 2026', '2026-10-01')).toBe('2026-10-15')
    expect(parseDate('4th December', '2026-10-28')).toBe('2026-12-04')
    expect(dateAfter('Payment date: 26 February 2027', /payment date/, '2026-10-28', 20, undefined, DATE_ANY)).toBe('2027-02-26')
    expect(dateAfter('record 1 June 30, 2026', /record/, '2026-06-01', 20, undefined, DATE_ANY)).toBe('2026-06-30')
    expect(dateAfter('Record Date 11/10/2026', /record date/i, '2026-10-26', 20, undefined, DATE_ANY)).toBeUndefined()
  })

  it('needs the currency: stated, or the only dollars the filing could mean', () => {
    expect(extract6k(filing(tac))[0].cash).toEqual({ amount: '0.07', currency: 'CAD' })
    // A bare "$" with a market outside the US named and no statement of which dollars: left out.
    expect(extract6k(filing(tac.replace(' All currency is expressed in Canadian dollars (unless otherwise noted).', '')))).toEqual([])
    // A bare "$" from a company named only on a US exchange: US dollars.
    expect(extract6k(filing(tac.replace('(TSX: EX) ', '').replace(' All currency is expressed in Canadian dollars (unless otherwise noted).', '')))[0].cash).toEqual({ amount: '0.07', currency: 'USD' })
    expect(extract6k(filing('The Board of Example plc (NYSE: EXPL) declared an interim dividend of 10.5 pence per ordinary share, payable on 18 December 2026 to shareholders on the register at the record date of 13 November 2026.'))[0].cash).toEqual({ amount: '0.105', currency: 'GBP' })
    expect(extract6k(filing('Example plc (Nasdaq: EXPL) declared a cash dividend of 50 cents per share, payable on December 4, 2026 to shareholders of record on November 13, 2026.'))[0].cash).toEqual({ amount: '0.50', currency: 'USD' })
  })

  it('leaves out proposed, approximate, expected, scrip and capital distributions', () => {
    const none = [
      tac.replace('declared', 'proposed'),
      tac.replace('$0.07', '~$0.07'),
      tac.replace('payable on January 1, 2027', 'expected to be paid on January 1, 2027'),
      tac.replace('a quarterly dividend', 'a scrip dividend'),
      tac.replace('declared a quarterly dividend of $0.07 per common share', 'declared a distribution out of the share premium of $0.07 per common share, by way of dividend,'),
      tac.replace('declared a quarterly dividend of $0.07 per common share', 'recommended a final dividend of $0.07 per common share, subject to approval at the annual general meeting,'),
      tac.replace('$0.07 per common share', '$0.07 per common share, payable in either cash or the Company\'s common shares,'),
    ]
    for (const t of none) expect(extract6k(filing(t)), t).toEqual([])
  })

  it('reads the ADS amount when there are ADSs, and nothing per share', () => {
    const shares = 'On 4 August 2026, the Directors of Example plc approved a second interim dividend of US$0.10 per ordinary share. The dividend is payable on 25 September 2026 to holders of record on 14 August 2026.'
    const ads = " For holders of American Depositary Shares ('ADSs'), each of which represents five ordinary shares, the cash dividend payable will be US$0.50 per ADS. It will be paid on 25 September 2026 to holders of record on 14 August 2026."
    const sept = { filed: '2026-09-14' }
    expect(extract6k(filing(shares, sept))).toEqual([]) // no ADS, and no US exchange named for the shares
    expect(extract6k(filing(shares + ' Each ADS represents five ordinary shares.', sept))).toEqual([])
    expect(extract6k(filing(shares + ads, sept))[0]).toMatchObject({ instrument: 'ADS', cash: { amount: '0.50', currency: 'USD' }, dates: { record: '2026-08-14', pay: '2026-09-25' } })
  })

  it('checks the ticker is what the event is for (OpenFIGI security type)', () => {
    const [shareEvent] = extract6k(filing(tac))
    expect(fitsListing(shareEvent, 'Common Stock')).toBe(true)
    expect(fitsListing(shareEvent, 'Depositary Receipt')).toBe(false)
    expect(fitsListing({ ...shareEvent, instrument: 'ADS' }, 'Depositary Receipt')).toBe(true)
    expect(fitsListing(shareEvent, null)).toBe(true)
    expect(fitsListing({ ...shareEvent, source: { ...shareEvent.source, form: '8-K' } }, 'Depositary Receipt')).toBe(true)
  })

  it('reads splits only when the shares themselves trade in the US', () => {
    const split = 'Example plc (Nasdaq: EXPL) announced that its board has determined to effect a 1 for 10 reverse stock split of the Company\'s issued common shares, effective at the opening of trading on November 6, 2026.'
    expect(extract6k(filing(split))[0]).toMatchObject({ type: 'reverse-split', ratio: { new: 1, old: 10 }, dates: { effective: '2026-11-06' } })
    expect(extract6k(filing(`${split} Each American Depositary Share represents ten ordinary shares.`))).toEqual([])
    expect(extract6k(filing(split.replace('has determined to effect', 'expects to implement')))).toEqual([])
    expect(extract6k(filing('Example plc (Nasdaq: EXPL) will effect a share consolidation on the basis that every five (5) ordinary shares will be consolidated into one (1) ordinary share. The ordinary shares will begin trading on a post-consolidation basis on November 9, 2026.'))[0]).toMatchObject({ type: 'reverse-split', ratio: { new: 1, old: 5 }, dates: { effective: '2026-11-09' } })
  })

  it('an ADS only when the filing speaks of one', () => {
    const lgps = 'LogProstyle Inc. (NYSE American: LGPS) declared a cash dividend of US$0.0115 per share, payable on October 30, 2026 to shareholders of record on September 30, 2026.'
    for (const t of [' Hotel revenue rose on a higher average daily rate (ADR).', ' It lists its common shares directly on a US exchange rather than through American Depositary Receipts (ADRs).'])
      expect(extract6k(filing(lgps + t, { tickers: ['LGPS'] }))[0], t).toMatchObject({ cash: { amount: '0.0115', currency: 'USD' } })
    expect(extract6k(filing(lgps + ' Each ADS represents one share.', { tickers: ['LGPS'] }))).toEqual([])
  })

  it('a filer with no ticker on a US exchange is left out', () => {
    expect(extract6k(filing(tac, { tickers: [] }))).toEqual([])
    const listings = parseListings(JSON.stringify({ fields: ['cik', 'name', 'ticker', 'exchange'], data: [[1, 'A', 'RCI', 'NYSE'], [1, 'A', 'RCIAF', 'OTC'], [2, 'B', 'LSBCF', null], [3, 'C', 'BEDU', 'Nasdaq']] }))
    expect(usTickers(['RCI', 'RCIAF'], listings)).toEqual(['RCI'])
    expect(usTickers(['LSBCF', 'GONE'], listings)).toEqual([])
  })

  it('asks OpenFIGI for the security type of 6-K tickers once', async () => {
    const asked: string[][] = []
    const post = async (_u: string, body: string) => {
      const rows = JSON.parse(body) as { idValue: string }[]
      asked.push(rows.map((r) => r.idValue))
      return { status: 200, text: JSON.stringify(rows.map(() => ({ data: [{ figi: 'BBG000000001', compositeFIGI: 'BBG000C1K7N0', securityType: 'ADR', securityType2: 'Depositary Receipt' }] }))) }
    }
    const kinds = { cache: {} as Record<string, string | null>, for: new Set(['HSBC']) }
    // HSBC already has a FIGI, but no type yet: asked once; POOL (an 8-K ticker) is not asked again.
    await lookupFigis(['HSBC', 'POOL'], { HSBC: 'BBG000C1K7N0', POOL: 'BBG000BCVG28' }, post, 0, kinds)
    await lookupFigis(['HSBC'], { HSBC: 'BBG000C1K7N0' }, post, 0, kinds)
    expect(asked).toEqual([['HSBC']])
    expect(kinds.cache).toEqual({ HSBC: 'Depositary Receipt' })
  })
})
