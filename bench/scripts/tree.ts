// Print a message's element tree from its compiled model, to help write samples and rules.
//   node bench/scripts/tree.ts pacs.008.001.08 [depth] [--required]
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MessageModel } from '../src/model.ts';

const [id, depthArg, flag] = process.argv.slice(2);
const model: MessageModel = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'models', `${id}.json`), 'utf8'));
const maxDepth = Number(depthArg ?? 4);
const requiredOnly = flag === '--required' || depthArg === '--required';

function show(typeName: string, depth: number) {
  const t = model.types[typeName];
  if (!t || depth > maxDepth || (t.k !== 'seq' && t.k !== 'choice')) return;
  for (const e of t.els) {
    if (requiredOnly && e.min === 0 && t.k === 'seq') continue;
    const s = model.types[e.t];
    const hint = s?.k === 'simple' ? ` = ${s.enum ? s.enum.slice(0, 8).join('|') : s.base}` : s?.k === 'text' ? ' = amount/text @Ccy' : '';
    console.log(`${'  '.repeat(depth)}${t.k === 'choice' ? '| ' : ''}${e.n} ${e.min}..${e.max ?? 'n'}${hint}`);
    show(e.t, depth + 1);
  }
}
show(model.root, 0);
