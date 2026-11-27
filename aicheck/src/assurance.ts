// AI answer assurance: the AI answer check (check.ts) and the scoreboard's engines, run on a schedule for ONE
// organisation's own securities, funds and tokens, with the differences between runs kept as issues that a person
// works through, and a monthly report. Pure: no database, no network, no clock but the ones it is handed.
// The storage and the endpoint are server/assurance.ts and functions/api/assurance.ts (workspace-scoped, ENTERPRISE).
//
// What is graded is exactly what the answer key can grade (check.ts questionsFor): dividends, splits, mergers,
// token contracts, fund identifiers. A watchlist entry can only narrow the questions to a subset of those.
// What is stored per answer: the graded verdicts, the facts the answer stated, and short quote snippets
// (at most MAX_QUOTE characters). The answer text itself is not kept.

import { findSubject, gradeAll, questionsFor, visibility, type Finding, type Question, type Subject, type Verdict } from './check.ts';
import { KIND_NAMES, QUESTION_NAMES, kindOf, type Kind } from './scoreboard.ts';

export const REPORT_FORMAT = 'iomarkets.assurance-report.v1';
export const MAX_QUOTE = 300;

/** Subjects a workspace may watch, by plan (workspaces.plan: trial, team, enterprise). */
export const WATCH_LIMITS: Record<string, number> = { trial: 5, team: 15, enterprise: 40 };
/** Engine calls (subject × engine) a workspace may attempt a UTC day, by plan: the cost guard. */
export const DAILY_ENGINE_CALLS: Record<string, number> = { trial: 30, team: 90, enterprise: 240 };
export const watchLimit = (plan: string) => WATCH_LIMITS[plan] ?? WATCH_LIMITS.trial;
export const dailyLimit = (plan: string) => DAILY_ENGINE_CALLS[plan] ?? DAILY_ENGINE_CALLS.trial;

// ---- the watchlist ----

export type WatchEntry = { query: string; name: string; kind: Kind; questions: Question['id'][] };

/** A ticker, name, CIK, FIGI, ISIN or token symbol → what would be asked about it, or why it cannot be watched. */
export function watchEntry(input: unknown, only?: unknown): { entry: WatchEntry; id: string } | { error: string } {
  if (typeof input !== 'string' || !input.trim()) return { error: 'subject is a ticker, company name, token symbol or ISIN.' };
  const q = input.trim();
  const s = findSubject(q);
  if (!s) return { error: `"${q}" is not in the corporate actions feed or the Tokenized Asset Map, so there is no answer key to grade against.` };
  const can = questionsFor(s);
  if (!can.length) return { error: `"${s.name}" has no fact the answer key can grade right now (no dividend, split or merger in the feed, no tokens in the map).` };
  let ids = can.map((x) => x.id);
  if (only !== undefined && only !== null) {
    if (!Array.isArray(only) || !only.length || only.some((x) => typeof x !== 'string')) return { error: `questions is a list of question ids from: ${ids.join(', ')}.` };
    const bad = (only as string[]).filter((x) => !ids.includes(x as Question['id']));
    if (bad.length) return { error: `${s.name}: the answer key cannot grade ${bad.join(', ')}. It can grade: ${ids.join(', ')}.` };
    ids = ids.filter((x) => (only as string[]).includes(x));
  }
  return { entry: { query: q.slice(0, 120), name: s.name, kind: kindOf(s), questions: ids }, id: s.cik ?? s.entries[0]?.id ?? s.name };
}

/** The questions to ask about a subject for a watchlist entry (a subset of what the key can grade). */
export const questionsOf = (s: Subject, ids: string[] | null): Question[] => questionsFor(s).filter((q) => !ids || ids.includes(q.id));

// ---- what one run saw ----

export type StoredFinding = { question: Question['id']; fact: string; expected: string; stated: string | null; verdict: Verdict; source: string; quote: string | null };
export type Observation = {
  subject: string;
  name: string;
  engine: string;
  ok: boolean;
  error?: string;
  mentioned: boolean;
  primaryCited: boolean;
  citations: number;
  findings: StoredFinding[];
};

