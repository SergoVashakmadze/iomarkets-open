// The public example report for /assurance and GET /api/assurance?sample. It runs the REAL pipeline (the answer key
// in the corporate actions feed and the Asset Map, the rule-based grader, run diffing, issue lifecycle, report
// builder) over ANSWERS THAT WERE WRITTEN FOR THE EXAMPLE: nothing here was recorded from ChatGPT, Perplexity or
// Gemini, so the engines are called Example engine A, B and C and the report is labelled "example" and is unsigned.
// The accuracy figures are therefore not a measurement of any real engine; the real ones are at /ai-scoreboard.

import { ENTRIES } from '../../assetmap/src/index.ts';
import { findSubject, questionsFor, type Question, type Subject } from './check.ts';
import { buildReport, diffRuns, observe, reconcileIssues, watchEntry, type AssuranceReport, type Change, type Issue, type Observation, type RunSummary, type WatchEntry } from './assurance.ts';

export const SAMPLE_SUBJECTS = ['AAPL', 'MSFT', 'BENJI', 'USDY'];
export const SAMPLE_ENGINES = ['example-engine-a', 'example-engine-b', 'example-engine-c'];
type Mode = 'right' | 'wrong';

/** An answer to the numbered prompt: right (the key's own values) or with the first question's fact made wrong. */
export function exampleAnswer(s: Subject, qs: Question[], mode: Mode): string {
  const other = ENTRIES.find((e) => !s.entries.includes(e))?.tokens[0]?.address ?? '0x0000000000000000000000000000000000000001';
  return qs
    .map((q, i) => {
      const mode_ = mode === 'wrong' && i === 0 ? 'wrong' : 'right';
      if (q.id === 'dividend') {
        const e = s.events.find((x) => x.type === 'dividend')!;
        const amount = mode_ === 'wrong' ? (Number(e.cash!.amount) + 0.07).toFixed(2) : e.cash!.amount;
        return `${i + 1}. $${amount} per share; ex-dividend date ${e.dates.ex}, record date ${e.dates.record}, payment date ${e.dates.pay}.`;
      }
      if (q.id === 'tokens') {
        const t = s.entries[0].tokens.slice(0, 2).map((x) => x.address);
        return `${i + 1}. Issued by ${s.entries[0].security.issuer}. Contracts: ${(mode_ === 'wrong' ? [other] : t).join(', ')}.`;
      }
      if (q.id === 'identity') return `${i + 1}. ISIN ${s.entries[0].security.isin ?? 'unknown'}, issuer ${s.entries[0].security.issuer}.`;
      return `${i + 1}. unknown`;
    })
    .join('\n');
}

type Plan = Record<string, { wrong?: string[]; noPrimary?: string[] }>; // engine → subjects
const RUNS: { id: string; at: string; plan: Plan }[] = [
  { id: 'ar_example0001', at: '2026-11-03T06:00:00Z', plan: { 'example-engine-b': { wrong: ['AAPL', 'BENJI'] }, 'example-engine-c': { noPrimary: ['MSFT'] } } },
  { id: 'ar_example0002', at: '2026-11-10T06:00:00Z', plan: { 'example-engine-b': { wrong: ['BENJI'] }, 'example-engine-a': { noPrimary: ['BENJI'] } } },
  { id: 'ar_example0003', at: '2026-11-17T06:00:00Z', plan: { 'example-engine-a': { wrong: ['AAPL'] } } },
];

export function sampleReport(now = '2026-11-17T07:00:00Z'): { report: AssuranceReport; issues: Issue[]; changes: { run: string; changes: Change[] }[] } {
  const watch: { entry: WatchEntry; subject: Subject }[] = SAMPLE_SUBJECTS.flatMap((q) => {
    const w = watchEntry(q);
    const subject = findSubject(q);
    return 'entry' in w && subject ? [{ entry: w.entry, subject }] : [];
  });
  let issues: Issue[] = [];
  let prev: Observation[] | null = null;
  const runs: RunSummary[] = [];
  const changes: { run: string; changes: Change[] }[] = [];
  for (const r of RUNS) {
    const observations = watch.flatMap(({ entry, subject }) => {
      const qs = questionsFor(subject).filter((q) => entry.questions.includes(q.id));
      return SAMPLE_ENGINES.map((engine) => {
        const p = r.plan[engine];
        const text = exampleAnswer(subject, qs, p?.wrong?.includes(entry.query) ? 'wrong' : 'right');
        const host = p?.noPrimary?.includes(entry.query) ? 'example-blog.invalid' : subject.primaryHosts[0] ?? 'sec.gov';
        return observe(entry.query, subject, qs, engine, { ok: true, text, citations: [`https://${host}/example`] });
      });
    });
    changes.push({ run: r.id, changes: diffRuns(prev, observations) });
    issues = reconcileIssues(issues, prev, observations, r.id);
    runs.push({ id: r.id, at: r.at, observations });
    prev = observations;
  }
  const report = buildReport({
    workspace: 'ws_example',
    workspaceName: 'Example issuer (not a customer)',
    period: '2026-11',
    generated: now,
    label: 'example',
    watchlist: watch.map((w) => w.entry),
    runs,
    changes,
    issues,
    notes: [
      'EXAMPLE. The engine answers were written for this example; they were not recorded from any real AI engine, and "Example engine A/B/C" are not real products. Real accuracy figures: /ai-scoreboard.',
      'The answer key (corporate actions feed, Tokenized Asset Map), the grader, the run diffing and the issue lifecycle are the real code, run on the current feed. The three run dates are illustrative.',
      'This example is not signed. A workspace’s report is signed with IoMarkets’ audit key and can be checked offline.',
    ],
  });
  return { report, issues, changes };
}
