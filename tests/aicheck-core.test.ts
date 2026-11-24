// The AI answer check's library (aicheck/): reading facts, finding subjects, grading and the engine adapters.
// Also in the public iomarkets-open repo (scripts/sync-open.ts); tests/aicheck.test.ts covers the API and MCP tool.
import { describe, expect, it, vi } from 'vitest'
import { addressesIn, amountsIn, answerKey, datesIn, displayName, findSubject, gradeAll, gradeAnswer, promptFor, questionsFor, ratiosIn, score, splitAnswers, visibility } from '../aicheck/src/check'
import { askEngine, configured, type Fetch } from '../aicheck/src/engines'
import { type CorporateAction } from '../corpactions/src/index'
import { ENTRIES } from '../assetmap/src/index'

const src = (n: string) => ({ url: `https://www.sec.gov/Archives/${n}.htm`, form: '8-K', accession: n, filed: '2026-11-01', quote: '…' })
const co = { name: 'ACME WIDGETS CORP', cik: '0000000042', ticker: 'ACME', figi: 'BBG000ACME00' }
const DIV: CorporateAction = { id: 'dividend-0000000042-2026-11-20', type: 'dividend', company: co, dates: { announced: '2026-11-01', ex: '2026-11-20', record: '2026-11-20', pay: '2026-12-05' }, exDateRule: true, cash: { amount: '0.56', currency: 'USD' }, frequency: 'quarterly', source: src('d1') }
const OLD: CorporateAction = { ...DIV, id: 'dividend-0000000042-2026-08-20', dates: { announced: '2026-08-01', ex: '2026-08-20', record: '2026-08-20', pay: '2026-09-05' }, cash: { amount: '0.55', currency: 'USD' }, source: src('d0') }
const SPLIT: CorporateAction = { id: 'split-0000000043-2026-11-19', type: 'split', company: { name: 'Split Co', cik: '0000000043', ticker: 'SPLT' }, dates: { announced: '2026-11-02', effective: '2026-11-19' }, ratio: { new: 8, old: 1 }, source: src('s1') }
const RSPLIT: CorporateAction = { id: 'reverse-split-0000000044-2026-11-10', type: 'reverse-split', company: { name: 'Tiny Inc', cik: '0000000044', ticker: 'TINY' }, dates: { announced: '2026-11-02', effective: '2026-11-10' }, ratio: { new: 1, old: 20 }, source: src('r1') }
const MERGER: CorporateAction = { id: 'merger-0000000045-2026-10-26', type: 'merger', company: { name: 'Target Foods Inc', cik: '0000000045', ticker: 'TGTF' }, dates: { announced: '2026-10-26', effective: '2026-10-26' }, acquirer: 'Big Buyer Holdings LLC', cash: { amount: '102.00', currency: 'USD' }, source: src('m1') }
const FEED = [DIV, SPLIT, RSPLIT, MERGER]
const find = (q: string) => findSubject(q, FEED, ENTRIES, [OLD])!
const BENJI = ENTRIES.find((e) => e.id === 'franklin-fobxx')!
const BENJI_ETH = BENJI.tokens.find((t) => t.chain === 'ethereum')!.address

