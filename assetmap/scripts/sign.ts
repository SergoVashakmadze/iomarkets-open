// Sign every Asset Map entry with the current IoMarkets key, after any edit to
// assetmap/data/entries.json. Issuer attestations are kept; IoMarkets ones are replaced.
// Run: node assetmap/scripts/sign.ts [key file]   (default ~/.config/iomarkets/asset-map-signing.key)
// tests/assetmap.test.ts fails if an entry is unsigned or was changed after signing.

import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ASSET_MAP_KEYS, publicKeyOf, signEntry } from '../src/sign.ts';
import type { Entry } from '../src/types.ts';

const keyFile = process.argv[2] ?? join(homedir(), '.config', 'iomarkets', 'asset-map-signing.key');
const priv = readFileSync(keyFile, 'utf8').trim();
const pub = await publicKeyOf(priv);
const current = ASSET_MAP_KEYS.find((k) => k.status === 'current');
if (!current || current.publicKey !== pub) {
  console.error(`The key in ${keyFile} (public ${pub}) is not the current key in ASSET_MAP_KEYS. Add it there first.`);
  process.exit(1);
}
const path = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'entries.json');
const entries: Entry[] = JSON.parse(readFileSync(path, 'utf8'));
for (const e of entries) {
  const others = e.attestations.filter((a) => a.by !== 'IoMarkets');
  e.attestations = [...others, await signEntry({ ...e, attestations: [] }, priv, current.id)];
}
writeFileSync(path, JSON.stringify(entries, null, 2) + '\n');
console.log(`Signed ${entries.length} entries with ${current.id}.`);
