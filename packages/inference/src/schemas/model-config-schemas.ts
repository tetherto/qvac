import { z } from 'zod'
import { llmConfigBaseSchema, embedConfigBaseSchema } from '@/schemas/llamacpp-config'
import { whisperConfigSchema, parakeetRuntimeConfigSchema } from '@/schemas/transcription-config'
import { bciConfigSchema } from '@/schemas/bci-config'
import { nmtConfigBaseSchema } from '@/schemas/translation-config'
import { ttsLoadConfigSchema } from '@/schemas/text-to-speech'
import { ocrConfigSchema } from '@/schemas/ocr'
import { sdcppConfigSchema } from '@/schemas/sdcpp-config'
import { audioGenConfigSchema } from '@/schemas/audio-gen'
import { vlaConfigSchema } from '@/schemas/vla'
import { classificationConfigSchema } from '@/schemas/classification'
import { ModelType, normalizeModelType, type CanonicalModelType } from '@/schemas/model-types'

// Canonical model type -> the `modelConfig` schema whose fields a user
// configures. This is the describable, user-facing config surface: base/runtime
// schemas and the load-time discriminated unions (tts / nmt / audiogen),
// excluding the legacy ONNX deprecation placeholders. It is the single source
// tools read to document config fields — the describe-guard test checks every
// entry carries `.describe()` text, and the CLI's `qvac configure` resolves a
// model's schema through here to render field docs.
//
// `satisfies Record<...>` makes a newly added model type a compile error until
// its config schema is wired here, so a new addon can't silently ship without
// documented, tool-visible config. `onnx-tts` is a legacy alias that routes to
// `tts-ggml`, so it is not a key of its own.
export const MODEL_CONFIG_SCHEMA_BY_TYPE = {
  [ModelType.llamacppCompletion]: llmConfigBaseSchema,
  [ModelType.whispercppTranscription]: whisperConfigSchema,
  [ModelType.bciWhispercppTranscription]: bciConfigSchema,
  [ModelType.llamacppEmbedding]: embedConfigBaseSchema,
  [ModelType.nmtcppTranslation]: nmtConfigBaseSchema,
  [ModelType.ttsGgml]: ttsLoadConfigSchema,
  [ModelType.parakeetTranscription]: parakeetRuntimeConfigSchema,
  [ModelType.ggmlOcr]: ocrConfigSchema,
  [ModelType.sdcppGeneration]: sdcppConfigSchema,
  [ModelType.audiogenGgml]: audioGenConfigSchema,
  [ModelType.ggmlVla]: vlaConfigSchema,
  [ModelType.ggmlClassification]: classificationConfigSchema
} satisfies Record<Exclude<CanonicalModelType, typeof ModelType.onnxTts>, z.ZodType>

// Resolve a model's `modelConfig` schema from any accepted model-type input: a
// canonical type (`tts-ggml`), a backward-compat alias (`tts`), or an engine /
// addon string that normalizes to one. Returns undefined for types with no
// configurable surface (e.g. `onnx-vad`) or unknown custom plugin types.
export function configSchemaForModelType(modelType: string): z.ZodType | undefined {
  const canonical = normalizeModelType(modelType)
  const key = canonical === ModelType.onnxTts ? ModelType.ttsGgml : canonical
  return (MODEL_CONFIG_SCHEMA_BY_TYPE as Record<string, z.ZodType>)[key]
}
