import { describe, expect, it } from 'vitest'
import { validate } from '../bench/src/index'
import { describe as describeEvent, eventById, eventRef, EVENTS, FEED_META, parseQuery, query, toSeev031, tokenEffect, tokenizedVersions, weekOf, type CorporateAction } from '../corpactions/src/index'
import { calendarName, calendarUrl, eventUrl, fold, headline, icsText, toIcs, webcalUrl } from '../corpactions/src/ics'
import { lookupFigis } from '../corpactions/src/figi'
import { prune } from '../corpactions/src/query'

const DAY = /^\d{4}-\d{2}-\d{2}$/

const dividend: CorporateAction = {
  id: 'dividend-0000945841-2026-11-25',
  type: 'dividend',
  company: { name: 'POOL CORP', cik: '0000945841', ticker: 'POOL', figi: 'BBG000BCVG28' },
  dates: { announced: '2026-10-28', record: '2026-11-11', ex: '2026-11-11', pay: '2026-11-25' },
  exDateRule: true,
  cash: { amount: '1.30', currency: 'USD' },
  frequency: 'quarterly',
  source: { url: 'https://www.sec.gov/Archives/edgar/data/945841/000119312526436129/pool-ex99_1.htm', form: '8-K', accession: '0001193125-26-436129', filed: '2026-10-28', quote: 'Pool Corporation announced today that its Board of Directors declared a quarterly cash dividend of $1.30 per share.' },
}
const split: CorporateAction = { ...dividend, id: 'split-0000945841-2026-12-11', type: 'split', dates: { announced: '2026-10-28', effective: '2026-12-11', record: '2026-11-30', pay: '2026-12-10' }, ratio: { new: 3, old: 1 }, cash: undefined, exDateRule: undefined, frequency: undefined }
const reverse: CorporateAction = { ...split, id: 'reverse-split-0000945841-2026-12-11', type: 'reverse-split', ratio: { new: 1, old: 20 }, dates: { announced: '2026-10-28', effective: '2026-12-11' } }
const cashMerger: CorporateAction = { ...split, id: 'merger-0000945841-2026-10-26', type: 'merger', dates: { announced: '2026-10-26', effective: '2026-10-26' }, ratio: undefined, cash: { amount: '7.40', currency: 'USD' }, acquirer: 'Willow Parent, LLC' }
const stockMerger: CorporateAction = { ...cashMerger, id: 'merger-0000945841-2026-10-27', cash: undefined, ratio: { new: 0.5, old: 1 } }

