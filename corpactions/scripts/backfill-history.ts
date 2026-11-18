// Builds corpactions/data/history.json from git: every commit of data/events.json since the feed started,
// in order, recorded at the commit's time (HANDOVER section 17). Run once to create the file; after that,
// scripts/ingest.ts keeps it up on every refresh. Re-running gives the same file for the same commits.
//
//   node corpactions/scripts/backfill-history.ts [--until <commit>]
//
// `code` is the commit whose code produced each version: for a daily refresh, the commit it ran on (the
// refresh commit's parent); for a change made by hand, that commit itself, with its subject as the note.

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emptyHistory, record } from '../src/history.ts';
import type { CorporateAction } from '../src/types.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const git = (...a: string[]) => execFileSync('git', a, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const until = process.argv.includes('--until') ? process.argv[process.argv.indexOf('--until') + 1] : 'HEAD';
const REFRESH = /^Corporate actions feed: \d{4}-\d{2}-\d{2} refresh$/;
const short = (sha: string) => sha.slice(0, 12);

const commits = git('log', '--reverse', '--format=%H%x09%cI%x09%s', until, '--', 'corpactions/data/events.json')
  .trim()
  .split('\n')
  .filter(Boolean)
  .map((l) => {
    const [sha, when, subject] = l.split('\t');
    return { sha, when: new Date(when).toISOString(), subject };
  });

const h = emptyHistory();
let prev: CorporateAction[] = [];
for (const [i, c] of commits.entries()) {
  const next = JSON.parse(git('show', `${c.sha}:corpactions/data/events.json`)) as CorporateAction[];
  const byHand = i > 0 && !REFRESH.test(c.subject);
  const code = i > 0 && !byHand ? short(git('rev-parse', `${c.sha}^`).trim()) : short(c.sha);
  const r = record(h, prev, next, { recorded: c.when, code, ...(byHand ? { note: c.subject } : {}) });
  console.log(`${short(c.sha)} ${c.when} +${r.added} ~${r.changed} -${r.removed}${byHand ? `  (${c.subject})` : ''}`);
  prev = next;
}
writeFileSync(join(root, 'corpactions', 'data', 'history.json'), JSON.stringify(h) + '\n');
console.log(`${Object.keys(h.events).length} events in history from ${commits.length} commits.`);
