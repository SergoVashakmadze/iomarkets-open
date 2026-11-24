# AI answer check

What AI search engines tell people about a listed company, fund or token, graded against the corporate
actions feed (`../corpactions`, companies' own SEC filings) and the Tokenized Asset Map (`../assetmap`,
issuers' own contract lists). Live at https://iomarkets.tech/ai-check.

- `src/check.ts`: pure. `findSubject` (ticker, name, CIK, FIGI, ISIN, token symbol or map id),
  `questionsFor` (at most three questions the key can grade), `promptFor` / `splitAnswers` (one numbered
  prompt per engine), `gradeAnswer` / `gradeAll`, `visibility`, `score`, `answerKey`.
- `src/engines.ts`: Perplexity (Agent API), OpenAI (Responses with web search) and Gemini (Google Search
  grounding), each with its own key, or all three through one OpenRouter key using each provider's own
  search. `fetch` is injected; errors never echo the provider's body.

- `src/notice.ts`: the corporate action notice, an open JSON-LD format an issuer embeds in its own page
  (`../formats/corporate-action-notice.v1.schema.json`, governed at https://iomarkets.org/formats): `toNotice`
  from a feed event, `compareNotice` against one.
- `src/audit.ts`: the AI-readiness audit for issuers (https://iomarkets.tech/ai-readiness). Pure `audit()` over
  a page, its robots.txt and llms.txt: AI crawler rules (RFC 9309 groups, longest match), llms.txt, text without
  JavaScript, title and description, noindex, schema.org issuer markup, notices checked against the feed, and
  the page's own figures graded like an AI answer. Writes the JSON-LD, an llms.txt draft and robots.txt lines.
  `checkUrl` / `fetchSite` fetch public hosts only.

- `src/scoreboard.ts`: the weekly AI accuracy scoreboard (https://iomarkets.tech/ai-scoreboard): the week's
  subjects, the CC0 benchmark, and the sums by engine, kind of asset and question.
- `src/agentready.ts`: the agent-readiness check for financial APIs (https://iomarkets.tech/agent-ready): an
  OpenAPI description or an MCP tool list checked for amounts with currency and unit (not floats), times with a
  time zone, identifiers naming their standard, errors, rate limits, idempotency on calls that move money, and
  trading tools marked destructive. `fetchSpec` and `fetchMcpTools` (initialize, then tools/list) read remote ones.

Grading uses no model: dates, amounts, split ratios, acquirers, contract addresses and ISINs are read out of
the answer and compared with the key. Verdicts: `right`, `wrong`, `out-of-date` (an earlier event, from the
feed's history), `not-stated`, and `unverified` (a contract address the map has never seen; not in the map is
not a verdict). Accuracy is right over right + wrong + out of date.

```ts
import { findSubject, questionsFor, gradeAll, score } from './src/check.ts'
const s = findSubject('AAPL')!
const findings = gradeAll(s, questionsFor(s), 'Apple pays $0.27 a share, ex-dividend 2026-11-12.')
console.log(score(findings))
```