describe('the feed', () => {
  it('has well formed, unique events, each from an SEC filing it quotes', () => {
    expect(EVENTS.length).toBeGreaterThan(0)
    expect(FEED_META.updated).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(new Set(EVENTS.map((e) => e.id)).size).toBe(EVENTS.length)
    for (const e of EVENTS) {
      expect(e.company.cik, e.id).toMatch(/^\d{10}$/)
      expect(e.company.ticker, e.id).toBeTruthy()
      if (e.company.figi) expect(e.company.figi).toMatch(/^BBG[0-9A-Z]{9}$/)
      expect(e.source.url, e.id).toMatch(/^https:\/\/www\.sec\.gov\/Archives\/edgar\/data\//)
      expect(e.source.quote.length, e.id).toBeGreaterThan(20)
      for (const d of Object.values(e.dates)) expect(d, e.id).toMatch(DAY)
      if (e.type === 'dividend') {
        expect(Number(e.cash?.amount), e.id).toBeGreaterThan(0)
        expect(e.dates.record! <= e.dates.pay!, e.id).toBe(true)
      }
      if (e.type === 'split') expect(e.ratio!.new > e.ratio!.old, e.id).toBe(true)
      if (e.type === 'reverse-split') expect(e.ratio!.new < e.ratio!.old, e.id).toBe(true)
      if (e.type === 'merger') expect(!!e.cash || !!e.ratio, e.id).toBe(true)
    }
  })

  it('every event is a valid seev.031 message, with no warnings, by the Test Bench', () => {
    for (const e of [...EVENTS, dividend, split, reverse, cashMerger, stockMerger]) {
      const r = validate(toSeev031(e))
      expect(r.issues.map((i) => `${i.code} ${i.message}`), e.id).toEqual([])
      expect(r.message).toBe('seev.031.001.14')
    }
    expect(eventRef({ ...dividend, id: `${dividend.id}-special` })).toBe('DVCA0000945841-20261125S')
    expect(toSeev031(split)).toContain('<Qty1>3</Qty1>')
    expect(toSeev031(cashMerger)).toContain('<PricVal Ccy="USD">7.40</PricVal>')
  })

  it('says each event in plain words', () => {
    expect(describeEvent(dividend)).toBe('POOL CORP (POOL): quarterly cash dividend of $1.30 a share; ex-date 2026-11-11 (T+1 rule: the record date), record 2026-11-11, paid 2026-11-25.')
    expect(describeEvent(reverse)).toBe('POOL CORP (POOL): reverse stock split, 1 new share for every 20 held, effective 2026-12-11.')
    expect(describeEvent(cashMerger)).toBe('POOL CORP (POOL): acquired by Willow Parent, LLC, effective 2026-10-26; each share became $7.40 in cash.')
    expect(tokenizedVersions(dividend)).toEqual([])
  })
})

describe('asking the feed', () => {
  const all = [dividend, split, reverse, cashMerger]
  it('filters by holdings (ticker, CIK or FIGI), days and type', () => {
    expect(query(all, { holdings: ['pool'], types: ['dividend'] }).map((e) => e.id)).toEqual([dividend.id])
    expect(query(all, { holdings: ['945841'] })).toHaveLength(4)
    expect(query(all, { holdings: ['BBG000BCVG28'], from: '2026-11-24', to: '2026-11-30' }).map((e) => e.id)).toEqual([dividend.id, split.id])
    expect(query(all, { holdings: ['AAPL'] })).toEqual([])
    expect(weekOf('2026-10-29')).toEqual({ from: '2026-10-26', to: '2026-11-01' })
    expect(weekOf('2026-11-01')).toEqual({ from: '2026-10-26', to: '2026-11-01' })
  })

  it('checks queries from JSON', () => {
    expect(parseQuery({ holdings: 'POOL, HBAN', types: ['merger'] })).toEqual({ holdings: ['POOL', 'HBAN'], types: ['merger'] })
    expect(parseQuery({ types: ['bonus'] })).toHaveProperty('error')
    expect(parseQuery({ from: '29/10/2026' })).toHaveProperty('error')
    expect(parseQuery({ holdings: [1] })).toHaveProperty('error')
  })

  it('drops events a month after their last date', () => {
    expect(prune([dividend], '2026-12-20')).toHaveLength(1)
    expect(prune([dividend], '2026-12-26')).toHaveLength(0)
  })

})

describe('the calendar (iCalendar, RFC 5545)', () => {
  const unfold = (s: string) => s.replace(/\r\n /g, '')

  it('writes a calendar file, CRLF throughout, one all-day entry per day that matters', () => {
    const ics = toIcs([dividend, split], { stamp: new Date('2026-10-29T12:00:00Z') })
    expect(ics.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:')).toBe(true)
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true)
    expect(ics.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/)
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(5) // dividend: ex = record, then pay; split: record, pay, effective
    expect(ics).toContain('DTSTART;VALUE=DATE:20261125\r\nDTEND;VALUE=DATE:20261126')
    expect(ics).toContain('SUMMARY:POOL cash dividend $1.30 (pay date)')
    expect(ics).toContain('SUMMARY:POOL cash dividend $1.30 (ex-date\\, record date)') // one entry for both
    expect(ics).toContain('SUMMARY:POOL stock split 3:1 (effective)')
    expect(ics).toContain('DTSTAMP:20261029T120000Z')
    for (const line of ics.split('\r\n')) expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75)
  })

  it('gives every entry a stable UID from the event id, and date-only values', () => {
    const a = toIcs([dividend, split], { stamp: new Date('2026-10-29T12:00:00Z') })
    const b = toIcs([split, dividend], { stamp: new Date('2026-11-02T06:00:00Z') })
    const uids = (s: string) => [...s.matchAll(/^UID:(.+)$/gm)].map((m) => m[1]).sort()
    expect(uids(a)).toEqual(uids(b))
    expect(uids(a)).toEqual([
      'dividend-0000945841-2026-11-25-ex@iomarkets.tech',
      'dividend-0000945841-2026-11-25-pay@iomarkets.tech',
      'split-0000945841-2026-12-11-effective@iomarkets.tech',
      'split-0000945841-2026-12-11-pay@iomarkets.tech',
      'split-0000945841-2026-12-11-record@iomarkets.tech',
    ])
    for (const m of a.matchAll(/^DT(START|END)([^:]*):(.*)$/gm)) {
      expect(m[2]).toBe(';VALUE=DATE')
      expect(m[3]).toMatch(/^\d{8}$/)
    }
    // DTEND is the next day (exclusive), across a month and a year end.
    expect(a).toContain('DTSTART;VALUE=DATE:20261130\r\nDTEND;VALUE=DATE:20261201')
    expect(toIcs([{ ...dividend, dates: { ...dividend.dates, pay: '2026-12-31' } }])).toContain('DTSTART;VALUE=DATE:20261231\r\nDTEND;VALUE=DATE:20270101')
  })

  it("describes each entry with the filing's own sentence, the event on iomarkets.tech and the SEC filing", () => {
    const ics = unfold(toIcs([dividend]))
    const desc = /^DESCRIPTION:(.*)$/m.exec(ics)![1]
    expect(desc).toContain(icsText(`From the filing: "${dividend.source.quote}"`))
    expect(desc).toContain(`On iomarkets.tech: ${eventUrl(dividend)}`)
    expect(desc).toContain(dividend.source.url)
    expect(desc.split('\\n\\n')).toHaveLength(4)
    expect(eventUrl(dividend)).toBe('https://iomarkets.tech/corporate-actions#for=POOL&event=dividend-0000945841-2026-11-25')
    expect(ics).toContain(`URL:${eventUrl(dividend)}`)
    expect(headline(reverse)).toBe('POOL reverse split 1:20')
    expect(headline(cashMerger)).toBe('POOL acquired by Willow Parent, LLC')
    expect(unfold(toIcs([cashMerger]))).toContain('SUMMARY:POOL acquired by Willow Parent\\, LLC (effective)')
  })

  it('escapes TEXT and folds long lines at 75 octets without splitting a character', () => {
    expect(icsText('a\\b;c,d\ne\r\nf\rg')).toBe('a\\\\b\\;c\\,d\\ne\\nf\\ng')
    const long = `DESCRIPTION:${'é'.repeat(30)}${'x'.repeat(100)}€€€`
    const parts = fold(long).split('\r\n')
    expect(parts.length).toBeGreaterThan(2)
    for (const [i, p] of parts.entries()) {
      expect(new TextEncoder().encode(p).length).toBeLessThanOrEqual(75)
      if (i) expect(p.startsWith(' ')).toBe(true)
    }
    expect(parts.map((p, i) => (i ? p.slice(1) : p)).join('')).toBe(long) // nothing lost, no character split
    expect(fold('SUMMARY:short')).toBe('SUMMARY:short')
    const odd = toIcs([{ ...dividend, source: { ...dividend.source, quote: 'Payable; to holders, of record\\ "as of" — Nov. 11\nnext' } }])
    expect(unfold(odd)).toContain('Payable\\; to holders\\, of record\\\\ "as of" — Nov. 11\\nnext')
  })

  it('builds the subscription address for holdings and kinds of event', () => {
    expect(calendarUrl()).toBe('https://iomarkets.tech/api/corporate-actions/calendar')
    expect(calendarUrl({ holdings: ['sndk', ' POOL ', 'SNDK', 'BRK.B'], types: ['split', 'dividend'] })).toBe('https://iomarkets.tech/api/corporate-actions/calendar?holdings=SNDK,POOL,BRK.B&types=dividend,split')
    expect(calendarUrl({ types: ['dividend', 'split', 'reverse-split', 'merger'] })).toBe('https://iomarkets.tech/api/corporate-actions/calendar')
    expect(calendarUrl({ holdings: ['A&B'] })).toBe('https://iomarkets.tech/api/corporate-actions/calendar?holdings=A%26B')
    expect(webcalUrl(calendarUrl({ holdings: ['POOL'] }))).toBe('webcal://iomarkets.tech/api/corporate-actions/calendar?holdings=POOL')
    expect(calendarName({ holdings: ['SNDK', 'POOL'] })).toBe('Corporate actions: SNDK, POOL (IoMarkets.tech)')
    expect(calendarName({ holdings: ['A', 'B', 'C', 'D', 'E', 'F'] })).toBe('Corporate actions: A, B, C, D and 2 more (IoMarkets.tech)')
    expect(toIcs([], { name: calendarName({ holdings: ['SNDK', 'POOL'] }) })).toContain('\r\nX-WR-CALNAME:Corporate actions: SNDK\\, POOL (IoMarkets.tech)\r\n')
  })
})

