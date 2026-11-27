// Feeds and alert payloads built from assurance results and scoreboard results. Pure and dependency-free (apart from
// types): XML escaping, the two Atom documents, Slack/Teams/JSON alert bodies, the weekly digest text.
// Nothing here ever receives an engine's answer text: callers pass verdicts and facts only.

import type { Change, Issue } from './assurance.ts';

const ORIGIN = 'https://iomarkets.tech';

export const xmlEscape = (s: string) =>
  s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

/** A feed token: 48 hex characters (192 bits) from the platform's CSPRNG. Only its SHA-256 is stored. */
export const FEED_TOKEN = /^[a-f0-9]{48}$/;
export const newFeedToken = () => Array.from(crypto.getRandomValues(new Uint8Array(24)), (x) => x.toString(16).padStart(2, '0')).join('');

const NAMES: Record<string, string> = { perplexity: 'Perplexity', openai: 'ChatGPT search', gemini: 'Gemini' };
export const engineName = (e: string) => NAMES[e] ?? e;

type Entry = { id: string; title: string; updated: string; link?: string; summary: string };
const iso = (s: string) => (Number.isNaN(Date.parse(s)) ? new Date(0).toISOString() : new Date(s).toISOString());

function atom(o: { id: string; title: string; subtitle: string; self: string; alt: string; entries: Entry[] }): string {
  const entries = o.entries.slice().sort((a, b) => b.updated.localeCompare(a.updated));
  const updated = entries[0]?.updated ?? new Date(0).toISOString();
  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <id>${xmlEscape(o.id)}</id>
  <title>${xmlEscape(o.title)}</title>
  <subtitle>${xmlEscape(o.subtitle)}</subtitle>
  <updated>${updated}</updated>
  <link rel="self" href="${xmlEscape(o.self)}"/>
  <link rel="alternate" href="${xmlEscape(o.alt)}"/>
  <author><name>IoMarkets.tech</name></author>
${entries.map((e) => `  <entry>
    <id>${xmlEscape(e.id)}</id>
    <title>${xmlEscape(e.title)}</title>
    <updated>${e.updated}</updated>${e.link ? `\n    <link rel="alternate" href="${xmlEscape(e.link)}"/>` : ''}
    <summary type="text">${xmlEscape(e.summary)}</summary>
  </entry>`).join('\n')}
</feed>
`;
}

// ---- the private workspace feed ----

export type FeedIssue = Pick<Issue, 'subject' | 'name' | 'engine' | 'kind' | 'question' | 'fact' | 'severity' | 'status' | 'expected' | 'stated' | 'first_run' | 'last_run' | 'source'> & { id: string; updated: string };
export type FeedRun = { id: string; day: string; finished: string; answered: number; changes: Change[] };

const CHANGE_WORDS: Record<Change['type'], string> = { 'new-wrong': 'new wrong answer', 'new-out-of-date': 'new out-of-date answer', fixed: 'fixed', 'citation-lost': 'primary source no longer cited', 'citation-gained': 'primary source now cited' };

/**
 * The workspace's Atom feed: its issues (verdicts, the stated and expected value) and its finished runs (what changed).
 * No quote snippet and no answer text goes in: the feed URL is a bearer secret that may sit in a reader or a chat app.
 */
export function assuranceAtom(w: { id: string; name: string }, token: string, issues: FeedIssue[], runs: FeedRun[]): string {
  const entries: Entry[] = [
    ...issues.map((i) => ({
      id: `urn:iomarkets:assurance:${w.id}:issue:${i.id}:${i.status}:${i.last_run}`,
      title: `[${i.severity}] ${engineName(i.engine)} ${i.kind === 'citation-lost' ? 'stopped citing the primary source for' : `has ${i.kind === 'out-of-date' ? 'an out-of-date' : 'a wrong'} ${i.fact.toLowerCase()} for`} ${i.name} (${i.status})`,
      updated: iso(i.updated),
      link: `${ORIGIN}/assurance`,
      summary: [`${i.name} (${i.subject}), ${engineName(i.engine)}: ${i.fact}.`, i.stated ? `Stated: ${i.stated}.` : '', `Expected: ${i.expected}.`, `Status: ${i.status}; first seen in ${i.first_run}, last in ${i.last_run}.`, i.source ? `Source: ${i.source}` : ''].filter(Boolean).join(' '),
    })),
    ...runs.map((r) => ({
      id: `urn:iomarkets:assurance:${w.id}:run:${r.id}`,
      title: `Run ${r.day}: ${r.changes.filter((c) => c.type !== 'citation-gained').length} change(s), ${r.answered} answers`,
      updated: iso(r.finished),
      link: `${ORIGIN}/assurance`,
      summary: r.changes.length ? r.changes.map((c) => `${c.name} / ${engineName(c.engine)}: ${CHANGE_WORDS[c.type]} (${c.fact})`).join('; ') : 'Nothing changed since the run before.',
    })),
  ];
  return atom({ id: `urn:iomarkets:assurance:${w.id}`, title: `AI answer assurance: ${w.name}`, subtitle: 'Issues and run results. Private: anyone with this address can read it.', self: `${ORIGIN}/api/assurance/feed/${token}.atom`, alt: `${ORIGIN}/assurance`, entries });
}

// ---- alert payloads ----

export type AlertFormat = 'json' | 'slack' | 'teams';
export const ALERT_FORMATS: AlertFormat[] = ['json', 'slack', 'teams'];

export const changeLine = (c: Change) => `${c.severity ? `[${c.severity}] ` : ''}${c.name} on ${engineName(c.engine)}: ${CHANGE_WORDS[c.type]} (${c.fact})`;

/** The text a person reads in a chat message: no engine answer text, only verdicts. */
export function alertText(workspaceName: string, run: string, changes: Change[]): string {
  return [`AI answer assurance, ${workspaceName}: ${changes.length} change(s) in run ${run}`, ...changes.slice(0, 20).map((c) => `- ${changeLine(c)}`), changes.length > 20 ? `...and ${changes.length - 20} more.` : '', `Details: ${ORIGIN}/assurance`].filter(Boolean).join('\n');
}

/** Slack (incoming webhook) and Teams (incoming webhook, MessageCard) bodies; json is the signed machine format. */
export function alertBody(format: AlertFormat, a: { workspace: string; workspaceName: string; run: string; sent: string; minSeverity: string; changes: Change[] }): Record<string, unknown> {
  if (format === 'slack') return { text: alertText(a.workspaceName, a.run, a.changes) };
  if (format === 'teams')
    return { '@type': 'MessageCard', '@context': 'https://schema.org/extensions', summary: `AI answer assurance: ${a.changes.length} change(s)`, title: `AI answer assurance, ${a.workspaceName}`, text: [`Run ${a.run}`, ...a.changes.slice(0, 20).map((c) => `- ${changeLine(c)}`)].join('\n\n') };
  return { type: 'assurance.alert', workspace: a.workspace, run: a.run, sent: a.sent, min_severity: a.minSeverity, changes: a.changes, report: 'POST /api/assurance { "action": "report" }' };
}

// ---- the weekly digest ----

export type DigestRun = { id: string; day: string; changes: Change[] };
export function digestText(w: { name: string }, since: string, until: string, runs: DigestRun[], open: Pick<FeedIssue, 'name' | 'engine' | 'fact' | 'severity' | 'status' | 'expected' | 'stated'>[]): string {
  const changes = runs.flatMap((r) => r.changes.filter((c) => c.type !== 'citation-gained'));
  const count = (t: Change['type']) => changes.filter((c) => c.type === t).length;
  const L = [
    `# AI answer assurance: weekly digest for ${w.name}`,
    `${since} to ${until} (UTC). ${runs.length} finished run(s).`,
    '',
    `New wrong answers: ${count('new-wrong')}. New out-of-date answers: ${count('new-out-of-date')}. Fixed: ${count('fixed')}. Primary source lost: ${count('citation-lost')}.`,
    '',
    '## Open issues',
    ...(open.length ? open.map((i) => `- [${i.severity}] ${i.name}, ${engineName(i.engine)}: ${i.fact}${i.stated ? `, said ${i.stated}` : ''}, expected ${i.expected} (${i.status})`) : ['None.']),
    '',
    '## Changes this week',
    ...(changes.length ? runs.flatMap((r) => r.changes.filter((c) => c.type !== 'citation-gained').map((c) => `- ${r.day}: ${changeLine(c)}`)) : ['None.']),
    '',
    `Graded by rules against SEC filings and issuers' own pages; accuracy covers the listed engines and questions only. Full report: ${ORIGIN}/assurance`,
  ];
  return L.join('\n');
}

