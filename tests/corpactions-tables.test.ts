import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { validate } from '../bench/src/index'
import { describe as describeEvent } from '../corpactions/src/describe'
import type { Filing } from '../corpactions/src/extract'
import { fitsListing } from '../corpactions/src/extract6k'
import { dateCell, extractAll, tableDividends } from '../corpactions/src/extractTable'
import { toSeev031 } from '../corpactions/src/seev031'
import { readCells, rowText, tables } from '../corpactions/src/tables'
import { htmlToText } from '../corpactions/src/text'
import type { CorporateAction } from '../corpactions/src/types'
import eventSchema from '../formats/corporate-action.v1.schema.json'

// Dividends stated only in tables (corpactions/src/extractTable.ts). Real filings: corpactions/fixtures/tables/ (8-Ks
// and 6-Ks found by EDGAR full-text search for dividend timetables, true positives and the tables that look like one
// and aren't), and the 50 6-K fixtures (corpactions/fixtures/6-k/), now with their HTML. Each fixture's "truth" is
// every dividend a careful reader finds stated in it for the security that trades in the US, labelled by hand. The
// feed's whole reader runs on them (sentences, then tables, then the OpenFIGI check ingest() does).

type Truth = Pick<CorporateAction, 'type' | 'cash' | 'ratio' | 'instrument'> & { dates: Partial<CorporateAction['dates']> }
type Fixture = { file: string; html?: string; url: string; accession: string; form: string; filed: string; company: { name: string; cik: string }; tickers: string[]; securityType: string | null; kind: string; truth: Truth[]; note: string }

const TABLES = new URL('../corpactions/fixtures/tables/', import.meta.url)
const SIXK = new URL('../corpactions/fixtures/6-k/', import.meta.url)
const load = (dir: URL) => (JSON.parse(readFileSync(new URL('index.json', dir), 'utf8')) as Fixture[]).map((f) => ({ ...f, dir }))
const ALL = [...load(TABLES), ...load(SIXK)]
const htmlOf = (f: Fixture & { dir: URL }) => gunzipSync(readFileSync(new URL(f.html ?? f.file, f.dir))).toString('utf8')
const filingOf = (f: Fixture & { dir: URL }): Filing => {
  const html = htmlOf(f)
  return { company: f.company, tickers: f.tickers, form: f.form, accession: f.accession, filed: f.filed, url: f.url, items: [], text: htmlToText(html), html }
}
/** What the feed keeps from one document: sentences and tables (extractAll), then the OpenFIGI security type check. */
const read = (f: Fixture & { dir: URL }) => extractAll(filingOf(f)).filter((e) => fitsListing(e, f.securityType))

const same = (e: CorporateAction, t: Truth) =>
  e.type === t.type &&
  (e.instrument ?? null) === (t.instrument ?? null) &&
  JSON.stringify(e.cash ?? null) === JSON.stringify(t.cash ?? null) &&
  JSON.stringify(e.ratio ?? null) === JSON.stringify(t.ratio ?? null) &&
  Object.entries(t.dates).every(([k, v]) => e.dates[k as keyof CorporateAction['dates']] === v)

/** Whether a table event's quote is the filing's: each [row] is a row of one of its tables as rendered, the rest is its text. */
function quoteIsFaithful(e: CorporateAction, html: string): string[] {
  const rows = new Set(tables(html).flatMap((t) => t.rows.map(rowText)))
  const text = htmlToText(html)
  const bad: string[] = []
  for (const m of e.source.quote.matchAll(/\[([^\]]*)\]/g)) if (!rows.has(m[1])) bad.push(`row not in the filing: ${m[1]}`)
  for (const part of e.source.quote.split(/\[[^\]]*\]/).map((s) => s.trim()).filter(Boolean)) if (!text.includes(part)) bad.push(`text not in the filing: ${part}`)
  return bad
}

