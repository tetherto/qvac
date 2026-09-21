import test from 'brittle'
import { z } from 'zod'
import { MODEL_CONFIG_SCHEMA_BY_TYPE } from '@/schemas/model-config-schemas'
import { ModelType } from '@/schemas/model-types'

// Contract guard: every load-time `modelConfig` field a model type exposes
// must carry a `.describe()`, so the language-neutral contract
// (contract/schema.json) and the generated clients document what each knob
// means. z.toJSONSchema surfaces `.describe()` text as `description`, so a
// field missing one shows up as a property without `description` here.
//
// The schemas checked are the single source of truth in
// MODEL_CONFIG_SCHEMA_BY_TYPE — the same map tools (the CLI's `qvac configure`)
// read to render field docs. Its `satisfies Record<...>` type already forces a
// new model type to be added, so this file only has to prove the described-ness
// of the surface and that no type was silently exempted at runtime.
//
// This intentionally checks the describable knob surface — base/runtime config
// schemas and the discriminated-union arms (tts / nmt / audiogen) — not the
// frozen legacy-ONNX deprecation placeholders (LEGACY_*_ONNX_MODEL_CONFIG_FIELDS),
// which are `z.unknown()` shims that only exist to raise a structured migration
// error and are excluded from the map by construction.

type JsonSchemaNode = {
  type?: string
  description?: string
  properties?: Record<string, JsonSchemaNode>
  anyOf?: JsonSchemaNode[]
  oneOf?: JsonSchemaNode[]
  allOf?: JsonSchemaNode[]
}

function collectUndescribed(node: JsonSchemaNode, path: string, out: string[]): void {
  for (const branch of [node.anyOf, node.oneOf, node.allOf]) {
    if (branch) for (const child of branch) collectUndescribed(child, path, out)
  }
  for (const [name, field] of Object.entries(node.properties ?? {})) {
    const childPath = `${path}.${name}`
    // A nested config object (e.g. whisper `vad_params`) needs no description of
    // its own; every other field (leaf or union, e.g. CosyVoice3 `instruct`) does.
    // Recurse regardless, so nested fields and union object arms are covered.
    const isContainer =
      field.type === 'object' && !!field.properties && Object.keys(field.properties).length > 0
    if (!isContainer && !field.description) out.push(childPath)
    collectUndescribed(field, childPath, out)
  }
}

for (const [label, schema] of Object.entries(MODEL_CONFIG_SCHEMA_BY_TYPE)) {
  test(`modelConfig fields are described: ${label}`, (t) => {
    const jsonSchema = z.toJSONSchema(schema, { unrepresentable: 'any' }) as JsonSchemaNode
    const undescribed: string[] = []
    collectUndescribed(jsonSchema, label, undescribed)
    t.is(
      undescribed.length,
      0,
      undescribed.length === 0
        ? 'all fields carry a description'
        : `add .describe() to: ${undescribed.join(', ')}`
    )
  })
}

// The map's `satisfies Record<Exclude<CanonicalModelType, 'onnx-tts'>, ...>`
// enforces coverage at compile time; this asserts the same at runtime and pins
// the one intended exemption (`onnx-tts`, a legacy alias routed to `tts-ggml`),
// so an accidental exemption can't slip through a type cast.
const EXEMPT_MODEL_TYPES = new Set<string>([ModelType.onnxTts])

test('every model type has a config schema entry', (t) => {
  const covered = new Set(Object.keys(MODEL_CONFIG_SCHEMA_BY_TYPE))
  const missing = Object.values(ModelType).filter(
    (type) => !EXEMPT_MODEL_TYPES.has(type) && !covered.has(type)
  )
  t.is(
    missing.length,
    0,
    missing.length === 0
      ? 'all model types covered'
      : `add a config schema for: ${missing.join(', ')}`
  )
})