/** A short piece of the answer around the stated fact, at most MAX_QUOTE characters; null when it cannot be located. */
export function quoteOf(text: string, stated: string | null): string | null {
  if (!stated) return null;
  const bare = stated.replace(/^(?:\$|[A-Z]{3} )/, '');
  const at = [stated, bare].map((x) => text.indexOf(x)).find((i) => i >= 0);
  if (at === undefined) return null;
  const from = Math.max(0, at - 100);
  const cut = text.slice(from, at + stated.length + 100).replace(/\s+/g, ' ').trim();
  return (from > 0 ? '…' : '') + cut.slice(0, MAX_QUOTE - 1);
}
export const withQuote = (f: Finding, text: string): StoredFinding => ({ ...f, quote: f.verdict === 'wrong' || f.verdict === 'out-of-date' ? quoteOf(text, f.stated) : null });

/** Grades one engine's answer for a watched subject, keeping only verdicts, facts and short quotes (the answer text is dropped). */
export function observe(query: string, s: Subject, qs: Question[], engine: string, a: { ok: true; text: string; citations: string[] } | { ok: false; error: string }): Observation {
  const base = { subject: query, name: s.name, engine };
  if (!a.ok) return { ...base, ok: false, error: a.error, mentioned: false, primaryCited: false, citations: 0, findings: [] };
  const v = visibility(s, a.text, a.citations);
  return { ...base, ok: true, mentioned: v.mentioned, primaryCited: v.primarySourceCited, citations: v.citations.length, findings: gradeAll(s, qs, a.text, true).map((f) => withQuote(f, a.text)) };
}

// ---- issues ----

export type IssueKind = 'wrong' | 'out-of-date' | 'citation-lost';
export type Severity = 'critical' | 'high' | 'medium' | 'low';
export type IssueStatus = 'open' | 'acknowledged' | 'fixed' | 'ignored';
export const ISSUE_STATUSES: IssueStatus[] = ['open', 'acknowledged', 'fixed', 'ignored'];

export type Issue = {
  key: string;
  subject: string;
  name: string;
  engine: string;
  kind: IssueKind;
  question: Question['id'] | 'visibility';
  fact: string;
  severity: Severity;
  status: IssueStatus;
  expected: string;
  stated: string | null;
  quote: string | null;
  source: string;
  first_run: string;
  last_run: string;
  seen: number;
  reopened: number;
  resolved_run: string | null;
  resolved_reason: string | null;
  note: string | null;
};

const factKey = (f: { question: string; fact: string; stated: string | null }) => `${f.question}|${f.fact}${f.fact === 'Contract address' ? `|${f.stated}` : ''}`;
export const issueKey = (subject: string, engine: string, kind: IssueKind, fact: string) => `${subject}|${engine}|${kind}|${fact}`;

/** A wrong token contract can send money to the wrong place; wrong numbers and dates are high; stale ones medium; a lost citation low. */
export function severityOf(kind: IssueKind, question: string, fact: string): Severity {
  if (kind === 'citation-lost') return 'low';
  if (kind === 'out-of-date') return 'medium';
  return question === 'tokens' && /contract/i.test(fact) ? 'critical' : question === 'identity' ? 'medium' : 'high';
}
const SEV_RANK: Record<Severity, number> = { critical: 3, high: 2, medium: 1, low: 0 };
export const severityRank = (s: Severity) => SEV_RANK[s];

type Problem = Omit<Issue, 'status' | 'first_run' | 'last_run' | 'seen' | 'reopened' | 'resolved_run' | 'resolved_reason' | 'note'>;
function problemsOf(obs: Observation[]): Problem[] {
  const out: Problem[] = [];
  for (const o of obs) {
    if (!o.ok) continue;
    for (const f of o.findings) {
      if (f.verdict !== 'wrong' && f.verdict !== 'out-of-date') continue;
      const fact = factKey(f);
      out.push({ key: issueKey(o.subject, o.engine, f.verdict, fact), subject: o.subject, name: o.name, engine: o.engine, kind: f.verdict, question: f.question, fact: f.fact, severity: severityOf(f.verdict, f.question, f.fact), expected: f.expected, stated: f.stated, quote: f.quote, source: f.source });
    }
  }
  return out;
}