describe('FIGIs from OpenFIGI', () => {
  it('asks only for tickers it has not seen, 10 at a time, share classes with a slash', async () => {
    const asked: string[][] = []
    const post = async (_u: string, body: string) => {
      const rows = JSON.parse(body) as { idValue: string }[]
      asked.push(rows.map((r) => r.idValue))
      return { status: 200, text: JSON.stringify(rows.map((r) => (r.idValue === 'NONE' ? { warning: 'No identifier found.' } : { data: [{ figi: 'BBG000000001', compositeFIGI: `BBG${r.idValue.replace('/', '').padEnd(9, '0')}`, securityType: 'Common Stock' }] }))) }
    }
    const cache = await lookupFigis(['POOL', 'BRK-B', 'NONE', 'POOL', 'HBAN'], { HBAN: 'BBG000BKWSR6' }, post, 0)
    expect(asked).toEqual([['POOL', 'BRK/B', 'NONE']])
    expect(cache).toEqual({ HBAN: 'BBG000BKWSR6', POOL: 'BBGPOOL00000', 'BRK-B': 'BBGBRKB00000', NONE: null })
  })
})

describe('tokenized versions in the Asset Map', () => {
  it('links an event to tokens by the underlying FIGI, or by a US ticker when either side has no FIGI', () => {
    const nvda: CorporateAction = { ...dividend, id: 'dividend-0001045810-2026-12-26', company: { name: 'NVIDIA CORP', cik: '0001045810', ticker: 'NVDA', figi: 'BBG000BBJQV0' } }
    expect(tokenizedVersions(nvda).map((a) => a.security.ticker)).toEqual(['NVDAx', 'NVDAon'])
    expect(tokenizedVersions({ ...nvda, company: { ...nvda.company, figi: undefined } }).map((a) => a.security.ticker)).toEqual(['NVDAx', 'NVDAon'])
    expect(tokenizedVersions({ ...nvda, company: { ...nvda.company, figi: 'BBG000000000' } })).toEqual([])
    expect(tokenEffect(split)).toBe('the token’s multiplier moves by 3:1 when the split takes effect')
    // Superstate's tokenized FWDI is the share itself, so no multiplier.
    const fwdi = { ...dividend, company: { name: 'FORWARD INDUSTRIES INC', cik: '0000038264', ticker: 'FWDI', figi: 'BBG020WJG333' } }
    expect(tokenizedVersions(fwdi).map((a) => a.id)).toEqual(['superstate-fwdi'])
    expect(tokenEffect(fwdi, tokenizedVersions(fwdi))).toMatch(/share of the stock itself/)
  })
})
