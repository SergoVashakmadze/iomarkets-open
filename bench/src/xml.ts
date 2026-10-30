// A small XML parser for ISO 20022 messages and their schemas. It keeps the order of
// children and the line each element starts on, and resolves namespace prefixes, which
// is all the Test Bench needs. No DTDs and no external entities, by design: a message
// that declares a DOCTYPE is refused, so nothing can make the bench fetch or expand
// anything. Pure, no dependencies: runs in the browser, Workers and Node.

export type XmlElement = {
  /** Local name, without the prefix. */
  name: string;
  /** Resolved namespace URI ('' for none). */
  ns: string;
  /** Attributes by their written name (prefix included), xmlns declarations left out. */
  attrs: Record<string, string>;
  children: XmlElement[];
  /** Character data directly inside this element, entities decoded. */
  text: string;
  line: number;
};

export class XmlError extends Error {
  line: number;
  constructor(message: string, line: number) {
    super(message);
    this.line = line;
  }
}

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
const NAME = /^[A-Za-z_][\w.\-]*(?::[A-Za-z_][\w.\-]*)?/;

function decode(s: string, line: number): string {
  if (!s.includes('&')) return s;
  return s.replace(/&([^;\s&]*);?/g, (m, body: string) => {
    if (!m.endsWith(';')) throw new XmlError('A bare "&" must be written as &amp;', line);
    if (body in ENTITIES) return ENTITIES[body];
    const n = body.startsWith('#x') ? parseInt(body.slice(2), 16) : body.startsWith('#') ? parseInt(body.slice(1), 10) : NaN;
    if (Number.isNaN(n) || n < 0 || n > 0x10ffff) throw new XmlError(`Unknown entity &${body};`, line);
    return String.fromCodePoint(n);
  });
}

/** Parse a whole document and return its root element. Throws XmlError with a line number. */
export function parseXml(src: string): XmlElement {
  if (src.charCodeAt(0) === 0xfeff) src = src.slice(1);
  let i = 0;
  let line = 1;
  const advance = (to: number) => {
    for (let k = i; k < to; k++) if (src.charCodeAt(k) === 10) line++;
    i = to;
  };
  type Frame = { el: XmlElement; raw: string; scope: Record<string, string> };
  const stack: Frame[] = [];
  let root: XmlElement | null = null;
  let scope: Record<string, string> = { xml: 'http://www.w3.org/XML/1998/namespace' };

  while (i < src.length) {
    const lt = src.indexOf('<', i);
    const textEnd = lt === -1 ? src.length : lt;
    if (textEnd > i) {
      const raw = src.slice(i, textEnd);
      const top = stack[stack.length - 1];
      if (top) top.el.text += decode(raw, line);
      else if (raw.trim()) throw new XmlError('Text found outside the root element', line);
      advance(textEnd);
    }
    if (lt === -1) break;

    if (src.startsWith('<!--', i)) {
      const end = src.indexOf('-->', i + 4);
      if (end === -1) throw new XmlError('A comment is never closed (missing -->)', line);
      advance(end + 3);
    } else if (src.startsWith('<![CDATA[', i)) {
      const end = src.indexOf(']]>', i + 9);
      if (end === -1) throw new XmlError('A CDATA section is never closed (missing ]]>)', line);
      const top = stack[stack.length - 1];
      if (!top) throw new XmlError('CDATA found outside the root element', line);
      top.el.text += src.slice(i + 9, end);
      advance(end + 3);
    } else if (src.startsWith('<?', i)) {
      const end = src.indexOf('?>', i + 2);
      if (end === -1) throw new XmlError('A processing instruction is never closed (missing ?>)', line);
      advance(end + 2);
    } else if (src.startsWith('<!', i)) {
      throw new XmlError('DOCTYPE and entity declarations are not accepted', line);
    } else if (src.startsWith('</', i)) {
      const m = NAME.exec(src.slice(i + 2));
      const top = stack.pop();
      if (!m || !top) throw new XmlError('A closing tag has no matching opening tag', line);
      if (m[0] !== top.raw) throw new XmlError(`Expected </${top.raw}> but found </${m[0]}>`, line);
      const close = src.indexOf('>', i);
      if (close === -1 || src.slice(i + 2 + m[0].length, close).trim()) throw new XmlError(`Malformed closing tag </${m[0]}>`, line);
      scope = top.scope;
      advance(close + 1);
    } else {
      const startLine = line;
      const m = NAME.exec(src.slice(i + 1));
      if (!m) throw new XmlError('"<" must start a tag; write it as &lt; in text', line);
      const raw = m[0];
      let j = i + 1 + raw.length;
      const attrs: Record<string, string> = {};
      const decl: Record<string, string> = {};
      let selfClose = false;
      for (;;) {
        while (j < src.length && /\s/.test(src[j])) j++;
        if (src[j] === '>') { j++; break; }
        if (src.startsWith('/>', j)) { selfClose = true; j += 2; break; }
        const am = NAME.exec(src.slice(j));
        if (!am) throw new XmlError(`Malformed attribute in <${raw}>`, startLine);
        j += am[0].length;
        while (/\s/.test(src[j] ?? '')) j++;
        if (src[j] !== '=') throw new XmlError(`Attribute ${am[0]} in <${raw}> has no value`, startLine);
        j++;
        while (/\s/.test(src[j] ?? '')) j++;
        const q = src[j];
        if (q !== '"' && q !== "'") throw new XmlError(`Attribute ${am[0]} in <${raw}> must be quoted`, startLine);
        const end = src.indexOf(q, j + 1);
        if (end === -1) throw new XmlError(`Attribute ${am[0]} in <${raw}> is never closed`, startLine);
        const value = decode(src.slice(j + 1, end), startLine);
        if (value.includes('<')) throw new XmlError(`Attribute ${am[0]} in <${raw}> contains "<"`, startLine);
        if (am[0] in attrs || am[0] in decl) throw new XmlError(`Attribute ${am[0]} appears twice in <${raw}>`, startLine);
        if (am[0] === 'xmlns') decl[''] = value;
        else if (am[0].startsWith('xmlns:')) decl[am[0].slice(6)] = value;
        else attrs[am[0]] = value;
        j = end + 1;
      }
      const parentScope = scope;
      if (Object.keys(decl).length) scope = { ...scope, ...decl };
      const colon = raw.indexOf(':');
      const prefix = colon === -1 ? '' : raw.slice(0, colon);
      const ns = scope[prefix];
      if (prefix && ns === undefined) throw new XmlError(`Namespace prefix "${prefix}" is not declared`, startLine);
      const el: XmlElement = { name: colon === -1 ? raw : raw.slice(colon + 1), ns: ns ?? '', attrs, children: [], text: '', line: startLine };
      const parent = stack[stack.length - 1];
      if (parent) parent.el.children.push(el);
      else if (root) throw new XmlError('A document can have only one root element', startLine);
      else root = el;
      advance(j);
      if (selfClose) scope = parentScope;
      else stack.push({ el, raw, scope: parentScope });
    }
  }
  if (stack.length) throw new XmlError(`<${stack[stack.length - 1].raw}> is never closed`, line);
  if (!root) throw new XmlError('No XML element found', 1);
  return root;
}