export type Change = { type: 'new-wrong' | 'new-out-of-date' | 'fixed' | 'citation-lost' | 'citation-gained'; subject: string; name: string; engine: string; fact: string; severity?: Severity };

/** What differs between two runs of the same watchlist: new wrong or out-of-date answers, answers now fixed, citations lost or won. A first run (no previous) reports everything wrong as new. */
export function diffRuns(prev: Observation[] | null, cur: Observation[]): Change[] {
  const before = new Map<string, Observation>((prev ?? []).map((o) => [`${o.subject}|${o.engine}`, o]));
  const out: Change[] = [];
  for (const o of cur) {
    if (!o.ok) continue;
    const p = before.get(`${o.subject}|${o.engine}`);
    const was = new Map((p?.ok ? p.findings : []).map((f) => [factKey(f), f.verdict]));
    for (const f of o.findings) {
      const w = was.get(factKey(f));
      const bad = (v?: Verdict) => v === 'wrong' || v === 'out-of-date';
      if (bad(f.verdict) && !(w === f.verdict)) out.push({ type: f.verdict === 'wrong' ? 'new-wrong' : 'new-out-of-date', subject: o.subject, name: o.name, engine: o.engine, fact: f.fact, severity: severityOf(f.verdict as IssueKind, f.question, f.fact) });
      if (bad(w) && f.verdict === 'right') out.push({ type: 'fixed', subject: o.subject, name: o.name, engine: o.engine, fact: f.fact });
    }
    if (p?.ok && p.primaryCited && !o.primaryCited) out.push({ type: 'citation-lost', subject: o.subject, name: o.name, engine: o.engine, fact: 'Primary source cited', severity: 'low' });
    if (p?.ok && !p.primaryCited && o.primaryCited) out.push({ type: 'citation-gained', subject: o.subject, name: o.name, engine: o.engine, fact: 'Primary source cited' });
  }
  return out;
}

/**
 * Brings the stored issues up to date with a finished run.
 * - A problem seen now: a new open issue, or the existing one counted again; a fixed one is reopened; an ignored one stays ignored.
 * - An open or acknowledged issue whose subject and engine answered in this run, and no longer has the problem, is fixed automatically.
 * - A citation lost is an issue only when the previous run cited the primary source (that is what "lost" means);
 *   it resolves when the primary source is cited again.
 * Engines that failed to answer change nothing.
 */
export function reconcileIssues(existing: Issue[], prev: Observation[] | null, cur: Observation[], runId: string): Issue[] {
  const byKey = new Map(existing.map((i) => [i.key, { ...i }]));
  const touched = new Set<string>();
  const now = new Map<string, Problem>(problemsOf(cur).map((p) => [p.key, p]));
  const prevCited = new Map((prev ?? []).filter((o) => o.ok).map((o) => [`${o.subject}|${o.engine}`, o.primaryCited]));
  for (const o of cur) {
    if (!o.ok) continue;
    const k = issueKey(o.subject, o.engine, 'citation-lost', 'primary-source');
    if (!o.primaryCited && (prevCited.get(`${o.subject}|${o.engine}`) || byKey.has(k) && byKey.get(k)!.status !== 'fixed')) {
      now.set(k, { key: k, subject: o.subject, name: o.name, engine: o.engine, kind: 'citation-lost', question: 'visibility', fact: 'Primary source cited', severity: 'low', expected: 'a citation of the primary source (SEC filing or the issuer’s own page)', stated: null, quote: null, source: '' });
    }
  }
  const answered = new Set(cur.filter((o) => o.ok).map((o) => `${o.subject}|${o.engine}`));
  for (const [k, p] of now) {
    touched.add(k);
    const i = byKey.get(k);
    if (!i) {
      byKey.set(k, { ...p, status: 'open', first_run: runId, last_run: runId, seen: 1, reopened: 0, resolved_run: null, resolved_reason: null, note: null });
      continue;
    }
    const reopen = i.status === 'fixed';
    Object.assign(i, { ...p, status: reopen ? 'open' : i.status, last_run: runId, seen: i.seen + 1, reopened: i.reopened + (reopen ? 1 : 0), resolved_run: reopen ? null : i.resolved_run, resolved_reason: reopen ? null : i.resolved_reason });
  }
  for (const i of byKey.values()) {
    if (touched.has(i.key) || (i.status !== 'open' && i.status !== 'acknowledged') || !answered.has(`${i.subject}|${i.engine}`)) continue;
    i.status = 'fixed';
    i.resolved_run = runId;
    i.resolved_reason = i.kind === 'citation-lost' ? 'the primary source was cited again' : 'the next run stated this fact right, or no longer stated it wrongly';
    i.last_run = runId;
  }
  return [...byKey.values()].sort((a, b) => severityRank(b.severity) - severityRank(a.severity) || a.first_run.localeCompare(b.first_run) || a.key.localeCompare(b.key));
}