describe('reading facts out of text', () => {
  it('reads dates in the ways answers write them', () => {
    const t = 'On 2026-11-20, then November 20, 2026, Nov. 20 2026, 20 November 2026 and 11/20/2026.'
    expect(datesIn(t).map((d) => d.date)).toEqual(Array(5).fill('2026-11-20'))
  })
  it('reads amounts, ratios, addresses and ISINs', () => {
    expect(amountsIn('a dividend of $0.56 a share, or EUR 0.54')).toEqual([{ amount: '0.56', currency: 'USD' }, { amount: '0.54', currency: 'EUR' }])
    expect(ratiosIn('an 8-for-1 split; earlier a one-for-twenty reverse split; 1:20')).toEqual([{ new: 8, old: 1 }, { new: 1, old: 20 }, { new: 1, old: 20 }])
    expect(ratiosIn('at 10:30 am')).toEqual([])
    expect(addressesIn(`Ethereum: ${BENJI_ETH}. Solana: 5Tu84fKBpe9vfXeotjvfvWdWbAjy3hqsExvuHgFqFxA1`)).toEqual([BENJI_ETH, '5Tu84fKBpe9vfXeotjvfvWdWbAjy3hqsExvuHgFqFxA1'])
    expect(displayName('NUCOR CORP')).toBe('Nucor Corp')
    expect(displayName('Apple Inc.')).toBe('Apple Inc.')
    expect(displayName('PROCTER & GAMBLE Co')).toBe('Procter & Gamble Co')
  })
  it('splits a numbered reply back into one answer per question', () => {
    expect(splitAnswers('**1.** first\nmore\n2. second\n3) third', 3)).toEqual(['**1.** first\nmore', '\n2. second', '\n3) third'])
    expect(splitAnswers('no numbers at all', 2)).toEqual(['no numbers at all', 'no numbers at all'])
  })
})

describe('finding the subject', () => {
  it('finds a company by ticker, name or CIK, and a token by symbol, ISIN or id', () => {
    expect(find('acme').name).toBe('Acme Widgets Corp')
    expect(find('Acme Widgets').ticker).toBe('ACME')
    expect(find('42').cik).toBe('0000000042')
    expect(find('BENJI').entries[0].id).toBe('franklin-fobxx')
    expect(find('BENJI').asset).toBe(true)
    expect(find('LU2900381208').entries[0].id).toBe('franklin-onchain-lux-ib')
    expect(findSubject('no such thing at all', FEED, ENTRIES, [])).toBeNull()
  })
  it('a stock ticker also brings in its tokenized versions', () => {
    const aapl = ENTRIES.filter((e) => e.security.underlying?.ticker === 'AAPL')
    const s = findSubject('AAPL', [], ENTRIES, [])!
    expect(s.entries.map((e) => e.id).sort()).toEqual(aapl.map((e) => e.id).sort())
    expect(s.asset).toBe(false)
    expect(questionsFor(s)[0].text).toMatch(/^Which blockchains are tokenized versions of AAPL stock/)
  })
  it('asks only what the key can grade, at most three questions, in one numbered prompt', () => {
    expect(questionsFor(find('ACME')).map((q) => q.id)).toEqual(['dividend'])
    expect(questionsFor(find('SPLT')).map((q) => q.id)).toEqual(['split'])
    expect(questionsFor(find('TGTF')).map((q) => q.id)).toEqual(['merger'])
    expect(questionsFor(find('LU2900381208')).map((q) => q.id)).toEqual(['tokens', 'identity'])
    expect(promptFor(questionsFor(find('ACME')))).toMatch(/YYYY-MM-DD[\s\S]*\n1\. What is the most recently declared cash dividend of Acme Widgets Corp \(ACME\)/)
    expect(answerKey(find('ACME'))[0]).toContain('$0.56')
  })
})

