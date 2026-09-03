// Bridges the SDK's exported modelConfig Zod schemas into configure's parameter
// editor: resolve a model type's config schema, enumerate its fields with type
// hints + descriptions, and validate user input against the real schema.
//
// Schemas are resolved through the SDK's single source of truth
// (`configSchemaForModelType`), so every model type — and any addon added to the
// SDK later — is documented here without a hand-maintained per-addon list. A
// config schema may be a plain object, or a discriminated union (tts / nmt /
// audiogen) whose variant is chosen before its fields are edited.
import { z } from 'zod'
import { configSchemaForModelType } from '@qvac/sdk/schemas'

export function configSchemaForAddon(addon: string | null | undefined): z.ZodType | undefined {
  if (!addon) return undefined
  // The schema comes from @qvac/sdk (its own Zod instance). Cast to the CLI's
  // Zod type at this boundary so a Zod minor-version skew between the published
  // SDK and the CLI doesn't fail typechecking; both are Zod v4, structurally
  // identical here.
  return configSchemaForModelType(addon) as z.ZodType | undefined
}

export interface ParamField {
  name: string
  type: string
  description: string
  /** Schema default (`.default()`), offered as the input's prefilled value. */
  default: unknown
  /** True when the schema marks this field required (no default, not optional). */
  required: boolean
  /**
   * For a field that accepts an object (e.g. a modelSrc `string | { src, … }`),
   * the object arm's own fields — so the editor drills in and edits them
   * property-by-property, with descriptions, exactly like top-level config.
   */
  objectFields?: ParamField[] | undefined
  /** True when the field also accepts a plain string (so string vs object is a real choice). */
  acceptsString: boolean
  schema: z.ZodType
}

// A config schema resolves to either a flat field list, or a discriminated set
// where the user picks a variant (e.g. tts `ttsEngine`) before editing its
// fields. `null` when the schema exposes no editable surface.
export type ConfigParamModel =
  | { kind: 'object'; fields: ParamField[] }
  | { kind: 'variants'; discriminator: string; variants: ConfigVariant[] }

export interface ConfigVariant {
  value: string
  fields: ParamField[]
}

type JsonNode = {
  type?: unknown
  enum?: unknown
  anyOf?: unknown
  const?: unknown
  items?: unknown
  minimum?: unknown
  maximum?: unknown
  description?: unknown
  default?: unknown
  properties?: unknown
  required?: unknown
}

// Render an object node's shape as just its required keys (e.g. `{ src: string }`)
// — enough to signal what's mandatory. Optional keys aren't listed here: the
// editor drills into the object and shows every field with its description, so a
// hint doesn't need to (and can't usefully) enumerate them.
function objectLabel(node: JsonNode, depth: number): string {
  const props = node.properties as Record<string, JsonNode> | undefined
  if (!props || Object.keys(props).length === 0) return 'object'
  const required = new Set(Array.isArray(node.required) ? (node.required as string[]) : [])
  const parts: string[] = []
  for (const [key, child] of Object.entries(props)) {
    if (required.has(key)) parts.push(`${key}: ${typeLabel(child, depth + 1)}`)
  }
  return parts.length > 0 ? `{ ${parts.join(', ')} }` : 'object'
}

function typeLabel(node: JsonNode | undefined, depth = 0): string {
  if (!node) return 'value'
  // Render enum/const values bare (`causal | non-causal`, not `"causal" | ...`)
  // so the hint matches what the user types; coerceParam accepts bare, single-,
  // or double-quoted forms.
  if (Array.isArray(node.enum)) return node.enum.map((v) => String(v)).join(' | ')
  if (Array.isArray(node.anyOf)) {
    return node.anyOf.map((n) => typeLabel(n as JsonNode, depth)).join(' | ')
  }
  if (node.const !== undefined) return String(node.const)
  if (node.type === 'array') return `${typeLabel(node.items as JsonNode, depth)}[]`
  if (node.type === 'object' && node.properties) {
    return depth >= 1 ? 'object' : objectLabel(node, depth)
  }
  const base = typeof node.type === 'string' ? node.type : 'value'
  const bounds: string[] = []
  if (typeof node.minimum === 'number') bounds.push(`>= ${node.minimum}`)
  if (typeof node.maximum === 'number') bounds.push(`<= ${node.maximum}`)
  return bounds.length ? `${base} (${bounds.join(', ')})` : base
}

// A Zod discriminated union exposes its discriminator key and object arms on
// `.def`; anything with a `.shape` is a plain object. Both are duck-typed so this
// works across the SDK's and CLI's Zod copies (instanceof would not).
type UnknownSchema = {
  shape?: Record<string, z.ZodType>
  def?: { discriminator?: unknown; options?: unknown; innerType?: unknown }
}

function asDiscriminatedUnion(
  schema: z.ZodType
): { discriminator: string; options: z.ZodType[] } | null {
  const def = (schema as UnknownSchema).def
  if (def && typeof def.discriminator === 'string' && Array.isArray(def.options)) {
    return { discriminator: def.discriminator, options: def.options as z.ZodType[] }
  }
  return null
}

function objectShape(schema: z.ZodType): Record<string, z.ZodType> | null {
  const shape = (schema as UnknownSchema).shape
  return shape && typeof shape === 'object' ? shape : null
}

// True when the field's JSON node accepts a plain string (directly or as a union
// arm) — so string vs object is offered as a choice.
function acceptsStringArm(node: JsonNode | undefined): boolean {
  if (!node) return false
  if (node.type === 'string') return true
  if (Array.isArray(node.anyOf)) {
    return (node.anyOf as JsonNode[]).some((arm) => arm.type === 'string')
  }
  return false
}

