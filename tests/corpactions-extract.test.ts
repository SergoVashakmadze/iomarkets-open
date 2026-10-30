import { describe, expect, it } from 'vitest'
import { extract, splitRatio, type Filing } from '../corpactions/src/extract'
import { clip, dateAfter, dollars, htmlToText, parseDate, sentences } from '../corpactions/src/text'
import { parseDisplayName } from '../corpactions/src/edgar'

// Sentences from real 8-K filings (October 2026), cut to the part that matters.
const filing = (text: string, over: Partial<Filing> = {}): Filing => ({
  company: { name: 'Example Corp', cik: '0000000001' },
  tickers: ['EXMP'],
  form: '8-K',
  accession: '0000000001-26-000001',
  filed: '2026-10-22',
  url: 'https://www.sec.gov/Archives/edgar/data/1/000000000126000001/ex99.htm',
  items: ['8.01', '9.01'],
  text,
  ...over,
})

describe('reading text', () => {
  it('dates as filings write them, with the year inferred', () => {
    expect(parseDate('January 4, 2027', '2026-10-22')).toBe('2027-01-04')
    expect(parseDate('Dec. 1', '2026-10-28')).toBe('2026-12-01')
    expect(parseDate('Jan. 15', '2026-12-20')).toBe('2027-01-15')
    expect(parseDate('November 31, 2026', '2026-10-22')).toBeUndefined()
    expect(dateAfter('payable to shareholders of record on November 3, 2026, and will be paid on November 13, 2026', /payable|paid/, '2026-10-22', 50, /record/)).toBe('2026-11-13')
  })

  it('amounts, ratios and EDGAR names', () => {
    expect(dollars('$0.155 per share')).toBe('0.155')
    expect(dollars('15 cents per share')).toBe('0.15')
    expect(splitRatio('a one-for-twenty (1:20) reverse stock split')).toEqual({ new: 1, old: 20 })
    expect(splitRatio('a three (3) for one (1) forward stock split')).toEqual({ new: 3, old: 1 })
    expect(splitRatio('a 1-for-10 reverse stock split')).toEqual({ new: 1, old: 10 })
    expect(parseDisplayName('HUNTINGTON BANCSHARES INC /MD/  (HBAN, HBANL)  (CIK 0000049196)').name).toBe('HUNTINGTON BANCSHARES INC')
    expect(parseDisplayName('BREAD FINANCIAL HOLDINGS, INC.  (BFH, BFH-PA, BFH-PB)  (CIK 0001101215)')).toEqual({ name: 'BREAD FINANCIAL HOLDINGS, INC.', tickers: ['BFH', 'BFH-PA', 'BFH-PB'] })
  })

  it('plain text and sentences from filed HTML', () => {
    const t = htmlToText('<DOCUMENT><TYPE>EX-99.1\n<TEXT><html><p>Pool&#160;Corp. declared a dividend.</p><p>It is payable Nov. 25, 2026.</p>&#8226; Next</html>')
    expect(t).toBe('Pool Corp. declared a dividend. It is payable Nov. 25, 2026.. Next')
    expect(sentences(t)).toEqual(['Pool Corp. declared a dividend.', 'It is payable Nov. 25, 2026..', 'Next'])
    expect(clip('a '.repeat(400) + 'declared it', /declared/, 100)).toMatch(/^\.\.\.(a )+declared it$/)
  })
})

