// XSD -> MessageModel (src/model.ts). Throws on any construct the model can't hold.

import type { Builtin, ComplexType, MessageModel, Particle, SimpleType } from './model.ts';
import { parseXml, type XmlElement } from './xml.ts';

const XS = 'http://www.w3.org/2001/XMLSchema';
const BUILTINS = new Set<Builtin>(['string', 'decimal', 'boolean', 'date', 'dateTime', 'time', 'gYearMonth']);

const kids = (e: XmlElement) => e.children.filter((c) => c.ns === XS && c.name !== 'annotation');
const fail = (e: XmlElement, what: string): never => {
  throw new Error(`line ${e.line}: unsupported XSD construct: ${what}`);
};

function particles(group: XmlElement): Particle[] {
  if (group.attrs.minOccurs !== undefined || group.attrs.maxOccurs !== undefined) fail(group, `occurs on <${group.name}>`);
  return kids(group).map((e) => {
    if (e.name !== 'element' || !e.attrs.name || !e.attrs.type) return fail(e, `<${e.name}> inside <${group.name}>`);
    const max = e.attrs.maxOccurs ?? '1';
    return { n: e.attrs.name, t: e.attrs.type, min: Number(e.attrs.minOccurs ?? '1'), max: max === 'unbounded' ? null : Number(max) };
  });
}

function builtin(e: XmlElement, base: string | undefined): Builtin {
  const b = base?.replace(/^xs:/, '') as Builtin;
  if (!base?.startsWith('xs:') || !BUILTINS.has(b)) return fail(e, `base ${base}`);
  return b;
}

export function compileXsd(src: string, source: string): MessageModel {
  const schema = parseXml(src);
  if (schema.ns !== XS || schema.name !== 'schema') throw new Error('not an XML Schema');
  const ns = schema.attrs.targetNamespace;
  const id = /^urn:iso:std:iso:20022:tech:xsd:(.+)$/.exec(ns ?? '')?.[1];
  if (!id) throw new Error(`target namespace ${ns} is not an ISO 20022 message`);
  if (schema.attrs.elementFormDefault !== 'qualified') throw new Error('expected elementFormDefault="qualified"');

  const types: MessageModel['types'] = {};
  let root = '';
  for (const d of kids(schema)) {
    const name = d.attrs.name;
    if (d.name === 'element') {
      if (name !== 'Document' || !d.attrs.type) fail(d, `top-level element ${name}`);
      root = d.attrs.type;
    } else if (d.name === 'simpleType') {
      const [r, ...rest] = kids(d);
      if (!r || r.name !== 'restriction' || rest.length) fail(d, `simpleType ${name} that is not a restriction`);
      const t: SimpleType = { k: 'simple', base: builtin(r, r.attrs.base) };
      for (const f of kids(r)) {
        const v = f.attrs.value;
        if (v === undefined) fail(f, `facet ${f.name} with no value`);
        if (f.name === 'enumeration') (t.enum ??= []).push(v);
        else if (f.name === 'pattern') (t.pattern ??= []).push(v);
        else if (f.name === 'minLength') t.minLen = Number(v);
        else if (f.name === 'maxLength') t.maxLen = Number(v);
        else if (f.name === 'totalDigits') t.totalDigits = Number(v);
        else if (f.name === 'fractionDigits') t.fractionDigits = Number(v);
        else if (f.name === 'minInclusive') t.minInclusive = v;
        else fail(f, `facet ${f.name}`);
      }
      types[name] = t;
    } else if (d.name === 'complexType') {
      const [c, ...rest] = kids(d);
      if (!c || rest.length) fail(d, `complexType ${name} with ${kids(d).length} children`);
      let t: ComplexType;
      if (c.name === 'sequence' && kids(c).length === 1 && kids(c)[0].name === 'any') t = { k: 'any' };
      else if (c.name === 'sequence') t = { k: 'seq', els: particles(c) };
      else if (c.name === 'choice') t = { k: 'choice', els: particles(c) };
      else if (c.name === 'simpleContent') {
        const [x, ...more] = kids(c);
        if (!x || x.name !== 'extension' || more.length || !x.attrs.base) fail(c, `simpleContent of ${name}`);
        t = {
          k: 'text',
          base: x.attrs.base,
          attrs: kids(x).map((a) => {
            if (a.name !== 'attribute' || !a.attrs.name || !a.attrs.type) return fail(a, `<${a.name}> in extension`);
            return { n: a.attrs.name, t: a.attrs.type, req: a.attrs.use === 'required' };
          }),
        };
      } else t = fail(c, `<${c.name}> in complexType ${name}`);
      types[name] = t;
    } else fail(d, `top-level <${d.name}>`);
  }
  if (!root || !types[root]) throw new Error('no Document element');
  // Every referenced type must exist, so the validator never meets an unknown name.
  for (const [name, t] of Object.entries(types)) {
    const refs = t.k === 'seq' || t.k === 'choice' ? t.els.map((e) => e.t) : t.k === 'text' ? [t.base, ...t.attrs.map((a) => a.t)] : [];
    for (const r of refs) if (!types[r]) throw new Error(`type ${name} refers to undefined type ${r}`);
  }
  return { id, ns, root, source, types };
}