// Strip optional/default/nullable wrappers to the schema they wrap.
function unwrapSchema(schema: z.ZodType): z.ZodType {
  let current = schema
  for (;;) {
    const inner = (current as UnknownSchema).def?.innerType
    if (!inner) return current
    current = inner as z.ZodType
  }
}

// The object arm of a field's schema, if it accepts one (a plain object, or an
// object member of a union) — the ZodObject whose fields the editor drills into.
function objectArmSchema(schema: z.ZodType): z.ZodType | null {
  const inner = unwrapSchema(schema)
  if (objectShape(inner)) return inner
  const options = (inner as UnknownSchema).def?.options
  if (Array.isArray(options)) {
    for (const option of options) {
      const armInner = unwrapSchema(option as z.ZodType)
      if (objectShape(armInner)) return armInner
    }
  }
  return null
}

// Depth guard: config objects nest shallowly (a modelSrc descriptor of scalars);
// this stops runaway recursion on any unexpectedly deep or self-referential shape.
const MAX_OBJECT_FIELD_DEPTH = 3

function fieldsFromObject(schema: z.ZodType, skip?: string, depth = 0): ParamField[] {
  const shape = objectShape(schema)
  if (!shape) return []
  const json = z.toJSONSchema(schema, { unrepresentable: 'any' }) as {
    properties?: Record<string, JsonNode>
    required?: string[]
  }
  const props = json.properties ?? {}
  const required = new Set(json.required ?? [])
  return Object.entries(shape)
    .filter(([name]) => name !== skip)
    .map(([name, field]) => {
      const node = props[name]
      const objArm = depth < MAX_OBJECT_FIELD_DEPTH ? objectArmSchema(field) : null
      return {
        name,
        type: typeLabel(node),
        description: typeof node?.description === 'string' ? node.description : '',
        default: node?.default,
        required: required.has(name),
        objectFields: objArm ? fieldsFromObject(objArm, undefined, depth + 1) : undefined,
        acceptsString: acceptsStringArm(node),
        schema: field
      }
    })
}

function discriminatorValue(arm: z.ZodType, key: string): string | undefined {
  const json = z.toJSONSchema(arm, { unrepresentable: 'any' }) as {
    properties?: Record<string, JsonNode>
  }
  const node = json.properties?.[key]
  if (!node) return undefined
  if (node.const !== undefined) return String(node.const)
  if (Array.isArray(node.enum) && node.enum.length === 1) return String(node.enum[0])
  return undefined
}

// Flat field list for a plain object config schema. For schemas that may be a
// discriminated union, use configParamModel.
export function paramFields(schema: z.ZodType): ParamField[] {
  return fieldsFromObject(schema)
}

export function configParamModel(schema: z.ZodType): ConfigParamModel | null {
  const union = asDiscriminatedUnion(schema)
  if (union) {
    const variants = union.options
      .map((arm) => {
        const value = discriminatorValue(arm, union.discriminator)
        return value === undefined
          ? null
          : { value, fields: fieldsFromObject(arm, union.discriminator) }
      })
      .filter((v): v is ConfigVariant => v !== null)
    return variants.length > 0
      ? { kind: 'variants', discriminator: union.discriminator, variants }
      : null
  }
  if (objectShape(schema)) return { kind: 'object', fields: fieldsFromObject(schema) }
  return null
}

// Parse a raw input string into the value a field expects, or report why it
// can't. Object/array input (`{`/`[`) is meant as JSON and must parse — a
// failure is an error, never a silent fall-through to a string (which a
// string-typed field like modelSrc would wrongly accept). Other input tries
// JSON (numbers/booleans/double-quoted strings), then a single-quoted form (as
// enum hints render, e.g. 'causal'), else the bare string.
type ParsedParam = { value: unknown } | { error: string }

function parseParam(raw: string): ParsedParam {
  const t = raw.trim()
  if (t === '') return { value: undefined }
  if (t.startsWith('{') || t.startsWith('[')) {
    try {
      return { value: JSON.parse(t) }
    } catch {
      return { error: 'Invalid JSON — use double quotes, e.g. {"src": "/path/to/file"}' }
    }
  }
  try {
    return { value: JSON.parse(t) }
  } catch {
    const singleQuoted = t.match(/^'(.*)'$/)
    return { value: singleQuoted ? singleQuoted[1] : t }
  }
}

// So `causal`, `'causal'`, and `"causal"` all coerce to the same value; blank
// and unparseable object input coerce to undefined (the latter is blocked by
// validateParam before it reaches here).
export function coerceParam(raw: string): unknown {
  const parsed = parseParam(raw)
  return 'value' in parsed ? parsed.value : undefined
}

// Validate a concrete value against the field schema. Returns true or a message
// that lists each issue with its path (so an object points at the bad key) and
// restates the expected type — a bare "Invalid input" from a union otherwise
// leaves the user guessing.
export function validateValue(field: ParamField, value: unknown): true | string {
  const result = field.schema.safeParse(value)
  if (result.success) return true
  const detail = result.error.issues
    .map((issue) =>
      issue.path.length ? `${issue.path.join('.')}: ${issue.message}` : issue.message
    )
    .join('; ')
  return `${detail || 'Invalid value'} (expected ${field.type})`
}

// Empty input clears the field; otherwise the value must parse and pass the
// field schema. Returns true or a message for @inquirer's validate.
export function validateParam(field: ParamField, raw: string): true | string {
  if (raw.trim() === '') return true
  const parsed = parseParam(raw)
  if ('error' in parsed) return `${parsed.error} (expected ${field.type})`
  return validateValue(field, parsed.value)
}
