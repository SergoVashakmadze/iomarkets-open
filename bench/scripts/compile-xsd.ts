// Compile the vendored ISO 20022 XSDs (bench/schemas/*.xsd) into bench/models/*.json.
// Run after adding or replacing a schema:  node bench/scripts/compile-xsd.ts
// tests/bench-models.test.ts fails when a model is out of date with its XSD.

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileXsd } from '../src/compile.ts';

const here = dirname(fileURLToPath(import.meta.url));
const schemas = join(here, '..', 'schemas');
const models = join(here, '..', 'models');

for (const f of readdirSync(schemas).filter((x) => x.endsWith('.xsd')).sort()) {
  const model = compileXsd(readFileSync(join(schemas, f), 'utf8'), `ISO 20022 base schema ${f}`);
  writeFileSync(join(models, `${model.id}.json`), JSON.stringify(model) + '\n');
  console.log(`${f} -> models/${model.id}.json (${Object.keys(model.types).length} types)`);
}
