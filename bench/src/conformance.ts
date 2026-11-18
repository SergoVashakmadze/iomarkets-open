// Conformance CI: a counterparty's own rules, on top of the ISO 20022 base standard the bench checks.
//
// A test pack (format iomarkets.conformance-pack.v1) names the messages a counterparty takes, the base issue
// codes it tolerates, and its extra rules: an element required, forbidden, limited to some values, a length, a
// pattern, a count. A run checks every message with validate() and the pack, and a run compared with the last
// passing one lists the new failures first. Pure: used by the CLI (--pack), the GitHub Action (pack input) and
// /api/conformance, which signs the report for a workspace.

import { validate, type Issue } from './index.ts';
import { parseXml, type XmlElement } from './xml.ts';

export const PACK_FORMAT = 'iomarkets.conformance-pack.v1';
export const RUN_FORMAT = 'iomarkets.conformance-run.v1';
export const MAX_RULES = 200;
export const MAX_FILES = 500;

export type PackRule = {
  /** Stable id, shown with every failure (e.g. "ACME-07"). */
  id: string;
  /** Only for this message, e.g. pacs.008.001.08. Leave out for every message in the pack. */
  message?: string;
  /** Slash path under the message's root element, e.g. CdtTrfTxInf/PmtId/UETR; end with /@Ccy for an attribute. */
  path: string;
  require?: boolean;
  forbid?: boolean;
  allowed?: string[];
  maxLength?: number;
  pattern?: string;
  maxCount?: number;
  severity?: 'error' | 'warning';
  /** Why the counterparty asks for it: shown with the failure. */
  why?: string;
};
export type Pack = {
  format: typeof PACK_FORMAT;
  name: string;
  counterparty?: string;
  /** Message identifiers the counterparty takes; anything else fails. Empty or absent: any the bench checks. */
  messages?: string[];
  /** Base issue codes the counterparty accepts (e.g. a CBPR+ warning it does not apply). */
  ignore?: string[];
  /** Warnings fail too. */
  strict?: boolean;
  rules: PackRule[];
};

export type RunIssue = Issue | (Omit<Issue, 'layer'> & { layer: 'pack'; rule: string });
export type FileResult = { name: string; message: string | null; passed: boolean; errors: number; warnings: number; issues: RunIssue[] };
export type Run = {
  format: typeof RUN_FORMAT;
  pack: { name: string; counterparty?: string; rules: number };
  checked_at: string;
  passed: boolean;
  files: FileResult[];
  summary: { files: number; passed: number; failed: number; by_code: Record<string, number> };
};
export type Comparison = { new_failures: { file: string; code: string; path: string; rule?: string }[]; fixed: { file: string; code: string; path: string }[]; still_failing: number };