describe('grading', () => {
  const s = find('ACME')
  const [q] = questionsFor(s)
  const verdicts = (text: string) => Object.fromEntries(gradeAnswer(s, q, text).map((f) => [f.fact.split(' (')[0], f.verdict]))
  it('marks a correct dividend answer right, fact by fact', () => {
    expect(verdicts('Acme declared $0.56 per share. Ex-dividend date: Nov. 20, 2026; record date November 20, 2026; payable on December 5, 2026.'))
      .toEqual({ 'Dividend per share': 'right', 'Ex-dividend date': 'right', 'Record date': 'right', 'Payment date': 'right' })
  })
  it('marks last quarter’s figures out of date and made-up ones wrong', () => {
    expect(verdicts('$0.55 a share, ex-dividend 2026-08-20, paid 2026-09-05.')).toEqual({ 'Dividend per share': 'out-of-date', 'Ex-dividend date': 'out-of-date', 'Record date': 'not-stated', 'Payment date': 'out-of-date' })
    expect(verdicts('$0.60 a share, ex-dividend 2026-11-21.')).toMatchObject({ 'Dividend per share': 'wrong', 'Ex-dividend date': 'wrong' })
    expect(verdicts('The next ex-date is expected soon; payment 2026-12-05.')).toMatchObject({ 'Ex-dividend date': 'not-stated', 'Payment date': 'right' })
  })
  it('grades splits both ways round, mergers by acquirer and price', () => {
    const sp = find('SPLT')
    expect(gradeAll(sp, questionsFor(sp), 'Split Co did an 8-for-1 forward split effective 2026-11-19.').map((f) => f.verdict)).toEqual(['right', 'right'])
    const rs = find('TINY')
    expect(gradeAll(rs, questionsFor(rs), 'A 20:1 reverse split, effective November 10, 2026.').map((f) => f.verdict)).toEqual(['right', 'right'])
    expect(gradeAll(rs, questionsFor(rs), 'A 1-for-10 reverse split.')[0].verdict).toBe('wrong')
    const m = find('TGTF')
    expect(gradeAll(m, questionsFor(m), 'Big Buyer acquired it for $102.00 per share in cash; the deal closed on 2026-10-26.').map((f) => f.verdict)).toEqual(['right', 'right', 'right'])
  })
  it('checks contract addresses against the issuer’s list and says whose an impostor address is', () => {
    const b = find('BENJI')
    const other = ENTRIES.find((e) => e.id !== BENJI.id && e.tokens.some((t) => t.chain === 'ethereum'))!
    const otherAddr = other.tokens.find((t) => t.chain === 'ethereum')!.address
    const f = gradeAll(b, questionsFor(b), `Franklin Templeton issues BENJI. Ethereum: ${BENJI_ETH.toLowerCase()}. Polygon: ${otherAddr}. Also 0x${'1'.repeat(40)}.`)
    expect(f.map((x) => [x.fact, x.verdict])).toEqual([
      ['Ethereum contract (BENJI)', 'right'],
      ['Contract address', 'wrong'],
      ['Contract address', 'unverified'],
      ['Official contracts not given', 'not-stated'],
      ['Issuer', 'right'],
    ])
    expect(f[1].source).toContain(other.security.name)
    expect(score(f)).toEqual({ right: 2, wrong: 1, outOfDate: 0, notStated: 1, unverified: 1, graded: 5, accuracy: 67 })
  })
  it('counts mentions and whether the primary source or the subject’s own site is cited', () => {
    const v = visibility(s, 'ACME pays a dividend.', ['https://www.sec.gov/Archives/x.htm', 'investor.acme.com'], 'https://investor.acme.com/ir')
    expect(v).toEqual({ mentioned: true, citations: ['https://www.sec.gov/Archives/x.htm', 'investor.acme.com'], primarySourceCited: true, ownSiteCited: true })
    expect(visibility(s, 'Some other company.', ['https://example.com'])).toMatchObject({ mentioned: false, primarySourceCited: false, ownSiteCited: null })
  })
})

