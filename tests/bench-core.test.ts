import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ibanChecksumOk, isinOk, leiChecksumOk } from '../bench/src/codes.ts';
import { ISSUE_CODES } from '../bench/src/issues.ts';
import { compileXsd } from '../bench/src/compile.ts';
import { formatReport, validate } from '../bench/src/index.ts';
import { sumDecimal, sameDecimal } from '../bench/src/rules.ts';
import { checkValue, compareDecimal } from '../bench/src/schema.ts';
import { parseXml, XmlError } from '../bench/src/xml.ts';
import { PACS_008 } from '../bench/samples/valid.ts';

const dir = new URL('../bench/', import.meta.url);

describe('compiled models', () => {
  it.each(readdirSync(new URL('schemas/', dir)).filter((f) => f.endsWith('.xsd')))('%s matches its model (run node bench/scripts/compile-xsd.ts)', (f) => {
    const model = compileXsd(readFileSync(new URL(`schemas/${f}`, dir), 'utf8'), `ISO 20022 base schema ${f}`);
    const onDisk = JSON.parse(readFileSync(new URL(`models/${model.id}.json`, dir), 'utf8'));
    expect(onDisk).toEqual(model);
  });

  it('refuses an XSD construct the model cannot hold', () => {
    const xsd = `<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:iso:std:iso:20022:tech:xsd:test.001.001.01" elementFormDefault="qualified">
      <xs:element name="Document" type="D"/><xs:complexType name="D"><xs:all><xs:element name="A" type="T"/></xs:all></xs:complexType></xs:schema>`;
    expect(() => compileXsd(xsd, 'test')).toThrow(/unsupported XSD construct/);
  });
});

describe('XML parser', () => {
  it('resolves prefixes, decodes entities and CDATA, and counts lines', () => {
    const el = parseXml('<?xml version="1.0"?>\n<!-- c -->\n<a:Doc xmlns:a="urn:x">\n  <a:B q="1 &amp; 2">x &lt; y<![CDATA[ & z]]>&#65;</a:B>\n</a:Doc>');
    expect(el).toMatchObject({ name: 'Doc', ns: 'urn:x', line: 3 });
    expect(el.children[0]).toMatchObject({ name: 'B', ns: 'urn:x', text: 'x < y & zA', attrs: { q: '1 & 2' }, line: 4 });
  });

  it('refuses DOCTYPEs, so no entity can expand or fetch anything', () => {
    expect(() => parseXml('<!DOCTYPE d [<!ENTITY x "y">]><d>&x;</d>')).toThrow(XmlError);
  });

  it.each([
    ['<a><b></a>', /Expected <\/b>/],
    ['<a>', /never closed/],
    ['<a></a><b/>', /only one root/],
    ['<p:a/>', /not declared/],
    ['<a x=1/>', /quoted/],
    ['<a>&bogus;</a>', /Unknown entity/],
    ['<a>fish & chips</a>', /bare "&"/],
  ])('rejects %s', (xml, msg) => {
    expect(() => parseXml(xml)).toThrow(msg);
  });

  it('reports the line of a well-formedness error', () => {
    const r = validate('<Document>\n<A>\n</B>\n</Document>');
    expect(r.issues[0]).toMatchObject({ code: 'NOT_XML', line: 3 });
  });
});

describe('value checks', () => {
  it('decimal facets count digits the XSD way', () => {
    const t = { k: 'simple', base: 'decimal', totalDigits: 5, fractionDigits: 2, minInclusive: '0' } as const;
    expect(checkValue('123.45', t, 'X')).toBeNull();
    expect(checkValue('00123.450', t, 'X')).toBeNull();
    expect(checkValue('12345.6', t, 'X')?.[0]).toBe('TOTAL_DIGITS');
    expect(checkValue('1.234', t, 'X')?.[0]).toBe('FRACTION_DIGITS');
    expect(checkValue('-0.01', t, 'X')?.[0]).toBe('BELOW_MIN');
    expect(checkValue('1e3', t, 'X')?.[0]).toBe('NOT_DECIMAL');
  });

  it('dates must exist on the calendar', () => {
    const d = { k: 'simple', base: 'date' } as const;
    expect(checkValue('2028-02-29', d, 'D')).toBeNull();
    expect(checkValue('2026-02-29', d, 'D')?.[0]).toBe('NOT_DATE');
    expect(checkValue('2026-11-02Z', d, 'D')).toBeNull();
  });

  it('string lengths count characters, not bytes', () => {
    expect(checkValue('Zürich €', { k: 'simple', base: 'string', maxLen: 8 }, 'S')).toBeNull();
  });

  it('decimal arithmetic is exact', () => {
    expect(sumDecimal(['0.1', '0.2'])).toBe('0.3');
    expect(sumDecimal(['10000.00', '-1250.00', '25000.00'])).toBe('33750.00');
    expect(sameDecimal('1.50', '1.5')).toBe(true);
    expect(compareDecimal('-2', '-10')).toBe(1);
    expect(compareDecimal('0.00', '-0')).toBe(0);
  });
});