describe('dividends', () => {
  it('reads a common stock dividend and skips the preferred ones beside it', () => {
    const [e, ...rest] = extract(filing(
      'On October 22, 2026, Huntington Bancshares Incorporated (Nasdaq: HBAN) announced that its Board of Directors ("Board") declared a quarterly cash dividend on the company\'s common stock of $0.155 per common share, unchanged from the prior quarter. The common stock cash dividend is payable on January 4, 2027, to shareholders of record on December 18, 2026. The Board also declared quarterly cash dividends on the following six series of its preferred stock payable January 15, 2027.',
      { tickers: ['HBAN', 'HBANL', 'HBANM'] },
    ))
    expect(rest).toEqual([])
    expect(e).toMatchObject({
      id: 'dividend-0000000001-2027-01-04', type: 'dividend', company: { ticker: 'HBAN' }, cash: { amount: '0.155', currency: 'USD' }, frequency: 'quarterly',
      dates: { announced: '2026-10-22', record: '2026-12-18', ex: '2026-12-18', pay: '2027-01-04' }, exDateRule: true,
    })
  })

  it('takes the new amount, not the one it is compared with', () => {
    const [e] = extract(filing('The board of directors of S&T Bancorp, Inc. (S&T), the holding company for S&T Bank, approved a $0.38 per share cash dividend on October 28, 2026. This is an increase of $0.01, or 2.70 percent, compared to a cash dividend of $0.37 per share declared in the prior quarter. The annualized yield using the October 27, 2026 closing price of $50.59 is 3.00 percent. The dividend is payable November 27, 2026 to shareholders of record on November 12, 2026.'))
    expect(e).toMatchObject({ cash: { amount: '0.38' }, dates: { pay: '2026-11-27', record: '2026-11-12' } })
  })

  it("a yearly rate is not the dividend, and the common stock's ticker is the one on the 8-K cover", () => {
    // SmartStop, 2026-10-01: the monthly amount is only in a table (extractTable.ts).
    expect(extract(filing('On October 1, 2026, the Board of Directors of SmartStop Self Storage REIT, Inc. (the "Company") declared a dividend for the month of October 2026, which reflects a targeted annualized dividend of $1.60 per share. The dividend has a record date as of the close of business of the last business day of October 2026 and will be payable to stockholders of record as of the monthly record date set forth below: Record Date Payment Date Common Stock, per share October 30, 2026 November 13, 2026 $0.13589041'))).toEqual([])
    const cover = 'Title of each class Trading Symbol(s) Name of each exchange on which registered Common Stock, par value $0.001 per share HTGC New York Stock Exchange 6.25% Notes due 2033 HCXY New York Stock Exchange. '
    const [e] = extract(filing(cover + 'The Board declared a cash dividend of $0.47 per share, payable on November 17, 2026 to shareholders of record on November 10, 2026.', { tickers: ['HCXY', 'HTGC'] }))
    expect(e.company.ticker).toBe('HTGC')
  })

  it("doesn't read the record date as the payment date", () => {
    const [e] = extract(filing('At its October 2026 meeting, the Board of Directors approved a cash dividend of $0.45 per common share, up five cents or 12.50% from the cash dividend declared a year ago. The cash dividend is payable to shareholders of record on November 3, 2026, and will be paid on November 13, 2026.'))
    expect(e.dates).toMatchObject({ record: '2026-11-03', pay: '2026-11-13' })
  })

  it('picks the common amount when one sentence prices preferred stock too', () => {
    const [e] = extract(filing('Bread Financial today announced that its Board of Directors declared a quarterly dividend of $0.4375 per share on its Series A preferred stock and an increased quarterly dividend of $0.26 per share on its common stock, payable on December 12, 2026 to stockholders of record at the close of business on November 7, 2026.'))
    expect(e.cash?.amount).toBe('0.26')
  })

  it('states the ex-date when the filing gives it', () => {
    const [e] = extract(filing('The Board declared a special cash dividend of $2.00 per share, payable on December 30, 2026 to holders of record on December 15, 2026. The ex-dividend date is December 31, 2026.'))
    expect(e).toMatchObject({ id: 'dividend-0000000001-2026-12-30-special', frequency: 'special', dates: { ex: '2026-12-31' } })
    expect(e.exDateRule).toBeUndefined()
  })

  it('leaves out what is not stated in full, past, preferred only, or in stock', () => {
    const none = [
      'The Board declared a quarterly cash dividend of $0.25 per share, payable in December.',
      'The Board declared a quarterly dividend of $0.34375 per share on its Series A Preferred Stock, payable on November 16, 2026 to holders of record on November 2, 2026.',
      'The Board declared a stock dividend of 5% payable on November 16, 2026 to holders of record on November 2, 2026.',
      'In 2024 the Board declared a dividend of $0.20 per share, payable on March 1, 2024 to holders of record on February 15, 2024.',
    ]
    for (const t of none) expect(extract(filing(t)), t).toEqual([])
    expect(extract(filing('The Board declared a dividend of $0.14 per share of Class I Common Stock, payable on or about November 25, 2026, to holders of record on October 30, 2026.', { tickers: [] }))).toEqual([])
  })
})