describe('dividend tables: real filings', () => {
  const results = ALL.map((f) => ({ f, events: read(f) }))
  const emitted = results.flatMap(({ f, events }) => events.map((e) => ({ f, e, right: f.truth.some((t) => same(e, t)) })))
  const truths = results.flatMap(({ f, events }) => f.truth.map((t) => ({ f, t, found: events.some((e) => same(e, t)) })))
  const tableFixtures = results.filter((r) => r.f.dir === TABLES)

  it('are what they say: 34 new filings (13 8-Ks, 21 6-Ks), with accession numbers and EDGAR addresses', () => {
    expect(tableFixtures).toHaveLength(34)
    expect(tableFixtures.filter((r) => r.f.form === '8-K')).toHaveLength(13)
    for (const { f } of results) {
      expect(f.accession, f.file).toMatch(/^\d{10}-\d{2}-\d{6}$/)
      expect(f.url, f.file).toBe(`https://www.sec.gov/Archives/edgar/data/${Number(f.company.cik)}/${f.accession.replace(/-/g, '')}/${f.url.split('/').pop()}`)
      expect(htmlOf(f).length, f.file).toBeGreaterThan(1000)
    }
    // The 6-K fixtures' text is the HTML's text, as ingest() makes it.
    for (const { f } of results.filter((r) => r.f.dir === SIXK)) expect(htmlToText(htmlOf(f)), f.file).toBe(readFileSync(new URL(f.file, SIXK), 'utf8').trimEnd())
  })

  it('precision 1 on all 84 filings: every event read is in the filing, as stated', () => {
    const wrong = emitted.filter((x) => !x.right).map((x) => `${x.f.file}: ${describeEvent(x.e)}`)
    expect(wrong).toEqual([])
    expect(emitted).toHaveLength(30)
    expect(emitted.filter((x) => x.e.source.table)).toHaveLength(18)
  })

  it('recall: 30 of the 42 events the filings state; every miss labelled as one', () => {
    expect(truths).toHaveLength(42)
    expect(truths.filter((t) => t.found)).toHaveLength(30)
    // The 7 6-K misses from before (Unilever's slides are images with no <table>, TotalEnergies' NYSE record date is in a
    // footnote, CMB.TECH's share premium, Gerdau's numeric dates, Scorpio, Kandi, Gauzy) and 5 new ones: LogProStyle's
    // installment paid that day (sentences only), Caledonia, OceanaGold, Barclays and Rogers.
    const missed = truths.filter((t) => !t.found).map((t) => t.f.kind)
    expect(missed).toHaveLength(12)
    expect(missed.every((k) => /missed/.test(k))).toBe(true)
  })

  it('reads nothing from the tricky negatives: past dividends, preferred stock, proposals, other markets and classes', () => {
    for (const { f, events } of results.filter((r) => /negative/.test(r.f.kind))) expect(events.map(describeEvent), `${f.file}: ${f.note}`).toEqual([])
  })

  it('each table event quotes its table faithfully, is marked as from a table, fits corporate-action.v1, and is valid seev.031', () => {
    const sourceKeys = Object.keys((eventSchema as { properties: { source: { properties: Record<string, unknown> } } }).properties.source.properties)
    for (const { f, e } of emitted.filter((x) => x.e.source.table)) {
      expect(e.source).toMatchObject({ url: f.url, form: f.form, accession: f.accession, filed: f.filed, table: true })
      expect(quoteIsFaithful(e, htmlOf(f)), e.id).toEqual([])
      expect(e.source.quote).toMatch(/\[[^\]]+ \| [^\]]+\]/)
      for (const k of Object.keys(e.source)) expect(sourceKeys, k).toContain(k)
      expect(validate(toSeev031(e)).issues.map((i) => `${i.code} ${i.message}`), e.id).toEqual([])
    }
  })

  it('names the security: the ADS for Shell, the common stock for Hercules (not its notes, listed first)', () => {
    const by = (acc: string) => results.find((r) => r.f.accession === acc)!.events
    const shell = by('0001171843-26-005059')[0]
    expect(describeEvent(shell)).toBe('Shell plc (SHEL ADS): cash dividend of $0.7812 an ADS; ex-date 2026-08-14, record 2026-08-14, paid 2026-09-21.')
    expect(shell.source.quote).toBe('[Per ADS (US7802593050) | Q2 2026] [Shell ADSs (US$) | 0.7812] Dividend timetable for the second quarter 2026 interim dividend [Event | Date] [Ex- Dividend Date for ADSs | August 14, 2026] [Record date | August 14, 2026] [Payment date | September 21, 2026]')
    const htgc = by('0001280784-26-000055')[0]
    expect(htgc.company.ticker).toBe('HTGC')
    expect(htgc.dates).toEqual({ announced: '2026-10-29', record: '2026-11-10', ex: '2026-11-10', pay: '2026-11-17' })
    expect(htgc.exDateRule).toBeUndefined()
    expect(by('0001213900-26-107199').map((e) => e.company.ticker)).toEqual(['SAR', 'SAR', 'SAR'])
  })
})

// Tables cut from the fixtures and changed one fact at a time.
const filing = (html: string, over: Partial<Filing> = {}): Filing => ({
  company: { name: 'Example Corp', cik: '0000000003' }, tickers: ['EXMP'], form: '8-K', accession: '0000000003-26-000001', filed: '2026-10-21',
  url: 'https://www.sec.gov/Archives/edgar/data/3/000000000326000001/ex99.htm', items: [], text: htmlToText(html), html, ...over,
})
const table = (rows: string[][], before = '') =>
  `<p>${before}</p><table>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</table>`