describe('check digits', () => {
  it('IBAN (ISO 13616)', () => {
    expect(ibanChecksumOk('GB82WEST12345698765432')).toBe(true);
    expect(ibanChecksumOk('GB82WEST12345698765423')).toBe(false);
  });
  it('ISIN (ISO 6166)', () => {
    expect(isinOk('US0378331005')).toBe(true);
    expect(isinOk('US0378331006')).toBe(false);
    expect(isinOk('GB0002634946')).toBe(true);
  });
  it('LEI (ISO 17442)', () => {
    expect(leiChecksumOk('5493001KJTIIGC8Y1R12')).toBe(true);
    expect(leiChecksumOk('5493001KJTIIGC8Y1R13')).toBe(false);
  });
});

describe('validate', () => {
  it('runs business rules only once the schema passes', () => {
    const r = validate(PACS_008.replace('<ChrgBr>SHAR</ChrgBr>', '').replace('<NbOfTxs>1', '<NbOfTxs>2'));
    expect(r.checked).toEqual({ schema: true, rules: false });
    expect(r.issues.map((i) => i.code)).toEqual(['MISSING_ELEMENT']);
    expect(formatReport(r)).toMatch(/Business rules run once the schema errors are fixed/);
  });

  it('accepts any prefix for the ISO namespace', () => {
    const prefixed = PACS_008.replace('<Document xmlns=', '<ns2:Document xmlns:ns2=').replace(/<(\/?)(?!\?|ns2:Document)(\w+)/g, '<$1ns2:$2').replace('</Document>', '</ns2:Document>');
    expect(validate(prefixed, { now: new Date('2026-10-28T12:00:00Z') })).toMatchObject({ valid: true, message: 'pacs.008.001.08' });
  });

  it('names an element in the wrong namespace', () => {
    const r = validate(PACS_008.replace('<MsgId>', '<MsgId xmlns="urn:other">'));
    expect(r.issues.map((i) => i.code)).toContain('WRONG_NAMESPACE');
  });

  it('suggests the element someone meant', () => {
    const r = validate(PACS_008.replace(/<ChrgBr>SHAR<\/ChrgBr>/, '<ChrgBr>SHAR</ChrgBr><ChrgsInfo/>'));
    expect(r.issues[0].message).toMatch(/Did you mean <ChrgsInf>\?/);
  });

  it('can be told the message type, and says when the namespace disagrees', () => {
    const r = validate(PACS_008, { message: 'pacs.009.001.08' });
    expect(r.issues.map((i) => i.code)).toContain('NAMESPACE');
  });

  it('caps the number of issues', () => {
    const many = PACS_008.replace('<RmtInf>', '<RmtInf>' + '<Bogus/>'.repeat(300));
    const r = validate(many);
    expect(r.issues.length).toBe(200);
    expect(r.truncated).toBe(true);
  });
});

describe('issue codes', () => {
  it('every code the bench can raise is explained, and none is explained twice', () => {
    const dir = new URL('../bench/src/', import.meta.url);
    const raised = new Set<string>()
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.ts') && x !== 'issues.ts')) {
      const src = readFileSync(new URL(f, dir), 'utf8')
      for (const m of src.matchAll(/code: '([A-Z_]+)'/g)) raised.add(m[1])
      for (const m of src.matchAll(/return \['([A-Z_]+)', /g)) raised.add(m[1])
    }
    const known = ISSUE_CODES.map((c) => c.code)
    expect(new Set(known).size).toBe(known.length)
    for (const c of raised) expect(known, c).toContain(c)
  })
})
