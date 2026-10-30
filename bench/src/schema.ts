// Schema checks: one parsed message against one compiled model (model.ts). Each failure
// gets a stable code and a plain reason that names the element, what was found and
// what the schema allows.

import type { ComplexType, MessageModel, Particle, SimpleType } from './model.ts';
import type { Issue } from './report.ts';
import type { XmlElement } from './xml.ts';

type Sink = (i: Omit<Issue, 'layer' | 'severity'> & { severity?: Issue['severity'] }) => void;

const regexCache = new Map<string, RegExp>();
const regex = (p: string) => {
  let r = regexCache.get(p);
  if (!r) regexCache.set(p, (r = new RegExp(`^(?:${p})$`, 'u')));
  return r;
};

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
const listOf = (xs: string[], word = 'or') => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} ${word} ${xs[xs.length - 1]}`);

/** Edit distance, to suggest the element someone meant. */
function distance(a: string, b: string): number {
  const d = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0];
    d[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = d[j];
      d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1].toLowerCase() === b[j - 1].toLowerCase() ? 0 : 1));
      prev = tmp;
    }
  }
  return d[b.length];
}
const suggest = (name: string, names: string[]) => {
  const best = names.map((n) => [n, distance(name, n)] as const).sort((x, y) => x[1] - y[1])[0];
  return best && best[1] <= Math.max(1, Math.floor(name.length / 4)) ? ` Did you mean <${best[0]}>?` : '';
};
const some = (xs: string[]) => (xs.length > 10 ? `${xs.slice(0, 10).join(', ')} and ${xs.length - 10} more` : xs.join(', '));
const occurs = (p: Particle) => (p.max === null ? `at least ${p.min}` : p.min === p.max ? `exactly ${p.min}` : `${p.min} to ${p.max}`);

/** Days in a month, for real-calendar date checks (2026-02-30 is not a date). */
const daysIn = (y: number, m: number) => [31, y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
const TZ = '(Z|[+-](?:0\\d|1[0-4]):[0-5]\\d)?';
const DATE = new RegExp(`^(-?\\d{4,})-(\\d{2})-(\\d{2})${TZ}$`);
const TIME = new RegExp(`^([01]\\d|2[0-3]):([0-5]\\d):([0-5]\\d)(\\.\\d+)?${TZ}$`);
const DATETIME = new RegExp(`^(-?\\d{4,})-(\\d{2})-(\\d{2})T([01]\\d|2[0-3]):([0-5]\\d):([0-5]\\d)(\\.\\d+)?${TZ}$`);
const YEAR_MONTH = new RegExp(`^(-?\\d{4,})-(\\d{2})${TZ}$`);
const DECIMAL = /^[+-]?(\d+(\.\d*)?|\.\d+)$/;

const realDate = (y: string, m: string, d: string) => +m >= 1 && +m <= 12 && +d >= 1 && +d <= daysIn(+y, +m);

/** Compare two decimal strings without floating point. */
export function compareDecimal(a: string, b: string): number {
  const norm = (s: string) => {
    const neg = s.startsWith('-');
    const [i, f = ''] = s.replace(/^[+-]/, '').split('.');
    return { neg, i: i.replace(/^0+(?=\d)/, '') || '0', f: f.replace(/0+$/, '') };
  };
  const x = norm(a), y = norm(b);
  const zero = (n: typeof x) => /^0*$/.test(n.i) && n.f === '';
  if (zero(x) && zero(y)) return 0;
  if (x.neg !== y.neg) return x.neg ? -1 : 1;
  const sign = x.neg ? -1 : 1;
  if (x.i.length !== y.i.length) return (x.i.length > y.i.length ? 1 : -1) * sign;
  if (x.i !== y.i) return (x.i > y.i ? 1 : -1) * sign;
  const len = Math.max(x.f.length, y.f.length);
  const xf = x.f.padEnd(len, '0'), yf = y.f.padEnd(len, '0');
  return xf === yf ? 0 : (xf > yf ? 1 : -1) * sign;
}

/** Check one text value against a simple type. Returns [code, reason] or null. */
export function checkValue(raw: string, t: SimpleType, label: string): [string, string] | null {
  const collapse = t.base !== 'string';
  const v = collapse ? raw.replace(/\s+/g, ' ').trim() : raw;
  const len = [...v].length;
  if (t.base === 'string') {
    if (t.minLen !== undefined && len < t.minLen)
      return ['TOO_SHORT', len === 0 ? `${label} is empty; it needs at least ${plural(t.minLen, 'character')}.` : `${label} is ${plural(len, 'character')}; it needs at least ${t.minLen}.`];
    if (t.maxLen !== undefined && len > t.maxLen) return ['TOO_LONG', `${label} is ${plural(len, 'character')}; the most allowed is ${t.maxLen}.`];
  } else if (t.base === 'decimal') {
    if (!DECIMAL.test(v)) return ['NOT_DECIMAL', `${label} must be a number like 1250.50; found "${v}".`];
    const [i, f = ''] = v.replace(/^[+-]/, '').split('.');
    const frac = f.replace(/0+$/, '');
    const digits = (i.replace(/^0+/, '') + frac).length;
    if (t.fractionDigits !== undefined && frac.length > t.fractionDigits)
      return ['FRACTION_DIGITS', `${label} has ${plural(frac.length, 'decimal place')}; at most ${t.fractionDigits} are allowed.`];
    if (t.totalDigits !== undefined && digits > t.totalDigits) return ['TOTAL_DIGITS', `${label} has ${plural(digits, 'digit')}; at most ${t.totalDigits} are allowed.`];
    if (t.minInclusive !== undefined && compareDecimal(v, t.minInclusive) < 0) return ['BELOW_MIN', `${label} is ${v}; it can't be less than ${t.minInclusive}.`];
  } else if (t.base === 'boolean') {
    if (!/^(true|false|1|0)$/.test(v)) return ['NOT_BOOLEAN', `${label} must be true or false; found "${v}".`];
  } else if (t.base === 'date') {
    const m = DATE.exec(v);
    if (!m || !realDate(m[1], m[2], m[3])) return ['NOT_DATE', `${label} must be a real date written YYYY-MM-DD; found "${v}".`];
  } else if (t.base === 'dateTime') {
    const m = DATETIME.exec(v);
    if (!m || !realDate(m[1], m[2], m[3])) return ['NOT_DATETIME', `${label} must be a date and time written YYYY-MM-DDThh:mm:ss (optionally with a zone such as Z or +01:00); found "${v}".`];
  } else if (t.base === 'time') {
    if (!TIME.exec(v)) return ['NOT_TIME', `${label} must be a time written hh:mm:ss; found "${v}".`];
  } else if (t.base === 'gYearMonth') {
    const m = YEAR_MONTH.exec(v);
    if (!m || +m[2] < 1 || +m[2] > 12) return ['NOT_YEAR_MONTH', `${label} must be a year and month written YYYY-MM; found "${v}".`];
  }
  if (t.enum && !t.enum.includes(v)) {
    const allowed = t.enum.length <= 12 ? `one of ${listOf(t.enum)}` : `one of ${t.enum.length} codes in its list (for example ${t.enum.slice(0, 4).join(', ')})`;
    return ['NOT_IN_LIST', `${label} is "${v}"; it must be ${allowed}.`];
  }
  if (t.pattern && !t.pattern.some((p) => regex(p).test(v))) return ['PATTERN', `${label} is "${v}", which doesn't match the format the schema requires (${t.pattern.join(' or ')}).`];
  return null;
}