const UDR = table(
  [['Record Date', 'Payment Date', 'Amount'], ['October 19, 2026', 'November 2, 2026', '$0.145 per common share'], ['November 16, 2026', 'November 30, 2026', '$0.145 per common share']],
  "The Company's Board of Directors declared dividends on its common stock with record dates in October and November 2026, payable on the payment dates set forth in the table below.",
)

describe('the table reader, rule by rule', () => {
  it('reads tables as the browser lays them out', () => {
    const [t] = tables('<table><tr><td colspan="2">Record Date</td><td>Amount</td></tr><tr><td>November 5, 2026</td><td></td><td>$</td><td>0.25</td></tr></table>')
    expect(t.rows.map(rowText)).toEqual(['Record Date | Amount', 'November 5, 2026 | $0.25'])
    expect(readCells(t.rows[1]).map((c) => [c.col, c.span])).toEqual([[0, 1], [2, 2]])
    expect(dateCell('Friday, 9 October 2026', '2026-08-27')).toBe('2026-10-09')
    expect(dateCell('on or about 27 October 2026', '2026-10-08')).toBeUndefined()
    expect(dateCell('11/10/2026', '2026-10-08')).toBeUndefined()
    expect(dateCell('November 1', '2026-10-16')).toBeUndefined() // no year
  })

  it('reads one dividend a row, with the amount, the dates and the quote', () => {
    const es = tableDividends(filing(UDR))
    expect(es.map((e) => [e.cash, e.dates.record, e.dates.pay, e.exDateRule])).toEqual([
      [{ amount: '0.145', currency: 'USD' }, '2026-10-19', '2026-11-02', true],
      [{ amount: '0.145', currency: 'USD' }, '2026-11-16', '2026-11-30', true],
    ])
    expect(es[0].source).toMatchObject({ quote: '[Record Date | Payment Date | Amount] [October 19, 2026 | November 2, 2026 | $0.145 per common share]', table: true })
  })

  it('leaves out a table with a row already paid, an estimate, preferred stock, another ticker, a stock dividend', () => {
    const none = [
      UDR.replace('October 19, 2026', 'July 19, 2026').replace('November 2, 2026', 'August 2, 2026'), // a dividend paid before the filing: a table of past ones
      UDR.replace('Payment Date', 'Expected Payment Date'),
      UDR.replace('on its common stock', 'on its Series A Preferred Stock').replace(/ per common share/g, ''),
      UDR.replace('on its common stock', 'on its EXMPP stock').replace(/ per common share/g, ''),
      UDR.replace('declared dividends', 'declared stock dividends payable in shares'),
      UDR.replace(/\$0\.145 per common share/g, '0.145'), // no currency
    ]
    for (const h of none) expect(tableDividends(filing(h, { tickers: ['EXMP', 'EXMPP'] })), h).toEqual([])
  })

  it('picks the US row of a market timetable, and only with the amount per ADS', () => {
    const abi = table(
      [['', 'Ex-dividend date', 'Record Date', 'Payment date'], ['Euronext', '19 November 2026', '20 November 2026', '23 November 2026'], ['NYSE (ADR program)', '20 November 2026', '20 November 2026', '16 December 2026']],
      'The Board approved an interim dividend of EUR 0.25 per share and USD 0.29 per ADS. A timeline showing the ex-dividend, record and payment dates can be found below:',
    )
    const six = { form: '6-K', filed: '2026-10-29', tickers: ['EXMP'] }
    const [e] = tableDividends(filing(abi, six))
    expect(e).toMatchObject({ instrument: 'ADS', cash: { amount: '0.29', currency: 'USD' }, dates: { ex: '2026-11-20', record: '2026-11-20', pay: '2026-12-16' } })
    expect(e.source.quote).toBe('The Board approved an interim dividend of EUR 0.25 per share and USD 0.29 per ADS. A timeline showing the ex-dividend, record and payment dates can be found below: [Ex-dividend date | Record Date | Payment date] [NYSE (ADR program) | 20 November 2026 | 20 November 2026 | 16 December 2026]')
    // No amount per ADS (only per share), or no NYSE row: nothing.
    expect(tableDividends(filing(abi.replace(' and USD 0.29 per ADS', ''), six))).toEqual([])
    expect(tableDividends(filing(abi.replace('NYSE (ADR program)', 'JSE'), six))).toEqual([])
  })

  it('a sentence reader event stays as it is; the table adds only what it alone states', () => {
    const text = '<p>Example Corp (NYSE: EXMP) declared a monthly dividend of $0.145 per share payable on November 2, 2026 to holders of record on October 19, 2026.</p>'
    const es = extractAll(filing(text + UDR))
    expect(es.map((e) => [e.dates.pay, !!e.source.table])).toEqual([['2026-11-02', false], ['2026-11-30', true]])
  })
})
