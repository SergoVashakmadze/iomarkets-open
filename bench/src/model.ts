// The compiled form of one ISO 20022 message schema (bench/models/*.json), made from the
// official XSD by bench/scripts/compile-xsd.ts. ISO 20022 schemas use a small, regular
// part of XML Schema: complex types are a flat sequence or a flat choice of elements,
// amounts are text with a Ccy attribute, and simple types restrict a built-in type with
// facets. The compiler refuses anything outside that, so a model never silently drops a rule.

export type Builtin = 'string' | 'decimal' | 'boolean' | 'date' | 'dateTime' | 'time' | 'gYearMonth';

export type Particle = { n: string; t: string; min: number; max: number | null };

export type SimpleType = {
  k: 'simple';
  base: Builtin;
  enum?: string[];
  pattern?: string[];
  minLen?: number;
  maxLen?: number;
  totalDigits?: number;
  fractionDigits?: number;
  minInclusive?: string;
};

export type ComplexType =
  | { k: 'seq'; els: Particle[] }
  | { k: 'choice'; els: Particle[] }
  /** Wildcard content (SupplementaryData envelopes): anything, checked by no one. */
  | { k: 'any' }
  /** Text of a simple type with attributes, e.g. an amount with its Ccy. */
  | { k: 'text'; base: string; attrs: { n: string; t: string; req: boolean }[] };

export type MessageModel = {
  /** Message identifier, e.g. pacs.008.001.08. */
  id: string;
  ns: string;
  /** Type of the Document root element. */
  root: string;
  /** Where the XSD came from, for the report and the licence note. */
  source: string;
  types: Record<string, SimpleType | ComplexType>;
};