/** The statuses a person may move an issue to by hand (auto-resolve does the rest). */
export const MANUAL: Record<IssueStatus, IssueStatus[]> = { open: ['acknowledged', 'ignored', 'fixed'], acknowledged: ['open', 'ignored', 'fixed'], ignored: ['open'], fixed: ['open'] };
export const canMove = (from: IssueStatus, to: IssueStatus) => MANUAL[from].includes(to);

// ---- remediation ----

export type Remediation = { text: string; links: { href: string; label: string }[] };
const PUBLISH = { href: '/publish', label: 'Notice Publisher' };
const READY = { href: '/ai-readiness', label: 'AI readiness check' };
const MAP = { href: '/asset-map', label: 'Tokenized Asset Map' };

/** What to do about an issue. The links are paths on iomarkets.tech. These are suggestions, not guarantees: an engine may take days to pick a fix up. */
export function remediation(i: Pick<Issue, 'kind' | 'question'>): Remediation {
  if (i.kind === 'citation-lost')
    return { text: 'Make the primary source easy for AI crawlers to reach: check robots.txt and llms.txt allow the AI bots, and that the page carrying the facts is in the sitemap. Fix what the readiness check flags at /ai-readiness.', links: [READY] };
  if (i.question === 'tokens' || i.question === 'identity')
    return { text: 'Publish the official contract addresses and identifiers on your own site in machine-readable form, and publish the notice with Notice Publisher at /publish so engines have a primary source to cite. Check your Asset Map entry lists every chain.', links: [PUBLISH, MAP] };
  return {
    text: i.kind === 'out-of-date'
      ? 'The engine is quoting an earlier event. Publish your notice for the current one via Notice Publisher at /publish, linking the filing, and check robots/llms.txt via /ai-readiness so engines can reach it.'
      : 'Publish your notice via Notice Publisher at /publish so the correct figures sit on a page you control, linking the SEC filing; check robots/llms.txt via /ai-readiness so engines can reach it.',
    links: [PUBLISH, READY],
  };
}

// ---- the report ----

export type RunSummary = { id: string; at: string; observations: Observation[] };
type EngineLine = { engine: string; model?: string; answers: number; failed: number; right: number; wrong: number; outOfDate: number; accuracy: number | null; citationRate: number | null; mentionRate: number | null };

const pct = (a: number, b: number) => (b ? Math.round((100 * a) / b) : null);
function engineLine(engine: string, obs: Observation[]): EngineLine {
  const mine = obs.filter((o) => o.engine === engine);
  const ok = mine.filter((o) => o.ok);
  const c = (v: Verdict) => ok.reduce((n, o) => n + o.findings.filter((f) => f.verdict === v).length, 0);
  const [right, wrong, outOfDate] = [c('right'), c('wrong'), c('out-of-date')];
  return { engine, answers: ok.length, failed: mine.length - ok.length, right, wrong, outOfDate, accuracy: pct(right, right + wrong + outOfDate), citationRate: pct(ok.filter((o) => o.primaryCited).length, ok.length), mentionRate: pct(ok.filter((o) => o.mentioned).length, ok.length) };
}

