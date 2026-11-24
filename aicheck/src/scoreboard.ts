// The AI accuracy scoreboard: the same questions put to each AI search engine every week and graded in the open with
// the AI answer check's grader. Pure: which subjects a week asks about, the published benchmark (CC0), and the sums.
// The run itself (asking, storing) is functions/api/ai-scoreboard.ts; the weekly trigger is
// .github/workflows/ai-scoreboard.yml.

import { EVENTS, type CorporateAction } from '../../corpactions/src/index.ts';
import { answerKey, findSubject, questionsFor, type Finding, type Question, type Subject } from './check.ts';

/** Fixed every week, so a trend means something: widely held stocks with tokenized versions, and tokenized funds. */
export const FIXED_SUBJECTS = ['AAPL', 'MSFT', 'NVDA', 'META', 'TSLA', 'SPY', 'COIN', 'BENJI', 'USDY', 'OUSG', 'USTB'];
/** At most this many subjects a week: three engines each stays inside a Pages Function's subrequest budget. */
export const MAX_SUBJECTS = 14;

export type Kind = 'listed-stock' | 'tokenized-stock' | 'tokenized-fund';
export const KIND_NAMES: Record<Kind, string> = { 'listed-stock': 'Listed stocks (corporate actions)', 'tokenized-stock': 'Stocks with tokenized versions', 'tokenized-fund': 'Tokenized funds' };
export const QUESTION_NAMES: Record<Question['id'], string> = { dividend: 'Dividends', split: 'Splits', merger: 'Mergers', tokens: 'Token contracts', identity: 'Fund identifiers' };

export const kindOf = (s: Subject): Kind => (s.asset ? (s.entries[0]?.security.underlying ? 'tokenized-stock' : 'tokenized-fund') : s.entries.length ? 'tokenized-stock' : 'listed-stock');

/** ISO 8601 week, such as 2026-W48: one run per week. */
export function isoWeek(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y = t.getUTCFullYear();
  const w = Math.ceil(((t.getTime() - Date.UTC(y, 0, 1)) / 86_400_000 + 1) / 7);
  return `${y}-W${String(w).padStart(2, '0')}`;
}

/**
 * This week's subjects: the fixed list, then the feed's newest events of each other kind (the most recent split or
 * reverse split, merger, and dividend of a company not already asked about), so fresh facts are tested too.
 */
export function weekSubjects(events: CorporateAction[] = EVENTS): { query: string; subject: Subject }[] {
  const out: { query: string; subject: Subject }[] = [];
  const seen = new Set<string>();
  const add = (q: string) => {
    if (out.length >= MAX_SUBJECTS) return;
    const s = findSubject(q);
    const id = s ? s.cik ?? s.entries[0]?.id ?? s.name : '';
    if (s && !seen.has(id) && questionsFor(s).length) {
      seen.add(id);
      out.push({ query: q, subject: s });
    }
  };
  FIXED_SUBJECTS.forEach(add);
  const newest = (types: CorporateAction['type'][]) =>
    events.filter((e) => types.includes(e.type) && e.company.ticker).sort((a, b) => (b.dates.announced + b.id).localeCompare(a.dates.announced + a.id));
  for (const types of [['split', 'reverse-split'], ['merger'], ['dividend']] as CorporateAction['type'][][]) {
    const e = newest(types).find((x) => !seen.has(x.company.cik));
    if (e) add(e.company.ticker!);
  }
  return out;
}

/** The benchmark, published under CC0: every subject, its questions and the answer key, for anyone to rerun. */
export function benchmark(week: string, subjects = weekSubjects()) {
  return {
    name: 'IoMarkets AI answer accuracy benchmark',
    week,
    license: 'CC0-1.0 (public domain): https://creativecommons.org/publicdomain/zero/1.0/',
    grader: 'Rule-based, no model: https://github.com/SergoVashakmadze/iomarkets-open/tree/main/aicheck',
    sources: 'Answer key: the corporate actions feed (companies’ own SEC filings) and the Tokenized Asset Map (issuers’ own contract lists), as of the week.',
    subjects: subjects.map(({ query, subject }) => ({ query, name: subject.name, kind: kindOf(subject), questions: questionsFor(subject).map((q) => ({ id: q.id, text: q.text })), key: answerKey(subject) })),
  };
}

