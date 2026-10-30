#!/usr/bin/env node
// ISO 20022 Test Bench, command line. Node 24 runs it as is (no build, no install):
//
//   node bench/cli.ts payment.xml statements/*.xml     check files; exit 1 if any fails
//   cat payment.xml | node bench/cli.ts -              read standard input
//   node bench/cli.ts --json payment.xml               the full report as JSON
//   node bench/cli.ts --github payment.xml             GitHub annotations (the Action uses this)
//   node bench/cli.ts --schema-only payment.xml        skip business rules
//   node bench/cli.ts --message pacs.008.001.08 f.xml  check as this message type
//   node bench/cli.ts --strict payment.xml             warnings fail too
//   node bench/cli.ts --list                           messages the bench checks
//   node bench/cli.ts --samples [dir]                  write the sample library to dir

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SAMPLES } from './samples/index.ts';
import { MESSAGES, formatReport, validate, type Report } from './src/index.ts';

const args = process.argv.slice(2);
const flag = (f: string) => {
  const i = args.indexOf(f);
  if (i !== -1) args.splice(i, 1);
  return i !== -1;
};
const option = (f: string) => {
  const i = args.indexOf(f);
  if (i === -1) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};

const json = flag('--json');
const github = flag('--github');
const schemaOnly = flag('--schema-only');
const strict = flag('--strict');
const message = option('--message');

if (flag('--help') || flag('-h')) {
  console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'));
  process.exit(0);
}
if (flag('--list')) {
  for (const m of MESSAGES) console.log(`${m.id}  ${m.title}`);
  process.exit(0);
}
if (flag('--samples')) {
  const dir = args[0] ?? 'iso20022-samples';
  mkdirSync(dir, { recursive: true });
  for (const s of SAMPLES) writeFileSync(join(dir, `${s.id}.xml`), s.xml);
  console.log(`Wrote ${SAMPLES.length} samples to ${dir}/ (${SAMPLES.filter((s) => s.valid).length} valid, ${SAMPLES.filter((s) => !s.valid).length} broken).`);
  process.exit(0);
}
if (!args.length) {
  console.error('Give one or more XML files, or - for standard input. --help for more.');
  process.exit(2);
}

/** GitHub workflow commands need %, CR and LF escaped. */
const esc = (s: string) => s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');

let failed = 0;
const reports: { file: string; report: Report }[] = [];
for (const file of args) {
  let xml: string;
  try {
    xml = file === '-' ? readFileSync(0, 'utf8') : readFileSync(file, 'utf8');
  } catch (e) {
    console.error(`${file}: can't read it (${(e as NodeJS.ErrnoException).code ?? (e as Error).message})`);
    failed++;
    continue;
  }
  const report = validate(xml, { schemaOnly, message });
  const bad = !report.valid || (strict && report.warnings > 0);
  if (bad) failed++;
  reports.push({ file, report });
  if (github) {
    for (const i of report.issues) {
      const level = i.severity === 'error' || strict ? 'error' : 'warning';
      console.log(`::${level} file=${file},line=${i.line},title=${i.code}::${esc(`${i.path ? i.path + ': ' : ''}${i.message}`)}`);
    }
    console.log(`${bad ? '✗' : '✓'} ${file}: ${report.message ?? 'unknown message'}: ${report.errors} error(s), ${report.warnings} warning(s)`);
  } else if (!json) {
    console.log(formatReport(report, file));
    console.log('');
  }
}
if (json) console.log(JSON.stringify(reports.length === 1 ? reports[0].report : reports, null, 2));
if (!json && args.length > 1) console.log(`${args.length - failed} of ${args.length} passed.`);
process.exit(failed ? 1 : 0);
