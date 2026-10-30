// Make a new Asset Map signing key. Writes the private key (hex) to a file only you can
// read (mode 0600, refuses to overwrite) and prints the public key to add to
// ASSET_MAP_KEYS in assetmap/src/sign.ts. Run: node assetmap/scripts/keygen.ts [file]
// Default file: ~/.config/iomarkets/asset-map-signing.key. Rotation: HANDOVER section 7.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { publicKeyOf } from '../src/sign.ts';

const file = process.argv[2] ?? join(homedir(), '.config', 'iomarkets', 'asset-map-signing.key');
if (existsSync(file)) {
  console.error(`${file} already exists; not overwriting a key. Give another path to make a new one.`);
  process.exit(1);
}
process.umask(0o077);
mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
const priv = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, '0')).join('');
writeFileSync(file, priv + '\n', { mode: 0o600, flag: 'wx' });
console.log(`Private key written to ${file} (mode 0600). Keep it there; never commit or paste it.`);
console.log(`Public key: ${await publicKeyOf(priv)}`);