/** Checks a pack's shape and returns it typed, or a reason it cannot be used. */
export function parsePack(input: unknown): Pack | { error: string } {
  const p = (typeof input === 'string' ? safeJson(input) : input) as Partial<Pack> | null;
  if (!p || typeof p !== 'object') return { error: 'A pack is a JSON object.' };
  if (p.format !== PACK_FORMAT) return { error: `A pack has "format": "${PACK_FORMAT}".` };
  if (typeof p.name !== 'string' || !p.name.trim()) return { error: 'A pack has a "name".' };
  if (!Array.isArray(p.rules)) return { error: 'A pack has "rules": a list (it may be empty).' };
  if (p.rules.length > MAX_RULES) return { error: `At most ${MAX_RULES} rules in a pack.` };
  const ids = new Set<string>();
  for (const [i, r] of p.rules.entries()) {
    const at = `rules[${i}]`;
    if (!r || typeof r !== 'object') return { error: `${at} is not an object.` };
    if (typeof r.id !== 'string' || !r.id) return { error: `${at} needs an "id".` };
    if (ids.has(r.id)) return { error: `Two rules have the id "${r.id}".` };
    ids.add(r.id);
    if (typeof r.path !== 'string' || !/^[A-Za-z0-9]+(\/[A-Za-z0-9]+)*(\/@[A-Za-z0-9:]+)?$/.test(r.path)) return { error: `${r.id}: "path" is element names joined by /, optionally ending in /@Attribute.` };
    const checks = ['require', 'forbid', 'allowed', 'maxLength', 'pattern', 'maxCount'].filter((k) => (r as Record<string, unknown>)[k] !== undefined);
    if (!checks.length) return { error: `${r.id}: say what to check (require, forbid, allowed, maxLength, pattern or maxCount).` };
    if (r.allowed !== undefined && (!Array.isArray(r.allowed) || r.allowed.some((x) => typeof x !== 'string'))) return { error: `${r.id}: "allowed" is a list of values.` };
    for (const k of ['maxLength', 'maxCount'] as const) if (r[k] !== undefined && (!Number.isInteger(r[k]) || (r[k] as number) < 0)) return { error: `${r.id}: "${k}" is a whole number.` };
    if (r.pattern !== undefined) {
      try {
        new RegExp(r.pattern);
      } catch {
        return { error: `${r.id}: "pattern" is not a valid regular expression.` };
      }
    }
    if (r.severity !== undefined && r.severity !== 'error' && r.severity !== 'warning') return { error: `${r.id}: "severity" is error or warning.` };
  }
  return p as Pack;
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

type Hit = { el: XmlElement; path: string };
/** Every element (or attribute value) a rule's path reaches under the message root. */
function reach(root: XmlElement, rootPath: string, path: string): { values: { text: string; path: string; line: number }[]; parents: Hit[] } {
  const parts = path.split('/');
  const attr = parts[parts.length - 1].startsWith('@') ? parts.pop()!.slice(1) : null;
  let hits: Hit[] = [{ el: root, path: rootPath }];
  let parents: Hit[] = hits;
  for (const [i, name] of parts.entries()) {
    if (i === parts.length - 1) parents = hits;
    hits = hits.flatMap((h) => {
      const kids = h.el.children.filter((c) => c.name === name);
      return kids.map((el, k) => ({ el, path: `${h.path}/${name}${kids.length > 1 ? `[${k + 1}]` : ''}` }));
    });
  }
  const values = attr
    ? hits.filter((h) => attr in h.el.attrs).map((h) => ({ text: h.el.attrs[attr], path: `${h.path}/@${attr}`, line: h.el.line }))
    : hits.map((h) => ({ text: h.el.text.trim(), path: h.path, line: h.el.line }));
  return { values, parents };
}

/** The pack's own checks on one message. */
export function checkPack(pack: Pack, xml: string, message: string | null): RunIssue[] {
  const out: RunIssue[] = [];
  let doc: XmlElement;
  try {
    doc = parseXml(xml);
  } catch {
    return out; // validate() has already reported it.
  }
  while (doc.name !== 'Document' && doc.children.length) doc = doc.children.find((c) => c.name === 'Document') ?? doc.children[0];
  const root = doc.children[0];
  if (!root) return out;
  const rootPath = `/Document/${root.name}`;
  const add = (r: PackRule, code: string, path: string, line: number, text: string) =>
    out.push({ severity: r.severity ?? 'error', layer: 'pack', rule: r.id, code, path, line, message: `${r.id}: ${text}${r.why ? ` (${r.why})` : ''}` });
  if (pack.messages?.length && message && !pack.messages.includes(message))
    out.push({ severity: 'error', layer: 'pack', rule: 'messages', code: 'PACK_MESSAGE', path: '/Document', line: doc.line, message: `${pack.counterparty ?? pack.name} takes ${pack.messages.join(', ')}, not ${message}.` });
  for (const r of pack.rules) {
    if (r.message && r.message !== message) continue;
    const { values, parents } = reach(root, rootPath, r.path);
    if (r.require && !values.length) add(r, 'PACK_REQUIRED', `${rootPath}/${r.path}`, parents[0]?.el.line ?? root.line, `${r.path} is required.`);
    if (r.forbid) for (const v of values) add(r, 'PACK_FORBIDDEN', v.path, v.line, `${r.path} must not be sent.`);
    if (r.maxCount !== undefined && values.length > r.maxCount) add(r, 'PACK_COUNT', `${rootPath}/${r.path}`, values[r.maxCount].line, `${r.path} appears ${values.length} times; at most ${r.maxCount}.`);
    for (const v of values) {
      if (r.allowed && !r.allowed.includes(v.text)) add(r, 'PACK_VALUE', v.path, v.line, `"${v.text}" is not one of ${r.allowed.join(', ')}.`);
      if (r.maxLength !== undefined && v.text.length > r.maxLength) add(r, 'PACK_LENGTH', v.path, v.line, `${v.text.length} characters; at most ${r.maxLength}.`);
      if (r.pattern && !new RegExp(r.pattern).test(v.text)) add(r, 'PACK_PATTERN', v.path, v.line, `"${v.text}" does not match ${r.pattern}.`);
    }
  }
  return out;
}

/** Checks every file against the base standard and the pack. */
export function runPack(pack: Pack, files: { name: string; xml: string }[], now = new Date()): Run {
  const ignore = new Set(pack.ignore ?? []);
  const results: FileResult[] = files.map((f) => {
    const report = validate(f.xml, { now });
    const issues: RunIssue[] = [...report.issues.filter((i) => !ignore.has(i.code)), ...(report.checked.schema ? checkPack(pack, f.xml, report.message) : [])];
    const errors = issues.filter((i) => i.severity === 'error').length;
    const warnings = issues.length - errors;
    return { name: f.name, message: report.message, passed: errors === 0 && (!pack.strict || warnings === 0), errors, warnings, issues };
  });
  const by_code: Record<string, number> = {};
  for (const f of results) for (const i of f.issues) by_code[i.code] = (by_code[i.code] ?? 0) + 1;
  const passed = results.filter((f) => f.passed).length;
  return {
    format: RUN_FORMAT,
    pack: { name: pack.name, ...(pack.counterparty ? { counterparty: pack.counterparty } : {}), rules: pack.rules.length },
    checked_at: now.toISOString(),
    passed: passed === results.length,
    files: results,
    summary: { files: results.length, passed, failed: results.length - passed, by_code },
  };
}

const failing = (r: Pick<Run, 'files'>) =>
  r.files.flatMap((f) => (f.passed ? [] : f.issues.filter((i) => i.severity === 'error').map((i) => ({ file: f.name, code: i.code, path: i.path, ...('rule' in i ? { rule: i.rule } : {}) }))));
const key = (x: { file: string; code: string; path: string }) => `${x.file}\u0000${x.code}\u0000${x.path}`;

/** What changed since a baseline run: failures that are new (listed first in a report), and ones fixed. */
export function compareRuns(baseline: Pick<Run, 'files'>, next: Pick<Run, 'files'>): Comparison {
  const before = new Set(failing(baseline).map(key));
  const now = failing(next);
  const after = new Set(now.map(key));
  // A file left out of this run is not "fixed": only files in both runs count.
  const inNext = new Set(next.files.map((f) => f.name));
  return {
    new_failures: now.filter((x) => !before.has(key(x))),
    fixed: failing(baseline).filter((x) => inNext.has(x.file) && !after.has(key(x))).map(({ file, code, path }) => ({ file, code, path })),
    still_failing: now.filter((x) => before.has(key(x))).length,
  };
}

/** A run as plain text: verdict, new failures first, then each failing file. */
export function formatRun(r: Run, cmp?: Comparison): string {
  const lines = [`${r.pack.name}${r.pack.counterparty ? ` (${r.pack.counterparty})` : ''}: ${r.summary.passed} of ${r.summary.files} message(s) pass. ${r.passed ? 'CONFORMS.' : 'DOES NOT CONFORM.'}`];
  if (cmp) {
    lines.push(`Since the baseline: ${cmp.new_failures.length} new failure(s), ${cmp.fixed.length} fixed, ${cmp.still_failing} still failing.`);
    for (const n of cmp.new_failures) lines.push(`  NEW ${n.file}: ${n.code}${n.rule ? ` (${n.rule})` : ''} at ${n.path}`);
  }
  for (const f of r.files.filter((x) => !x.passed)) {
    lines.push(`${f.name} (${f.message ?? 'unknown message'}): ${f.errors} error(s), ${f.warnings} warning(s)`);
    for (const i of f.issues) lines.push(`  ${i.severity.toUpperCase()} line ${i.line} ${i.code}: ${i.message}`);
  }
  return lines.join('\n');
}