describe('splits', () => {
  it('reads a reverse split with its effective date', () => {
    const [e] = extract(filing('On October 26, 2026, Healthcare Triangle, Inc. (the "Company") effected a one-for-twenty (1:20) reverse stock split of all issued and outstanding shares of the Company\'s common stock, par value $0.00001 per share (the "Common Stock") effective as of 12:01 a.m. Eastern Time on October 26, 2026 (the "Reverse Stock Split").', { filed: '2026-10-27' }))
    expect(e).toMatchObject({ id: 'reverse-split-0000000001-2026-10-26', type: 'reverse-split', ratio: { new: 1, old: 20 }, dates: { effective: '2026-10-26' } })
  })

  it('reads a forward split paid as a stock distribution', () => {
    const [e] = extract(filing('The Board of Directors approved a 3-for-1 stock split of the Company\'s common stock, to be distributed on December 10, 2026 to shareholders of record as of the close of business on November 30, 2026. Shares will begin trading on a split-adjusted basis on December 11, 2026.'))
    expect(e).toMatchObject({ type: 'split', ratio: { new: 3, old: 1 }, dates: { pay: '2026-12-10', record: '2026-11-30', ex: '2026-12-11', effective: '2026-12-11' } })
  })

  it('leaves out proposed splits, ranges and boilerplate', () => {
    const none = [
      'MariMed Files Definitive Proxy Statement for Special Meeting of Stockholders to Approve Proposed Reverse Stock Split, effective November 30, 2026 if approved.',
      'The Board may effect a reverse stock split at a ratio within a range of 1-for-5 to 1-for-50, effective no later than December 31, 2026.',
      'The floor price is subject to adjustment for any reverse or forward stock split, stock dividend or recapitalization effective after October 22, 2026.',
      'The Company effected a 1-for-10 reverse stock split of its Series B Preferred Stock effective October 26, 2026.',
    ]
    for (const t of none) expect(extract(filing(t)), t).toEqual([])
  })
})

describe('mergers', () => {
  const closing = { items: ['2.01', '3.01', '3.03', '5.01', '9.01'], filed: '2026-10-26', tickers: ['WEAV'] }
  it('reads a completed cash merger reported by the company acquired', () => {
    const [e] = extract(filing(
      'This Current Report on Form 8-K is being filed in connection with the completion of the previously announced Merger pursuant to the Agreement and Plan of Merger, dated August 18, 2026 (the "Merger Agreement"), by and among Weave Communications, Inc., a Delaware corporation (the "Company"), Willow Parent, LLC, a Delaware limited liability company ("Parent"), and Willow Merger Sub, Inc. On October 26, 2026 (the "Closing Date"), pursuant to the Merger Agreement, Merger Sub merged with and into the Company (the "Merger"), with the Company surviving the Merger as a wholly owned subsidiary of Parent. Pursuant to the Merger Agreement, at the Effective Time, each share of the Company\'s common stock issued and outstanding was automatically converted into the right to receive $7.40 in cash, without interest (the "Merger Consideration").',
      closing,
    ))
    expect(e).toMatchObject({ id: 'merger-0000000001-2026-10-26', type: 'merger', cash: { amount: '7.40' }, acquirer: 'Willow Parent, LLC', dates: { effective: '2026-10-26' } })
    expect(e.source.quote).toMatch(/^On October 26, 2026.*\$7\.40 in cash/)
  })

  it('reads stock terms, and leaves out elections and acquirers reporting', () => {
    const terms = 'On October 23, 2026, the Company completed its merger. Each share of the Company\'s common stock was converted into the right to receive 0.5 shares of Acquirer common stock.'
    expect(extract(filing(terms, closing))[0]).toMatchObject({ ratio: { new: 0.5, old: 1 } })
    expect(extract(filing(terms.replace('right to receive', 'right to receive, at the election of the holder,'), closing))).toEqual([])
    // The acquirer files 2.01 alone: the company it bought was private, or reports itself.
    expect(extract(filing(terms, { ...closing, items: ['2.01', '9.01'] }))).toEqual([])
  })
})