export const METHODOLOGY = [
  'Each watched subject is looked up in the corporate actions feed (SEC filings) and the Tokenized Asset Map (issuers’ own pages): that is the answer key.',
  'The same numbered questions go to each connected AI search engine through its official API with web search on.',
  'Every date, amount, ratio, contract address and identifier in an answer is read out of the text and compared with the key by rules, with no model grading. Right, wrong and out of date are what the answer stated and the key can judge; accuracy is right over those three. Facts an answer did not state, and contract addresses the map does not know either way, are not counted against it.',
  'Out of date means the answer quoted an earlier event of the same subject. Citation rate is the share of answers that cite the primary source (sec.gov for a company, the issuer’s own sites for a token).',
  'What is kept per answer: the verdicts, the stated and expected facts and quote snippets of at most 300 characters. The answer text is not kept.',
  'Limits: only the questions the key can grade are asked; an engine’s answer can vary run to run; the report covers the subjects, engines and runs listed, not AI engines in general.',
];

export type AssuranceReport = {
  format: typeof REPORT_FORMAT;
  /** 'example' for the public sample, which is built from written example answers and carries no signature. */
  label: 'example' | 'workspace';
  workspace: string;
  workspace_name?: string;
  period: string;
  generated: string;
  subjects: { query: string; name: string; kind: Kind; questions: string[] }[];
  runs: { id: string; at: string; subjects: number }[];
  engines: EngineLine[];
  trend: { run: string; at: string; engines: { engine: string; accuracy: number | null; citationRate: number | null }[] }[];
  issues: { open: (Issue & { remediation: Remediation })[]; fixed_in_period: number; ignored: number; by_severity: Record<Severity, number> };
  changes: { run: string; changes: Change[] }[];
  methodology: string[];
  notes: string[];
};

/** The monthly report: accuracy per engine over the period's runs, the trend run by run, open issues with what to do, citation rate, methodology. */
export function buildReport(a: {
  workspace: string;
  workspaceName?: string;
  period: string;
  generated: string;
  label: AssuranceReport['label'];
  watchlist: WatchEntry[];
  runs: RunSummary[];
  changes?: { run: string; changes: Change[] }[];
  issues: Issue[];
  notes?: string[];
}): AssuranceReport {
  const all = a.runs.flatMap((r) => r.observations);
  const engines = [...new Set(all.map((o) => o.engine))].sort();
  const open = a.issues.filter((i) => i.status === 'open' || i.status === 'acknowledged');
  const sev: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const i of open) sev[i.severity]++;
  return {
    format: REPORT_FORMAT,
    label: a.label,
    workspace: a.workspace,
    ...(a.workspaceName ? { workspace_name: a.workspaceName } : {}),
    period: a.period,
    generated: a.generated,
    subjects: a.watchlist.map((w) => ({ query: w.query, name: w.name, kind: w.kind, questions: w.questions })),
    runs: a.runs.map((r) => ({ id: r.id, at: r.at, subjects: new Set(r.observations.map((o) => o.subject)).size })),
    engines: engines.map((e) => engineLine(e, all)),
    trend: a.runs.map((r) => ({ run: r.id, at: r.at, engines: engines.map((e) => { const l = engineLine(e, r.observations); return { engine: e, accuracy: l.accuracy, citationRate: l.citationRate }; }) })),
    issues: {
      open: open.map((i) => ({ ...i, remediation: remediation(i) })),
      fixed_in_period: a.issues.filter((i) => i.status === 'fixed' && i.resolved_run && a.runs.some((r) => r.id === i.resolved_run)).length,
      ignored: a.issues.filter((i) => i.status === 'ignored').length,
      by_severity: sev,
    },
    changes: a.changes ?? [],
    methodology: METHODOLOGY,
    notes: a.notes ?? [],
  };
}

const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const pc = (n: number | null) => (n === null ? '–' : `${n}%`);

