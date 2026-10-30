import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { validate } from '../bench/src/index'
import { SAMPLES } from '../bench/samples/index'
import { CHAINS, ENTRIES } from '../assetmap/src/index'
import { EVENTS } from '../corpactions/src/index'
import entrySchema from '../formats/asset-map-entry.v1.schema.json'
import keysSchema from '../formats/asset-map-issuer-keys.v1.schema.json'
import eventSchema from '../formats/corporate-action.v1.schema.json'
import reportSchema from '../formats/test-bench-report.v1.schema.json'

// The open formats (formats/*.schema.json), published at iomarkets.org/formats. Every real entry, event and report
// must fit its schema, so the published formats describe what the tools actually emit.

type Schema = {
  type?: string | string[]; enum?: unknown[]; const?: unknown; pattern?: string; minLength?: number; minimum?: number; exclusiveMinimum?: number
  required?: string[]; properties?: Record<string, Schema>; additionalProperties?: boolean; items?: Schema; minItems?: number
}

/** Enough of JSON Schema 2020-12 for these four schemas: a list of what doesn't fit. */
function check(s: Schema, v: unknown, at = '$'): string[] {
  const out: string[] = []
  const kind = v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v
  if (s.type && ![s.type].flat().some((t) => t === kind || (t === 'number' && kind === 'integer'))) return [`${at}: is ${kind}, not ${s.type}`]
  if (s.enum && !s.enum.includes(v)) out.push(`${at}: ${JSON.stringify(v)} is not one of ${s.enum.join(', ')}`)
  if ('const' in s && v !== s.const) out.push(`${at}: must be ${JSON.stringify(s.const)}`)
  if (typeof v === 'string') {
    if (s.pattern && !new RegExp(s.pattern, 'u').test(v)) out.push(`${at}: "${v}" does not match ${s.pattern}`)
    if (s.minLength != null && v.length < s.minLength) out.push(`${at}: too short`)
  }
  if (typeof v === 'number') {
    if (s.minimum != null && v < s.minimum) out.push(`${at}: below ${s.minimum}`)
    if (s.exclusiveMinimum != null && v <= s.exclusiveMinimum) out.push(`${at}: not above ${s.exclusiveMinimum}`)
  }
  if (Array.isArray(v)) {
    if (s.minItems != null && v.length < s.minItems) out.push(`${at}: fewer than ${s.minItems} items`)
    if (s.items) v.forEach((x, i) => out.push(...check(s.items!, x, `${at}[${i}]`)))
  }
  if (kind === 'object') {
    const o = v as Record<string, unknown>
    for (const k of s.required ?? []) if (!(k in o)) out.push(`${at}: missing ${k}`)
    for (const [k, x] of Object.entries(o)) {
      if (x === undefined) continue
      if (s.properties?.[k]) out.push(...check(s.properties[k], x, `${at}.${k}`))
      else if (s.additionalProperties === false) out.push(`${at}: unexpected ${k}`)
    }
  }
  return out
}

describe('the open formats', () => {
  it('every Asset Map entry fits asset-map-entry.v1, and the chain list matches the code', () => {
    for (const e of ENTRIES) expect(check(entrySchema as Schema, e), e.id).toEqual([])
    const chains = (entrySchema as { properties: { tokens: { items: { properties: { chain: { enum: string[] } } } } } }).properties.tokens.items.properties.chain.enum
    expect([...chains].sort()).toEqual(Object.keys(CHAINS).sort())
  })

  it('every corporate action fits corporate-action.v1', () => {
    for (const e of EVENTS) expect(check(eventSchema as Schema, e), e.id).toEqual([])
  })

  it('every Test Bench report fits test-bench-report.v1, valid or not', () => {
    for (const s of SAMPLES) expect(check(reportSchema as Schema, validate(s.xml)), s.id).toEqual([])
    expect(check(reportSchema as Schema, validate('not xml'))).toEqual([])
  })

  it('the issuer key file format accepts a key and refuses a bad one', () => {
    expect(check(keysSchema as Schema, { keys: [{ id: 'issuer-2026-11', publicKey: 'ab'.repeat(32) }] })).toEqual([])
    expect(check(keysSchema as Schema, { keys: [{ id: 'x', publicKey: 'nothex' }] })).not.toEqual([])
    expect(check(entrySchema as Schema, { ...ENTRIES[0], extra: 1 })).toEqual(['$: unexpected extra'])
  })
})

// The copies iomarkets.org serves (public/formats/) must be these files, byte for byte, when that repo sits beside this one.
function findOrg(): string | null {
  let dir = process.cwd()
  for (let i = 0; i < 6; i++) {
    const p = join(dir, 'New IoMarkets.org', 'public', 'formats')
    if (existsSync(p)) return p
    dir = dirname(dir)
  }
  return null
}
const org = findOrg()

describe.skipIf(!org)('iomarkets.org publishes the same formats', () => {
  it.each(['asset-map-entry.v1', 'asset-map-issuer-keys.v1', 'corporate-action.v1', 'test-bench-report.v1'])('%s', (name) => {
    const ours = readFileSync(join(process.cwd(), 'formats', `${name}.schema.json`), 'utf8')
    expect(readFileSync(join(org!, `${name}.schema.json`), 'utf8')).toBe(ours)
  })
})