export type ResultRow = {
  run: string;
  subject: string;
  name: string;
  kind: Kind;
  engine: string;
  model: string;
  ok: boolean;
  error?: string;
  right: number;
  wrong: number;
  outOfDate: number;
  notStated: number;
  unverified: number;
  mentioned: boolean;
  primaryCited: boolean;
  citations: number;
  findings: Finding[];
};

export type Tally = { answers: number; failed: number; right: number; wrong: number; outOfDate: number; notStated: number; unverified: number; accuracy: number | null; mentioned: number | null; primaryCited: number | null };

const pct = (a: number, b: number) => (b ? Math.round((100 * a) / b) : null);

/** Sums for a set of results: accuracy is right over right + wrong + out of date, as in the answer check. */
export function tally(rows: ResultRow[]): Tally {
  const ok = rows.filter((r) => r.ok);
  const sum = (k: 'right' | 'wrong' | 'outOfDate' | 'notStated' | 'unverified') => ok.reduce((n, r) => n + r[k], 0);
  const right = sum('right');
  const wrong = sum('wrong');
  const outOfDate = sum('outOfDate');
  return {
    answers: ok.length,
    failed: rows.length - ok.length,
    right,
    wrong,
    outOfDate,
    notStated: sum('notStated'),
    unverified: sum('unverified'),
    accuracy: pct(right, right + wrong + outOfDate),
    mentioned: pct(ok.filter((r) => r.mentioned).length, ok.length),
    primaryCited: pct(ok.filter((r) => r.primaryCited).length, ok.length),
  };
}

/** Per question type, from the findings themselves (a subject can have a dividend and a tokens question). */
export function byQuestion(rows: ResultRow[]): Record<string, { right: number; judged: number; accuracy: number | null }> {
  const out: Record<string, { right: number; judged: number; accuracy: number | null }> = {};
  for (const f of rows.filter((r) => r.ok).flatMap((r) => r.findings)) {
    if (f.verdict === 'not-stated' || f.verdict === 'unverified') continue;
    const o = (out[f.question] ??= { right: 0, judged: 0, accuracy: null });
    o.judged++;
    if (f.verdict === 'right') o.right++;
  }
  for (const o of Object.values(out)) o.accuracy = pct(o.right, o.judged);
  return out;
}

/** The scoreboard for one week: by engine, by engine and kind of asset, by engine and question type. */
export function board(rows: ResultRow[]) {
  const engines = [...new Set(rows.map((r) => r.engine))];
  const kinds = [...new Set(rows.map((r) => r.kind))] as Kind[];
  return {
    engines: engines.map((e) => {
      const mine = rows.filter((r) => r.engine === e);
      return {
        engine: e,
        model: mine.find((r) => r.ok)?.model ?? mine[0]?.model ?? '',
        ...tally(mine),
        byKind: Object.fromEntries(kinds.map((k) => [k, tally(mine.filter((r) => r.kind === k))])),
        byQuestion: byQuestion(mine),
      };
    }),
    subjects: [...new Set(rows.map((r) => r.subject))].map((s) => {
      const mine = rows.filter((r) => r.subject === s);
      return { subject: s, name: mine[0].name, kind: mine[0].kind, engines: mine.map((r) => ({ engine: r.engine, ok: r.ok, right: r.right, wrong: r.wrong, outOfDate: r.outOfDate, notStated: r.notStated, unverified: r.unverified, mentioned: r.mentioned, primaryCited: r.primaryCited })) };
    }),
  };
}
