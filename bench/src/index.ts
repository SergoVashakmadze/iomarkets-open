// The ISO 20022 Test Bench: validate(xml) checks a message against its ISO 20022 base
// schema, then against business rules (rules.ts), and returns a report with a plain
// reason for each failure. The same function runs on the iomarkets.tech page, behind
// POST /api/test-bench/validate, in the MCP tool validate_message, in the CLI
// (bench/cli.ts) and in the GitHub Action.

import camt053 from '../models/camt.053.001.08.json' with { type: 'json' };
import pacs008 from '../models/pacs.008.001.08.json' with { type: 'json' };
import pacs009 from '../models/pacs.009.001.08.json' with { type: 'json' };
import pain001 from '../models/pain.001.001.09.json' with { type: 'json' };
import seev031 from '../models/seev.031.001.14.json' with { type: 'json' };
import type { MessageModel } from './model.ts';
import { MAX_ISSUES, type Issue, type Report } from './report.ts';
import { checkRules } from './rules.ts';
import { checkSchema } from './schema.ts';
import { parseXml, XmlError, type XmlElement } from './xml.ts';

export type { Issue, Report } from './report.ts';
export { parseXml, XmlError, type XmlElement } from './xml.ts';

export type MessageInfo = { id: string; family: string; title: string; what: string };

/** The messages the bench checks, in the order the page and the tools list them. */
export const MESSAGES: MessageInfo[] = [
  { id: 'pacs.008.001.08', family: 'pacs.008', title: 'FI to FI customer credit transfer', what: "A bank-to-bank payment carrying a customer's credit transfer: the main cross-border and high-value payment message (SWIFT CBPR+, Fedwire, CHAPS, TARGET2 use this version)." },
  { id: 'pacs.009.001.08', family: 'pacs.009', title: 'Financial institution credit transfer', what: 'A payment between banks for their own account, or the cover leg of a customer payment (pacs.009 COV).' },
  { id: 'pain.001.001.09', family: 'pain.001', title: 'Customer credit transfer initiation', what: 'A company or person asking their bank to make one or more payments: payroll and supplier batches.' },
  { id: 'camt.053.001.08', family: 'camt.053', title: 'Bank to customer statement', what: 'The end-of-day account statement a bank sends its customer: balances and every booked entry.' },
  { id: 'seev.031.001.14', family: 'seev.031', title: 'Corporate action notification', what: 'An announcement of a corporate action (a dividend, split, merger…) from an issuer agent or custodian to account holders.' },
];

const MODELS: Record<string, MessageModel> = Object.fromEntries(
  [pacs008, pacs009, pain001, camt053, seev031].map((m) => [m.id, m as unknown as MessageModel]),
);

export const NS_PREFIX = 'urn:iso:std:iso:20022:tech:xsd:';

export type ValidateOptions = {
  /** Skip business rules and run the schema checks only. */
  schemaOnly?: boolean;
  /** Treat the message as this identifier instead of reading it from the namespace. */
  message?: string;
  /** "Now" for date rules (tests pass a fixed date). Defaults to the current time. */
  now?: Date;
};

/** The Document element: the root, or inside a business message envelope (AppHdr + Document). */
function findDocument(root: XmlElement): XmlElement {
  if (root.name === 'Document') return root;
  const queue = [...root.children];
  while (queue.length) {
    const el = queue.shift()!;
    if (el.name === 'Document' && el.ns.startsWith(NS_PREFIX)) return el;
    queue.push(...el.children);
  }
  return root;
}

const empty = (message: string | null): Report => ({
  valid: false,
  message,
  title: MESSAGES.find((m) => m.id === message)?.title ?? null,
  errors: 0,
  warnings: 0,
  issues: [],
  truncated: false,
  checked: { schema: false, rules: false },
});

