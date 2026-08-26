import { z } from 'zod'
import {
  modelTypeInputSchema,
  normalizeModelType,
  isCanonicalModelType,
  isModelTypeAlias
} from '@/schemas/model-types'
import { resolveCanonicalEngine } from '@/schemas/engine-addon-map'

// Addon field accepts model type inputs plus "vad"
const addonSchema = z.union([modelTypeInputSchema, z.literal('vad')])

// Shared phrasing for the accepted model-source locations, reused by every
// field-level `.describe()` that documents a model/asset source.
export const MODEL_SOURCE_URI_HINT =
  'a local file path, an HTTP(S) URL, or a `registry://` / `hyperdrive://` URI'

export const modelDescriptorSchema = z.object({
  src: z.string().describe(`Location of the model file: ${MODEL_SOURCE_URI_HINT}.`),
  name: z
    .string()
    .optional()
    .describe('Display name for this model instance; overrides the name derived from the source.'),
  modelId: z
    .string()
    .optional()
    .describe('Unique identifier used to reference the model in QVAC calls.'),
  registryPath: z
    .string()
    .optional()
    .describe('Registry-relative path to the model (set for registry-backed models).'),
  registrySource: z.string().optional().describe('Registry source identifier, e.g. `huggingface`.'),
  blobCoreKey: z.string().optional().describe('Hyperdrive blob core key for the model file.'),
  blobIndex: z
    .number()
    .optional()
    .describe('Internal: index of this shard within its Hyperdrive blob core, for sharded models.'),
  engine: z
    .string()
    .optional()
    .describe('Canonical inference engine identifier, e.g. `llamacpp-completion`.'),
  expectedSize: z.number().optional().describe('Expected total size of the model file in bytes.'),
  sha256Checksum: z.string().optional().describe('Expected SHA-256 checksum of the model file.'),
  addon: addonSchema
    .optional()
    .describe('Inference addon / capability category this model belongs to.')
})

export const modelSrcInputSchema = z.union([z.string(), modelDescriptorSchema])

export type ModelDescriptor = z.infer<typeof modelDescriptorSchema>
export type ModelSrcInput = z.infer<typeof modelSrcInputSchema>

/**
 * Schema that transforms ModelSrc to its src string
 * Usage: modelSrcToStringSchema.parse(modelSrc)
 */
export const modelInputToSrcSchema = modelSrcInputSchema.transform((modelSrc) => {
  return typeof modelSrc === 'string' ? modelSrc : modelSrc.src
})

/**
 * Schema that transforms ModelSrc to its optional name
 * Usage: modelSrcToNameSchema.parse(modelSrc)
 */
export const modelInputToNameSchema = modelSrcInputSchema.transform((modelSrc) => {
  if (typeof modelSrc === 'object' && 'name' in modelSrc) {
    return typeof modelSrc.name === 'string' ? modelSrc.name : undefined
  }
  return undefined
})

export function inferModelTypeFromModelSrc(modelSrc: unknown): string | undefined {
  if (typeof modelSrc !== 'object' || modelSrc === null) {
    return undefined
  }
  const descriptor = modelSrc as Record<string, unknown>

  const engine = descriptor['engine']
  if (typeof engine === 'string' && engine.length > 0) {
    const canonical = resolveCanonicalEngine(engine)
    if (canonical) return canonical
    if (isCanonicalModelType(engine) || isModelTypeAlias(engine)) {
      return normalizeModelType(engine)
    }
  }

  const addon = descriptor['addon']
  if (typeof addon === 'string' && addon.length > 0) {
    const canonical = resolveCanonicalEngine(addon)
    if (canonical) return canonical
    if (isCanonicalModelType(addon) || isModelTypeAlias(addon)) {
      return normalizeModelType(addon)
    }
  }

  return undefined
}