/** Validate an element tree against the model, starting at the Document element. */
export function checkSchema(doc: XmlElement, model: MessageModel, report: Sink): void {
  const visit = (el: XmlElement, typeName: string, path: string) => {
    const t = model.types[typeName];
    if (!t) return;
    for (const a of Object.keys(el.attrs)) {
      if (a.startsWith('xsi:') || a.startsWith('xml:')) continue;
      if (t.k !== 'text' || !t.attrs.some((x) => x.n === a)) report({ code: 'UNEXPECTED_ATTRIBUTE', path, line: el.line, message: `${el.name} can't carry an attribute ${a}.` });
    }
    if (t.k === 'simple' || t.k === 'text') {
      if (el.children.length) {
        report({ code: 'CHILD_IN_VALUE', path, line: el.children[0].line, message: `${el.name} holds a value, not elements; found <${el.children[0].name}> inside it.` });
        return;
      }
      const st = (t.k === 'text' ? model.types[t.base] : t) as SimpleType;
      const bad = checkValue(el.text, st, el.name);
      if (bad) report({ code: bad[0], path, line: el.line, message: bad[1] });
      if (t.k === 'text') {
        for (const a of t.attrs) {
          const v = el.attrs[a.n];
          if (v === undefined) {
            if (a.req) report({ code: 'MISSING_ATTRIBUTE', path, line: el.line, message: `${el.name} needs the attribute ${a.n}${a.n === 'Ccy' ? ' (its currency, such as Ccy="EUR")' : ''}.` });
            continue;
          }
          const ab = checkValue(v, model.types[a.t] as SimpleType, `${el.name}/@${a.n}`);
          if (ab) report({ code: ab[0], path: `${path}/@${a.n}`, line: el.line, message: ab[1] });
        }
      }
      return;
    }
    if (t.k === 'any') return;
    if (el.text.trim()) report({ code: 'TEXT_IN_GROUP', path, line: el.line, message: `${el.name} holds elements, not text; found "${el.text.trim().slice(0, 40)}".` });
    const kids = el.children;
    // Children in a foreign namespace can't belong to this message.
    for (const k of kids)
      if (k.ns !== model.ns)
        report({ code: 'WRONG_NAMESPACE', path: `${path}/${k.name}`, line: k.line, message: `<${k.name}> is in namespace "${k.ns || '(none)'}"; every element of ${model.id} must be in ${model.ns}.` });
    const counts = new Map<string, number>();
    const childPath = (k: XmlElement) => {
      const n = (counts.get(k.name) ?? 0) + 1;
      counts.set(k.name, n);
      return (t.els.find((e) => e.n === k.name)?.max ?? 1) === 1 ? `${path}/${k.name}` : `${path}/${k.name}[${n}]`;
    };
    if (t.k === 'choice') checkChoice(el, t, path, report);
    else checkSequence(el, t, path, report);
    for (const k of kids) {
      const p = t.els.find((e) => e.n === k.name);
      const cp = childPath(k);
      if (p && k.ns === model.ns) visit(k, p.t, cp);
    }
  };

  if (doc.name !== 'Document') {
    report({ code: 'WRONG_ROOT', path: `/${doc.name}`, line: doc.line, message: `The message must start with a <Document> element; found <${doc.name}>.` });
    return;
  }
  visit(doc, model.root, '/Document');
}