// ---- the public feed: "AI got it wrong" ----

export type WrongRow = { week: string; finished: string; subject: string; name: string; engine: string; model: string; findings: { question: string; fact: string; expected: string; stated: string | null; verdict: string; source: string }[] };
export type WrongItem = { week: string; finished: string; subject: string; name: string; engine: string; model: string; question: string; fact: string; verdict: 'wrong' | 'out-of-date'; claimed: string | null; filing: string; source: string };

export const wrongItems = (rows: WrongRow[]): WrongItem[] =>
  rows.flatMap((r) => r.findings.filter((f) => f.verdict === 'wrong' || f.verdict === 'out-of-date').map((f) => ({ week: r.week, finished: r.finished, subject: r.subject, name: r.name, engine: r.engine, model: r.model, question: f.question, fact: f.fact, verdict: f.verdict as 'wrong' | 'out-of-date', claimed: f.stated, filing: f.expected, source: f.source })));

const linkOf = (s: string) => (/^https?:\/\//.test(s) ? s.split(' ')[0] : `${ORIGIN}/ai-scoreboard`);
const itemTitle = (i: WrongItem) => `${i.week}: ${engineName(i.engine)} got ${i.name} (${i.subject}) ${i.fact.toLowerCase()} ${i.verdict === 'wrong' ? 'wrong' : 'out of date'}`;

export function wrongAtom(items: WrongItem[]): string {
  return atom({
    id: 'urn:iomarkets:ai-scoreboard:wrong',
    title: 'AI got it wrong: financial facts AI search engines stated incorrectly',
    subtitle: 'Wrong and out-of-date answers from the weekly IoMarkets.tech AI accuracy scoreboard, each with the value in the filing. Graded by rules, no model.',
    self: `${ORIGIN}/api/ai-scoreboard/feed.xml`,
    alt: `${ORIGIN}/ai-scoreboard`,
    entries: items.map((i) => ({
      id: `urn:iomarkets:ai-scoreboard:${i.week}:${i.subject}:${i.engine}:${i.question}:${i.fact}:${i.claimed ?? ''}`,
      title: itemTitle(i),
      updated: iso(i.finished),
      link: linkOf(i.source),
      summary: `${engineName(i.engine)} (${i.model}) said ${i.claimed ?? 'something unreadable'} for ${i.fact} of ${i.name}; the filing says ${i.filing}. Verdict: ${i.verdict}. Source: ${i.source}`,
    })),
  });
}

export const wrongJson = (items: WrongItem[]) => ({
  name: 'AI got it wrong',
  about: 'Wrong and out-of-date answers from the weekly AI accuracy scoreboard, with the value in the filing. Results are CC0.',
  scoreboard: `${ORIGIN}/ai-scoreboard`,
  count: items.length,
  items: items.map((i) => ({ week: i.week, subject: i.subject, name: i.name, engine: i.engine, model: i.model, question: i.question, fact: i.fact, verdict: i.verdict, claimed: i.claimed, filing: i.filing, source: i.source, link: linkOf(i.source) })),
});
