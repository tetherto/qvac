import { jsonrepair } from 'jsonrepair'

const JSON_NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/

// Keys small models nest every argument under; unwrapped only when the tool did not declare them.
const ARG_WRAPPER_KEYS = new Set(['parameters', 'arguments', 'args', 'input', 'params'])

type JsonSchema = {
  type?: unknown
  enum?: unknown
  items?: unknown
  properties?: unknown
  required?: unknown
  additionalProperties?: unknown
  patternProperties?: unknown
  [keyword: string]: unknown
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isSchema(value: unknown): value is JsonSchema {
  return isPlainObject(value)
}

function schemaTypes(schema: unknown): Set<string> {
  const found = new Set<string>()
  if (!isSchema(schema)) return found
  const declared: unknown[] = Array.isArray(schema.type) ? schema.type : [schema.type]
  for (const type of declared) {
    if (typeof type === 'string') found.add(type)
  }
  for (const key of ['oneOf', 'anyOf']) {
    const branches = schema[key]
    if (!Array.isArray(branches)) continue
    for (const branch of branches) {
      for (const type of schemaTypes(branch)) found.add(type)
    }
  }
  return found
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const KEY_START = /[A-Za-z_$]/
const KEY_CHAR = /[\w$-]/

function colonAt(text: string, from: number): boolean {
  let i = from
  while (i < text.length && /\s/.test(text[i]!)) i++
  return text[i] === ':'
}

// Keys as they appear in the text, quoted or bare, followed by a colon. One
// pass: a quoted string is skipped whole, so its escaped quotes are never rescanned.
function writtenKeys(text: string): Set<string> {
  const keys = new Set<string>()
  let i = 0
  while (i < text.length) {
    const ch = text[i]!
    if (ch === '"' || ch === "'") {
      let j = i + 1
      while (j < text.length && text[j] !== ch && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1
      if (text[j] !== ch) {
        i = j
        continue
      }
      if (colonAt(text, j + 1)) keys.add(text.slice(i + 1, j))
      i = j + 1
    } else if (KEY_START.test(ch)) {
      let j = i + 1
      while (j < text.length && KEY_CHAR.test(text[j]!)) j++
      if (colonAt(text, j)) keys.add(text.slice(i, j))
      i = j
    } else {
      i++
    }
  }
  return keys
}

// Keys the one-pass scan can miss (spaces, odd quoting) get a regex search each, up to this many.
const MAX_LOOSE_KEY_CHECKS = 32

// jsonrepair turns stray words into keys (`{bad json` -> `{"bad json":null}`);
// a repair is kept only when every key it produced was written as a key.
function keysWritten(value: unknown, text: string): boolean {
  const written = writtenKeys(text)
  let looseChecks = 0

  function writtenLoosely(key: string): boolean {
    if (++looseChecks > MAX_LOOSE_KEY_CHECKS) return false
    return new RegExp(`(?:["']${escapeRegExp(key)}["']|\\b${escapeRegExp(key)})\\s*:`).test(text)
  }

  function check(node: unknown): boolean {
    if (Array.isArray(node)) return node.every(check)
    if (!isPlainObject(node)) return true
    return Object.entries(node).every(
      ([key, child]) => (written.has(key) || writtenLoosely(key)) && check(child)
    )
  }

  return check(value)
}

function read(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    try {
      const repaired: unknown = JSON.parse(jsonrepair(text))
      return keysWritten(repaired, text) ? repaired : null
    } catch {
      return null
    }
  }
}

function accept(value: unknown, types: ReadonlySet<string>): unknown {
  if (isPlainObject(value) && types.has('object')) return value
  if (Array.isArray(value) && types.has('array')) return value
  return null
}

/**
 * Reads an object or array the model wrote as text: malformed, fenced,
 * double-encoded, truncated or followed by prose. Null when the text does not
 * hold a value of one of `types`.
 */
export function readStructured(value: string, types: ReadonlySet<string>): unknown {
  const text = value.trim()
  const parsed = read(text)
  if (typeof parsed === 'string') {
    const inner = parsed.trim()
    if (inner !== text && (inner[0] === '{' || inner[0] === '[' || inner[0] === '"')) {
      return readStructured(parsed, types)
    }
    return null
  }

  const accepted = accept(parsed, types)
  if (accepted !== null) return accepted

  // jsonrepair reads `{…}\nprose` as NDJSON; a real array value has no trailing string.
  if (
    Array.isArray(parsed) &&
    types.has('object') &&
    isPlainObject(parsed[0]) &&
    typeof parsed.at(-1) === 'string'
  ) {
    return parsed[0]
  }

  if (text[0] === '"' && types.has('object')) return accept(read(`{${text}}`), types)
  return null
}

function parseScalar(text: string, types: ReadonlySet<string>): unknown {
  if (text === 'null' && types.has('null')) return null
  const lower = text.toLowerCase()
  if (types.has('boolean') && (lower === 'true' || lower === 'false')) return lower === 'true'
  if (!JSON_NUMBER.test(text)) return undefined

  const number = Number(text)
  // A non-zero mantissa that came out as 0 underflowed, as "1e-400" does.
  if (number === 0 && /[1-9]/.test(text.split(/e/i)[0]!)) return undefined
  if (Number.isInteger(number)) {
    const numeric = types.has('integer') || types.has('number')
    return numeric && Number.isSafeInteger(number) ? number : undefined
  }
  return types.has('number') && Number.isFinite(number) ? number : undefined
}

function foldEnum(value: string, values: unknown): string | undefined {
  if (!Array.isArray(values) || values.includes(value)) return undefined
  const lower = value.toLowerCase()
  const matches = values.filter((v) => typeof v === 'string' && v.toLowerCase() === lower)
  return matches.length === 1 ? (matches[0] as string) : undefined
}

// A field that can't hold a string or null, so a written `null` can only mean "left out".
export function omittable(schema: unknown): boolean {
  const types = schemaTypes(schema)
  return types.size > 0 && !types.has('string') && !types.has('null')
}

function repairString(value: string, schema: JsonSchema): unknown {
  const folded = foldEnum(value, schema.enum)
  if (folded !== undefined) return folded

  const types = schemaTypes(schema)
  // A string the schema accepts is a valid value, whatever it looks like.
  if (types.has('string')) return value
  if (types.has('object') || types.has('array')) {
    const parsed = readStructured(value, types)
    if (parsed !== null) return repairValue(parsed, schema)
  }

  if (types.size > 0) {
    const scalar = parseScalar(value.trim(), types)
    if (scalar !== undefined) return scalar
  }
  return value
}

function repairValue(value: unknown, schema: unknown): unknown {
  if (!isSchema(schema)) return value
  if (typeof value === 'string') return repairString(value, schema)
  if (Array.isArray(value)) {
    const out = value.map((item) => repairValue(item, schema.items))
    return out.some((item, i) => item !== value[i]) ? out : value
  }
  if (isPlainObject(value)) return repairProperties(value, schema)
  return value
}

function repairProperties(
  value: Record<string, unknown>,
  schema: JsonSchema
): Record<string, unknown> {
  if (!isPlainObject(schema.properties)) return value
  const required = Array.isArray(schema.required) ? schema.required : []
  let out: Record<string, unknown> | null = null
  for (const [key, child] of Object.entries(schema.properties)) {
    if (!Object.hasOwn(value, key)) continue
    const before = value[key]
    // An optional field the model wrote as "null" means it meant to leave it out.
    if (before === 'null' && !required.includes(key) && omittable(child)) {
      out ??= { ...value }
      delete out[key]
      continue
    }
    const after = repairValue(before, child)
    if (after !== before) {
      out ??= { ...value }
      out[key] = after
    }
  }
  return out ?? value
}

// The schema accepts `key` without declaring it, so it may be a real argument.
function acceptsUndeclaredKey(schema: JsonSchema, key: string): boolean {
  const extra = schema.additionalProperties
  if (extra === true || isPlainObject(extra)) return true
  if (!isPlainObject(schema.patternProperties)) return false
  return Object.keys(schema.patternProperties).some((pattern) => {
    try {
      return new RegExp(pattern, 'u').test(key)
    } catch {
      // A pattern this engine can't read might match: keep the key.
      return true
    }
  })
}

function unwrapArguments(
  args: Record<string, unknown>,
  schema: JsonSchema
): Record<string, unknown> {
  const declared = isPlainObject(schema.properties) ? schema.properties : {}
  const keys = Object.keys(args)
  if (keys.length !== 1) return args
  const only = keys[0]!
  if (!ARG_WRAPPER_KEYS.has(only) || Object.hasOwn(declared, only)) return args
  if (acceptsUndeclaredKey(schema, only)) return args
  const raw = args[only]
  const inner =
    typeof raw === 'string'
      ? readStructured(raw, new Set(['object']))
      : isPlainObject(raw)
        ? raw
        : null
  // Unwrapped only into arguments the tool declares.
  if (!isPlainObject(inner)) return args
  const innerKeys = Object.keys(inner)
  if (innerKeys.length === 0 || !innerKeys.every((key) => Object.hasOwn(declared, key))) return args
  return inner
}

/**
 * Brings decoded tool-call arguments in line with the tool's parameter schema
 * where the model's intent is unambiguous: structured values written as text,
 * scalars written as strings, enum casing, and arguments nested under a
 * wrapper key. Values a string parameter accepts are never changed; anything
 * lossy or ambiguous is left for validation. Returns `args` itself when
 * nothing changed.
 */
export function repairToolArguments(
  args: Record<string, unknown>,
  parameters: JsonSchema | undefined
): Record<string, unknown> {
  if (!parameters) return args
  return repairProperties(unwrapArguments(args, parameters), parameters)
}