/** A printable page of the report (self-contained, no scripts). `signature` is shown when the report is signed. */
export function reportHtml(r: AssuranceReport, signature?: { sha256: string; key_id: string; sig: string } | null): string {
  const rows = (cells: unknown[][]) => cells.map((c) => `<tr>${c.map((x) => `<td>${esc(x)}</td>`).join('')}</tr>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>AI answer assurance report ${esc(r.period)}${r.label === 'example' ? ' (example)' : ''}</title>
<style>body{font:14px/1.5 system-ui,sans-serif;max-width:860px;margin:2rem auto;padding:0 1rem;color:#111}h1{font-size:1.6rem}h2{margin-top:2rem;font-size:1.1rem}table{border-collapse:collapse;width:100%;margin:.5rem 0}td,th{border:1px solid #ccc;padding:.35rem .5rem;text-align:left;vertical-align:top}th{background:#f3f3f3}.ex{background:#fff4d6;border:1px solid #e0b84a;padding:.6rem .8rem;border-radius:6px}code{font-size:12px;word-break:break-all}@media print{.ex{border-color:#999}}</style></head><body>
<h1>AI answer assurance report: ${esc(r.workspace_name ?? r.workspace)}, ${esc(r.period)}</h1>
${r.label === 'example' ? '<p class="ex"><strong>Example.</strong> The answers behind this report were written for the example, not recorded from a real AI engine; the grading, diffing, issues and layout are the real code. It is not signed.</p>' : ''}
<p>Generated ${esc(r.generated)}. ${r.runs.length} run(s), ${r.subjects.length} watched subject(s).</p>
<h2>Accuracy by engine</h2><table><tr><th>Engine</th><th>Accuracy</th><th>Right</th><th>Wrong</th><th>Out of date</th><th>Cites primary source</th><th>Answers (failed)</th></tr>${rows(r.engines.map((e) => [e.engine, pc(e.accuracy), e.right, e.wrong, e.outOfDate, pc(e.citationRate), `${e.answers} (${e.failed})`]))}</table>
<h2>Trend</h2><table><tr><th>Run</th><th>Time (UTC)</th>${r.engines.map((e) => `<th>${esc(e.engine)}</th>`).join('')}</tr>${rows(r.trend.map((t) => [t.run, t.at, ...t.engines.map((e) => pc(e.accuracy))]))}</table>
<h2>Open issues (${r.issues.open.length})</h2>${r.issues.open.length ? `<table><tr><th>Severity</th><th>Subject / engine</th><th>What</th><th>Expected</th><th>Said</th><th>What to do</th></tr>${r.issues.open.map((i) => `<tr><td>${esc(i.severity)}</td><td>${esc(i.name)} / ${esc(i.engine)}</td><td>${esc(i.kind)}: ${esc(i.fact)}</td><td>${esc(i.expected)}</td><td>${esc(i.stated ?? '–')}${i.quote ? `<br><em>${esc(i.quote)}</em>` : ''}</td><td>${esc(i.remediation.text)} ${i.remediation.links.map((l) => `<a href="https://iomarkets.tech${esc(l.href)}">${esc(l.label)}</a>`).join(', ')}</td></tr>`).join('')}</table>` : '<p>None.</p>'}
<p>${r.issues.fixed_in_period} fixed in the period; ${r.issues.ignored} ignored by your team.</p>
<h2>Methodology</h2><ul>${r.methodology.map((m) => `<li>${esc(m)}</li>`).join('')}</ul>
${r.notes.length ? `<h2>Notes</h2><ul>${r.notes.map((m) => `<li>${esc(m)}</li>`).join('')}</ul>` : ''}
<h2>Signature</h2>${signature ? `<p>SHA-256 of the report JSON: <code>${esc(signature.sha256)}</code><br>ed25519 signature by key <code>${esc(signature.key_id)}</code>: <code>${esc(signature.sig)}</code><br>Check it offline: <code>node scripts/verify-assurance-report.mjs report.json</code> against the keys at GET /api/workspaces.</p>` : '<p>Unsigned.</p>'}
</body></html>`;
}

export const QUESTION_LABELS = QUESTION_NAMES;
export const KIND_LABELS = KIND_NAMES;
