import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { validateXML } from 'xmllint-wasm';
import { SAMPLES } from '../bench/samples/index.ts';
import { MESSAGES, validate } from '../bench/src/index.ts';

const NOW = new Date('2026-10-28T12:00:00Z');
const xsd = (id: string) => readFileSync(new URL(`../bench/schemas/${id}.xsd`, import.meta.url), 'utf8');
const schemaErrors = (xml: string) => validate(xml, { now: NOW, schemaOnly: true }).issues.filter((i) => i.severity === 'error');

/** libxml2's verdict on a message against the official XSD: the oracle the bench is checked against. */
async function libxml2(xml: string, id: string): Promise<boolean> {
  const r = await validateXML({ xml: [{ fileName: 'message.xml', contents: xml }], schema: [{ fileName: `${id}.xsd`, contents: xsd(id) }] });
  return r.valid;
}

describe('sample library', () => {
  it.each(SAMPLES.map((s) => [s.id, s] as const))('%s gives its expected verdict and codes', (_, s) => {
    const r = validate(s.xml, { now: NOW });
    expect(r.valid).toBe(s.valid);
    const codes = r.issues.map((i) => i.code);
    for (const c of s.expect) expect(codes).toContain(c);
    if (s.valid) expect(r.issues.filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('has a valid sample for every message and at least three broken ones each', () => {
    for (const m of MESSAGES) {
      expect(SAMPLES.some((s) => s.message === m.id && s.valid)).toBe(true);
      expect(SAMPLES.filter((s) => s.message === m.id && !s.valid).length).toBeGreaterThanOrEqual(2);
    }
  });

  it('every issue has a line, a path and a plain reason', () => {
    for (const s of SAMPLES) {
      for (const i of validate(s.xml, { now: NOW }).issues) {
        expect(i.line).toBeGreaterThan(0);
        expect(i.message.length).toBeGreaterThan(15);
        expect(i.message).toMatch(/[.?]$/);
      }
    }
  });

  it('libxml2 agrees with the bench on which samples are schema-valid', async () => {
    for (const s of SAMPLES) {
      if (!MESSAGES.some((m) => m.id === s.message) || s.id.includes('envelope')) continue;
      expect([s.id, await libxml2(s.xml, s.message)]).toEqual([s.id, schemaErrors(s.xml).length === 0]);
    }
  });
});

/** A small seeded generator, so a failure always reproduces. */
function rng(seed: number) {
  return () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
}

describe('differential check against libxml2', () => {
  // Random one-line changes to each valid sample: delete, duplicate or swap an element,
  // or change a value. The bench must reach the same verdict as libxml2 on every one.
  const VALUES = ['', 'X'.repeat(36), '2026-13-01', '12.345678', 'abc', '-1', 'true', '0', 'ZZ', 'eur', '1e3', ' 10 '];
  const cases: { name: string; xml: string; id: string }[] = [];
  for (const s of SAMPLES.filter((x) => x.valid && !x.id.includes('envelope'))) {
    const rand = rng(s.id.length * 7919);
    const lines = s.xml.split('\n');
    const leaves = lines.map((l, n) => [l, n] as const).filter(([l]) => /^\s*<(\w+)[^>]*>[^<]*<\/\1>\s*$/.test(l)).map(([, n]) => n);
    for (let k = 0; k < 40; k++) {
      const n = leaves[Math.floor(rand() * leaves.length)];
      const out = [...lines];
      const op = Math.floor(rand() * 4);
      let what: string;
      if (op === 0) { out.splice(n, 1); what = 'delete'; }
      else if (op === 1) { out.splice(n, 0, lines[n]); what = 'duplicate'; }
      else if (op === 2 && leaves.includes(n + 1)) { [out[n], out[n + 1]] = [out[n + 1], out[n]]; what = 'swap'; }
      else {
        const v = VALUES[Math.floor(rand() * VALUES.length)];
        out[n] = lines[n].replace(/>[^<]*</, `>${v}<`);
        what = `value "${v}"`;
      }
      cases.push({ name: `${s.id} line ${n + 1} ${what}`, xml: out.join('\n'), id: s.message });
    }
  }

  it.each(cases.map((c) => [c.name, c] as const))('%s', async (_, c) => {
    expect(schemaErrors(c.xml).length === 0).toBe(await libxml2(c.xml, c.id));
  });
});

describe('sample files', () => {
  it('bench/samples/xml matches the library (node bench/cli.ts --samples bench/samples/xml)', () => {
    const dir = new URL('../bench/samples/xml/', import.meta.url);
    expect(readdirSync(dir).sort()).toEqual(SAMPLES.map((s) => `${s.id}.xml`).sort());
    for (const s of SAMPLES) expect([s.id, readFileSync(new URL(`${s.id}.xml`, dir), 'utf8')]).toEqual([s.id, s.xml]);
  });
});
