// Bridges the SDK's exported modelConfig Zod schemas into configure's parameter
// editor: enumerate a model type's config fields with type hints + descriptions,
// and validate user input against the real schema. Only the schemas the SDK
// exports today (llamacpp completion + embedding) are wired; extend the map as
// the SDK exposes more (whisper, diffusion, tts, ...).
import { z } from 'zod'
import { llamacppCompletionConfigSchema, llamacppEmbeddingConfigSchema } from '@qvac/sdk/schemas'

type ConfigSchema = z.ZodObject<z.ZodRawShape>

const SCHEMA_BY_ADDON: Record<string, ConfigSchema> = {
  llm: llamacppCompletionConfigSchema as ConfigSchema,
  embeddings: llamacppEmbeddingConfigSchema as ConfigSchema
}

export function configSchemaForAddon(addon: string | null | undefined): ConfigSchema | undefined {
  if (!addon) return undefined
  return SCHEMA_BY_ADDON[addon]
}

export interface ParamField {
  name: string
  type: string
  description: string
  schema: z.ZodType
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
}

function typeLabel(node: JsonNode | undefined): string {
  if (!node) return 'value'
  // Render enum/const values bare (`causal | non-causal`, not `"causal" | ...`)
  // so the hint matches what the user types; coerceParam accepts bare, single-,
  // or double-quoted forms.
  if (Array.isArray(node.enum)) return node.enum.map((v) => String(v)).join(' | ')
  if (Array.isArray(node.anyOf)) return node.anyOf.map((n) => typeLabel(n as JsonNode)).join(' | ')
  if (node.const !== undefined) return String(node.const)
  if (node.type === 'array') return `${typeLabel(node.items as JsonNode)}[]`
  const base = typeof node.type === 'string' ? node.type : 'value'
  const bounds: string[] = []
  if (typeof node.minimum === 'number') bounds.push(`>= ${node.minimum}`)
  if (typeof node.maximum === 'number') bounds.push(`<= ${node.maximum}`)
  return bounds.length ? `${base} (${bounds.join(', ')})` : base
}

export function paramFields(schema: ConfigSchema): ParamField[] {
  const json = z.toJSONSchema(schema, { unrepresentable: 'any' }) as {
    properties?: Record<string, JsonNode>
  }
  const props = json.properties ?? {}
  return Object.entries(schema.shape).map(([name, field]) => {
    const node = props[name]
    return {
      name,
      type: typeLabel(node),
      description: typeof node?.description === 'string' ? node.description : '',
      schema: field as z.ZodType
    }
  })
}

// Coerce a raw string into the value the field expects. JSON handles
// numbers/booleans/arrays/double-quoted strings; if that fails, a value wrapped
// in single quotes (as field hints render enum values, e.g. 'causal') is
// unwrapped, otherwise the bare string is used. So `causal`, `'causal'`, and
// `"causal"` all coerce to the same value.
export function coerceParam(raw: string): unknown {
  const t = raw.trim()
  if (t === '') return undefined
  try {
    return JSON.parse(t)
  } catch {
    const singleQuoted = t.match(/^'(.*)'$/)
    return singleQuoted ? singleQuoted[1] : t
  }
}

// Empty input clears the field; otherwise the coerced value must pass the field
// schema. Returns true or a message for @inquirer's validate.
export function validateParam(field: ParamField, raw: string): true | string {
  if (raw.trim() === '') return true
  const result = field.schema.safeParse(coerceParam(raw))
  if (result.success) return true
  return result.error.issues[0]?.message ?? 'Invalid value'
}
