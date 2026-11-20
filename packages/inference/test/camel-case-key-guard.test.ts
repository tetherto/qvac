import test from 'brittle'
import { z } from 'zod'
import { requestSchema, responseSchema } from '@/schemas/common'
import { MODEL_CONFIG_SCHEMA_BY_TYPE } from '@/schemas/model-config-schemas'
import * as builtinPlugins from '@/plugins/builtin/index'

type JsonSchemaNode = {
  not?: unknown
  deprecated?: unknown
  properties?: Record<string, JsonSchemaNode>
  [key: string]: unknown
}

const CAMEL_CASE_KEY = /^[a-z][a-zA-Z0-9]*$/
const ACRONYM_RUN = /[A-Z]{3,}/

// A removed option keeps its old name so callers get a clear refusal, and a
// renamed response key keeps its old name for one release, marked deprecated.
function isExempt(node: JsonSchemaNode) {
  const forbidden =
    typeof node.not === 'object' && node.not !== null && Object.keys(node.not).length === 0
  return forbidden || node.deprecated === true
}

function collectNonCamelCaseKeys(node: unknown, path: string, out: Set<string>): void {
  if (Array.isArray(node)) {
    for (const child of node) collectNonCamelCaseKeys(child, path, out)
    return
  }
  if (typeof node !== 'object' || node === null) return
  const schema = node as JsonSchemaNode
  for (const [key, child] of Object.entries(schema)) {
    if (key !== 'properties') {
      collectNonCamelCaseKeys(child, path, out)
      continue
    }
    for (const [name, field] of Object.entries(schema.properties ?? {})) {
      const fieldPath = `${path}.${name}`
      if (!isExempt(field) && (!CAMEL_CASE_KEY.test(name) || ACRONYM_RUN.test(name))) {
        out.add(fieldPath)
      }
      collectNonCamelCaseKeys(field, fieldPath, out)
    }
  }
}

test('the guard flags snake_case, kebab-case and acronym-run keys, nested or not', (t) => {
  const found = new Set<string>()
  const schema = z.object({
    ctxSize: z.number(),
    clipLModelSrc: z.string(),
    ctx_size: z.number(),
    'main-gpu': z.number(),
    useGPU: z.boolean(),
    removed: z.never().optional().meta({ not: {} }),
    total_ms: z.number().optional().meta({ deprecated: true }),
    nested: z.object({ top_k: z.number() })
  })
  collectNonCamelCaseKeys(z.toJSONSchema(schema), 'fixture', found)
  t.alike([...found].sort(), [
    'fixture.ctx_size',
    'fixture.main-gpu',
    'fixture.nested.top_k',
    'fixture.useGPU'
  ])
})

const pluginHandlerSchemas = Object.values(builtinPlugins).flatMap((plugin) =>
  Object.entries(plugin.handlers).flatMap(([name, handler]) => [
    [`${plugin.modelType}.${name}.request`, handler.requestSchema as z.ZodType] as const,
    [`${plugin.modelType}.${name}.response`, handler.responseSchema as z.ZodType] as const
  ])
)

const PUBLIC_SCHEMAS: Record<string, z.ZodType> = {
  request: requestSchema,
  response: responseSchema,
  ...Object.fromEntries(
    Object.entries(MODEL_CONFIG_SCHEMA_BY_TYPE).map(([type, schema]) => [
      `modelConfig[${type}]`,
      schema as z.ZodType
    ])
  ),
  ...Object.fromEntries(pluginHandlerSchemas)
}

for (const [label, schema] of Object.entries(PUBLIC_SCHEMAS)) {
  test(`public schema keys are camelCase: ${label}`, (t) => {
    const found = new Set<string>()
    for (const io of ['input', 'output'] as const) {
      collectNonCamelCaseKeys(z.toJSONSchema(schema, { io, unrepresentable: 'any' }), label, found)
    }
    t.is(
      found.size,
      0,
      found.size === 0 ? 'every key is camelCase' : `rename to camelCase: ${[...found].join(', ')}`
    )
  })
}
