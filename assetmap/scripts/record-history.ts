// Records a change to the Tokenized Asset Map in assetmap/data/history.json: run after scripts/sign.ts, before
// committing. Compares data/entries.json with the last committed one (git HEAD).
//   node assetmap/scripts/record-history.ts --note "Add Ondo's USDY on Arbitrum, from its token page"
// tests/assetmap-history.test.ts fails while the history is behind the entries.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { record, type History } from '../../corpactions/src/history.ts';
import type { Entry } from '../src/types.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const git = (...a: string[]) => execFileSync('git', a, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const i = process.argv.indexOf('--note');
const note = i > 0 ? process.argv[i + 1] : undefined;
if (!note) {
  console.error('Say what changed and from which issuer publication: --note "…"');
  process.exit(2);
}
const historyFile = join(root, 'assetmap', 'data', 'history.json');
const h = JSON.parse(readFileSync(historyFile, 'utf8')) as History<Entry>;
const prev = JSON.parse(git('show', 'HEAD:assetmap/data/entries.json')) as Entry[];
const next = JSON.parse(readFileSync(join(root, 'assetmap', 'data', 'entries.json'), 'utf8')) as Entry[];
const r = record(h, prev, next, { recorded: new Date().toISOString(), code: git('rev-parse', '--short=12', 'HEAD').trim(), note });
writeFileSync(historyFile, JSON.stringify(h) + '\n');
console.log(`History: ${r.added} new, ${r.changed} changed, ${r.removed} removed.`);
