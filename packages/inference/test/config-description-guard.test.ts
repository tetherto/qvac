import test from 'brittle'
import { z } from 'zod'
import { llmConfigBaseSchema, embedConfigBaseSchema } from '@/schemas/llamacpp-config'
import { whisperConfigSchema, parakeetRuntimeConfigSchema } from '@/schemas/transcription-config'
import { bciConfigSchema } from '@/schemas/bci-config'
import { nmtConfigBaseSchema } from '@/schemas/translation-config'
import {
  ttsChatterboxLoadConfigSchema,
  ttsSupertonicLoadConfigSchema,
  ttsParlerLoadConfigSchema,
  ttsCosyvoice3LoadConfigSchema,
  ttsAudio8LoadConfigSchema
} from '@/schemas/text-to-speech'
import { ocrConfigSchema } from '@/schemas/ocr'
import { sdcppConfigSchema } from '@/schemas/sdcpp-config'
import { audioGenConfigSchema } from '@/schemas/audio-gen'
import { vlaConfigSchema } from '@/schemas/vla'
import { classificationConfigSchema } from '@/schemas/classification'
import { ModelType } from '@/schemas/model-types'

// Contract guard: every load-time `modelConfig` field a model type exposes
// must carry a `.describe()`, so the language-neutral contract
// (contract/schema.json) and the generated clients document what each knob
// means. z.toJSONSchema surfaces `.describe()` text as `description`, so a
// field missing one shows up as a property without `description` here.
//
// This intentionally checks the describable knob surface — the runtime/base
// config schemas and the TTS union arms — not the frozen legacy-ONNX
// deprecation placeholders (LEGACY_*_ONNX_MODEL_CONFIG_FIELDS), which are
// `z.unknown()` shims that only exist to raise a structured migration error.

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

const CONFIG_SCHEMAS: ReadonlyArray<readonly [string, z.ZodType]> = [
  ['llamacpp-completion', llmConfigBaseSchema],
  ['llamacpp-embedding', embedConfigBaseSchema],
  ['whispercpp-transcription', whisperConfigSchema],
  ['parakeet-transcription', parakeetRuntimeConfigSchema],
  ['bci-whispercpp-transcription', bciConfigSchema],
  ['nmtcpp-translation', nmtConfigBaseSchema],
  ['tts-ggml/chatterbox', ttsChatterboxLoadConfigSchema],
  ['tts-ggml/supertonic', ttsSupertonicLoadConfigSchema],
  ['tts-ggml/parler', ttsParlerLoadConfigSchema],
  ['tts-ggml/cosyvoice3', ttsCosyvoice3LoadConfigSchema],
  ['tts-ggml/audio8', ttsAudio8LoadConfigSchema],
  ['ggml-ocr', ocrConfigSchema],
  ['sdcpp-generation', sdcppConfigSchema],
  ['audiogen-ggml', audioGenConfigSchema],
  ['ggml-vla', vlaConfigSchema],
  ['ggml-classification', classificationConfigSchema]
]

for (const [label, schema] of CONFIG_SCHEMAS) {
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

// Guard against CONFIG_SCHEMAS drifting: every model type must have an entry
// above (or be explicitly exempt), so a newly added model type can't skip the
// description check. `onnx-tts` is a legacy alias that routes to `tts-ggml`.
const EXEMPT_MODEL_TYPES = new Set<string>([ModelType.onnxTts])

test('every model type is covered by a describe guard', (t) => {
  const covered = new Set(CONFIG_SCHEMAS.map(([label]) => label.split('/')[0]))
  const missing = Object.values(ModelType).filter(
    (type) => !EXEMPT_MODEL_TYPES.has(type) && !covered.has(type)
  )
  t.is(
    missing.length,
    0,
    missing.length === 0
      ? 'all model types covered'
      : `add a guard entry for: ${missing.join(', ')}`
  )
})