describe('engines', () => {
  const reply = (body: unknown, status = 200): Fetch => vi.fn(async () => new Response(JSON.stringify(body), { status }))
  it('reads Perplexity, OpenAI and Gemini replies and their citations', async () => {
    const env = { PERPLEXITY_API_KEY: 'pplx-123456789', OPENAI_API_KEY: 'sk-123456789', GEMINI_API_KEY: 'AIza123456789' }
    expect(configured(env)).toEqual(['perplexity', 'openai', 'gemini'])
    const px = vi.fn(async () => Response.json({ object: 'response', status: 'completed', output: [
      { type: 'search_results', queries: ['q'], results: [{ id: 1, url: 'https://sec.gov/a', title: 't' }] },
      { type: 'message', content: [{ type: 'output_text', text: '1. $0.56 [1]', annotations: [] }] },
    ] }))
    expect(await askEngine('perplexity', 'q', env, px)).toMatchObject({ ok: true, text: '1. $0.56 [1]', citations: ['https://sec.gov/a'], model: 'perplexity/sonar' })
    expect((px.mock.calls[0] as unknown[])[0]).toBe('https://api.perplexity.ai/v1/agent')
    expect(JSON.parse(((px.mock.calls[0] as unknown[])[1] as RequestInit).body as string)).toMatchObject({ model: 'perplexity/sonar', input: 'q', tools: [{ type: 'web_search' }] })
    const oa = await askEngine('openai', 'q', env, reply({ output: [{ type: 'web_search_call' }, { type: 'message', content: [{ type: 'output_text', text: 'hi', annotations: [{ type: 'url_citation', url: 'https://a.com/x' }] }] }] }))
    expect(oa).toMatchObject({ ok: true, text: 'hi', citations: ['https://a.com/x'] })
    const ge = await askEngine('gemini', 'q', env, reply({ candidates: [{ content: { parts: [{ text: 'yo' }] }, groundingMetadata: { groundingChunks: [{ web: { uri: 'https://vertexaisearch.cloud.google.com/redirect/1', title: 'sec.gov' } }] } }] }))
    expect(ge).toMatchObject({ ok: true, text: 'yo', citations: ['sec.gov'] })
  })
  it('one OpenRouter key stands in for all three, with each provider’s own search; a direct key wins', async () => {
    const or = vi.fn(async () => Response.json({ choices: [{ message: { content: '1. yes', annotations: [{ type: 'url_citation', url_citation: { url: 'https://sec.gov/b', title: 't' } }] } }] }))
    const env = { OPENROUTER_API_KEY: 'sk-or-v1-1234567890abcdef', PERPLEXITY_API_KEY: 'pplx-123456789' }
    expect(configured(env)).toEqual(['perplexity', 'openai', 'gemini'])
    const g = await askEngine('gemini', 'q', env, or)
    expect(g).toMatchObject({ ok: true, via: 'openrouter', model: 'google/gemini-3.5-flash', text: '1. yes', citations: ['https://sec.gov/b'] })
    const [url, init] = or.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions')
    expect(JSON.parse(init.body as string)).toMatchObject({ model: 'google/gemini-3.5-flash', plugins: [{ id: 'web', engine: 'native' }] })
    await askEngine('perplexity', 'q', { OPENROUTER_API_KEY: 'sk-or-v1-1234567890abcdef' }, or)
    expect(JSON.parse(((or.mock.calls[1] as unknown[])[1] as RequestInit).body as string).plugins).toBeUndefined()
    expect(await askEngine('openai', 'q', { ...env, AI_CHECK_OPENAI_MODEL: 'openai/gpt-6-luna' }, or)).toMatchObject({ model: 'openai/gpt-6-luna', via: 'openrouter' })
    const px = vi.fn(async () => Response.json({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'p' }] }] }))
    expect(await askEngine('perplexity', 'q', env, px)).toMatchObject({ ok: true, text: 'p' })
    expect((px.mock.calls[0] as unknown[])[0]).toBe('https://api.perplexity.ai/v1/agent')
  })
  it('never throws and never echoes the provider’s error body', async () => {
    expect(await askEngine('openai', 'q', {})).toMatchObject({ ok: false, error: 'not set up' })
    expect(await askEngine('openai', 'q', { OPENAI_API_KEY: 'sk-123456789' }, reply({ error: 'secret detail' }, 401))).toMatchObject({ ok: false, error: 'the key was refused' })
    expect(await askEngine('gemini', 'q', { GEMINI_API_KEY: 'AIza123456789' }, vi.fn(async () => { throw new Error('boom') }))).toMatchObject({ ok: false, error: 'could not be reached' })
  })
})