export function validate(xml: string, opts: ValidateOptions = {}): Report {
  let root: XmlElement;
  try {
    root = parseXml(xml);
  } catch (e) {
    const r = empty(null);
    const line = e instanceof XmlError ? e.line : 1;
    r.issues.push({ severity: 'error', layer: 'schema', code: 'NOT_XML', path: '', line, message: `This is not well-formed XML: ${(e as Error).message} (line ${line}).` });
    r.errors = 1;
    return r;
  }
  const doc = findDocument(root);
  const fromNs = doc.ns.startsWith(NS_PREFIX) ? doc.ns.slice(NS_PREFIX.length) : null;
  const id = opts.message ?? fromNs;
  const r = empty(id);
  const issues: Issue[] = [];
  let truncated = false;
  const add = (layer: Issue['layer']) => (i: Omit<Issue, 'layer' | 'severity'> & { severity?: Issue['severity'] }) => {
    if (issues.length >= MAX_ISSUES) {
      truncated = true;
      return;
    }
    issues.push({ severity: i.severity ?? 'error', layer, code: i.code, path: i.path, line: i.line, message: i.message });
  };

  const model = id ? MODELS[id] : undefined;
  if (!model) {
    const known = MESSAGES.map((m) => m.id).join(', ');
    const sameFamily = id ? MESSAGES.find((m) => id.startsWith(m.family + '.')) : undefined;
    const message = !id
      ? `Can't tell which message this is: the <Document> element has no ISO 20022 namespace (expected something like xmlns="${NS_PREFIX}pacs.008.001.08"). The bench checks ${known}.`
      : sameFamily
        ? `This is ${id}; the bench checks version ${sameFamily.id} of ${sameFamily.family}. Other versions are not loaded yet.`
        : `The bench doesn't check ${id} yet. It checks ${known}.`;
    add('schema')({ code: 'UNKNOWN_MESSAGE', path: '/Document', line: doc.line, message });
  } else {
    if (doc !== root) add('schema')({ severity: 'warning', code: 'ENVELOPE', path: `/${root.name}`, line: root.line, message: `The message sits inside <${root.name}>; only its <Document> was checked (the business application header is not).` });
    if (opts.message && fromNs && fromNs !== opts.message)
      add('schema')({ code: 'NAMESPACE', path: '/Document', line: doc.line, message: `The namespace says ${fromNs}, but it was checked as ${opts.message}.` });
    checkSchema(doc, model, add('schema'));
    r.checked.schema = true;
    // Rules read values the schema has vouched for, so they run only on a schema-valid message.
    const schemaErrors = issues.some((i) => i.severity === 'error');
    if (!opts.schemaOnly && !schemaErrors) {
      checkRules(model, doc, add('rule'), opts.now ?? new Date());
      r.checked.rules = true;
    }
  }
  r.issues = issues;
  r.truncated = truncated;
  r.errors = issues.filter((i) => i.severity === 'error').length;
  r.warnings = issues.length - r.errors;
  r.valid = r.errors === 0 && !!model;
  return r;
}

/** A report as plain text, one line per issue: the CLI and the MCP tool print this. */
export function formatReport(r: Report, name = 'message'): string {
  const head = r.message ? `${name}: ${r.message}${r.title ? ` (${r.title})` : ''}` : name;
  const verdict = r.valid
    ? `PASS${r.warnings ? ` with ${r.warnings} warning${r.warnings === 1 ? '' : 's'}` : ''}${r.checked.rules ? ' (schema and business rules)' : r.checked.schema ? ' (schema only)' : ''}`
    : `FAIL: ${r.errors} error${r.errors === 1 ? '' : 's'}${r.warnings ? `, ${r.warnings} warning${r.warnings === 1 ? '' : 's'}` : ''}${r.checked.schema && !r.checked.rules ? '. Business rules run once the schema errors are fixed.' : ''}`;
  const lines = r.issues.map((i) => `  ${i.severity === 'error' ? 'error' : 'warn '} line ${i.line} ${i.code} ${i.path ? i.path + ': ' : ''}${i.message}`);
  return [head, verdict, ...lines, ...(r.truncated ? [`  … stopped after ${MAX_ISSUES} issues`] : [])].join('\n');
}
