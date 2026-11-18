// Builds assetmap/data/history.json from git: every commit of data/entries.json, in order, recorded at the commit's
// time, with the commit subject as the note (every Asset Map change is made by hand). Run once; afterwards
// scripts/record-history.ts records each new change. Re-running gives the same file for the same commits.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emptyHistory, record } from '../../corpactions/src/history.ts';
import { ASSET_MAP_HISTORY_FORMAT } from '../src/history.ts';
import type { Entry } from '../src/types.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const git = (...a: string[]) => execFileSync('git', a, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const commits = git('log', '--reverse', '--format=%H%x09%cI%x09%s', 'HEAD', '--', 'assetmap/data/entries.json').trim().split('\n').filter(Boolean).map((l) => {
  const [sha, when, subject] = l.split('\t');
  return { sha, when: new Date(when).toISOString(), subject };
});
const h = emptyHistory<Entry>(ASSET_MAP_HISTORY_FORMAT);
let prev: Entry[] = [];
for (const c of commits) {
  const next = JSON.parse(git('show', `${c.sha}:assetmap/data/entries.json`)) as Entry[];
  const r = record(h, prev, next, { recorded: c.when, code: c.sha.slice(0, 12), note: c.subject });
  console.log(`${c.sha.slice(0, 12)} ${c.when} +${r.added} ~${r.changed} -${r.removed}  ${c.subject}`);
  prev = next;
}
writeFileSync(join(root, 'assetmap', 'data', 'history.json'), JSON.stringify(h) + '\n');
console.log(`${Object.keys(h.events).length} entries in history from ${commits.length} commits.`);