function checkChoice(el: XmlElement, t: Extract<ComplexType, { k: 'choice' }>, path: string, report: Sink) {
  const names = t.els.map((e) => e.n);
  const used = [...new Set(el.children.map((k) => k.name))];
  for (const k of el.children)
    if (!names.includes(k.name))
      report({ code: 'UNEXPECTED_ELEMENT', path: `${path}/${k.name}`, line: k.line, message: `${el.name} can't contain <${k.name}>; it takes one of ${listOf(names)}.${suggest(k.name, names)}` });
  const known = used.filter((n) => names.includes(n));
  if (known.length === 0) report({ code: 'CHOICE_NONE', path, line: el.line, message: `${el.name} is empty; it needs one of ${listOf(names)}.` });
  else if (known.length > 1) report({ code: 'CHOICE_MANY', path, line: el.line, message: `${el.name} takes only one of ${listOf(names)}; found ${listOf(known, 'and')}.` });
  else {
    const p = t.els.find((e) => e.n === known[0])!;
    const n = el.children.filter((k) => k.name === p.n).length;
    if (p.max !== null && n > p.max) report({ code: 'TOO_MANY', path, line: el.line, message: `${el.name} has ${n} <${p.n}>; it allows ${occurs(p)}.` });
  }
}

function checkSequence(el: XmlElement, t: Extract<ComplexType, { k: 'seq' }>, path: string, report: Sink) {
  const els = t.els;
  if (!els.length) {
    for (const k of el.children) report({ code: 'UNEXPECTED_ELEMENT', path: `${path}/${k.name}`, line: k.line, message: `${el.name} must be empty; found <${k.name}>.` });
    return;
  }
  let i = 0;
  let count = 0;
  const missing = (p: Particle, line: number) => {
    const before = els.slice(0, els.indexOf(p)).map((e) => e.n);
    const where = before.length ? ` (it goes after ${before[before.length - 1]})` : ' (it comes first)';
    report({ code: 'MISSING_ELEMENT', path, line, message: `${el.name} is missing <${p.n}>${p.min > 1 ? ` (needs ${occurs(p)})` : ''}${where}.` });
  };
  const kids = el.children;
  for (let ci = 0; ci < kids.length; ci++) {
    const k = kids[ci];
    // A required element that does turn up later is reported as out of order, not missing.
    const later = (p: Particle) => kids.slice(ci + 1).some((x) => x.name === p.n);
    let j = i;
    while (j < els.length && els[j].n !== k.name) j++;
    if (j === els.length) {
      const earlier = els.findIndex((e) => e.n === k.name);
      if (earlier === -1) {
        report({ code: 'UNEXPECTED_ELEMENT', path: `${path}/${k.name}`, line: k.line, message: `${el.name} can't contain <${k.name}>.${suggest(k.name, els.map((e) => e.n)) || ` It allows: ${some(els.map((e) => e.n))}.`}` });
      } else {
        // Its place is behind where we are: it comes before the element matched last.
        report({ code: 'OUT_OF_ORDER', path: `${path}/${k.name}`, line: k.line, message: `<${k.name}> is out of order in ${el.name}: the schema puts it before ${els[i].n}.` });
      }
      continue;
    }
    if (j === i) {
      count++;
      if (els[i].max !== null && count > els[i].max!) {
        report({ code: 'TOO_MANY', path: `${path}/${k.name}`, line: k.line, message: `${el.name} has too many <${k.name}>; it allows ${occurs(els[i])}.` });
      }
      continue;
    }
    // Moving forward: everything skipped must be optional.
    if (count < els[i].min && !later(els[i])) missing(els[i], k.line);
    for (let s = i + 1; s < j; s++) if (els[s].min > 0 && !later(els[s])) missing(els[s], k.line);
    i = j;
    count = 1;
  }
  if (count < els[i].min) missing(els[i], el.line);
  for (let s = i + 1; s < els.length; s++) if (els[s].min > 0) missing(els[s], el.line);
}

