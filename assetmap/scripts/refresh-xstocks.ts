// The monthly xStocks (and matching Ondo Stocks) refresh in one command, on the founder's machine (signing needs the key,
// which never leaves it): a branch from master, the import, signing, the tests, a commit and a PR.
// .github/workflows/assetmap-refresh-reminder.yml opens an issue on the 1st of each month as a nudge.
//
//   node assetmap/scripts/refresh-xstocks.ts [key file]
//
// Stops before committing if nothing changed, and leaves the branch for a look if the tests fail.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const keyFile = process.argv[2] ?? join(homedir(), '.config', 'iomarkets', 'asset-map-signing.key');
const run = (cmd: string, args: string[], quiet = false) => execFileSync(cmd, args, { stdio: quiet ? 'pipe' : 'inherit', encoding: 'utf8' }) ?? '';

if (!existsSync(keyFile)) {
  console.error(`No signing key at ${keyFile}. Give its path, or restore it from the password manager (HANDOVER section 7).`);
  process.exit(1);
}
if (run('git', ['status', '--porcelain'], true).trim()) {
  console.error('The working tree has changes. Commit or stash them first.');
  process.exit(1);
}
const month = new Date().toISOString().slice(0, 7);
const branch = `assetmap/xstocks-${month}`;
run('git', ['fetch', 'origin', 'master']);
run('git', ['checkout', '-b', branch, 'origin/master']);
run('node', ['assetmap/scripts/import-xstocks.ts']);
run('node', ['assetmap/scripts/import-ondo-stocks.ts']); // the Ondo tokens for the same stocks, from Ondo's registry
run('node', ['assetmap/scripts/sign.ts', keyFile]);
if (!run('git', ['status', '--porcelain', 'assetmap/data'], true).trim()) {
  console.log('The issuer lists the same contracts as last time: nothing to commit.');
  process.exit(0);
}
try {
  run('npm', ['test']);
} catch {
  console.error(`Tests failed on the new entries; the branch ${branch} is left as it is to look at.`);
  process.exit(1);
}
run('git', ['add', 'assetmap/data', 'corpactions/data/figi.json']);
run('git', ['commit', '-m', `Asset Map: xStocks refresh ${month}\n\nFrom the issuers' own API and registry (assetmap/scripts/import-xstocks.ts, import-ondo-stocks.ts), re-signed.`]);
run('git', ['push', '-u', 'origin', branch]);
run('gh', ['pr', 'create', '--base', 'master', '--head', branch, '--title', `Asset Map: xStocks refresh ${month}`, '--body', 'Monthly refresh of the 30 most-held US-listed xStocks from the issuer\'s own API, and the Ondo Stocks for the same 30 from Ondo\'s token registry, re-signed with the current key. `npm test` passed locally.']);
