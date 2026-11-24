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
