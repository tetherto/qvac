import { z } from 'zod'
import { modelRegistryEngineSchema } from '@/schemas/registry'

/**
 * One group of transformer blocks that size their KV cache identically.
 *
 * Files that describe attention per layer (e.g. `gemma4`, whose
 * `head_count_kv` and `sliding_window_pattern` hold one entry per block) are
 * collapsed into these classes, so an estimator can sum the real cache instead
 * of assuming every block is the widest one.
 */
export const kvLayerClassSchema = z.object({
  count: z.number().describe('Number of blocks in this class.'),
  headCountKv: z.number().describe('KV heads per block in this class.'),
  keyLength: z.number().describe('Key head dimension for this class, in elements.'),
  valueLength: z.number().describe('Value head dimension for this class, in elements.'),
  windowed: z
    .boolean()
    .describe(
      'True when these blocks use sliding-window attention, so their cache is capped at `slidingWindow` tokens rather than the full context.'
    )
})

/**
 * Transformer shape facts read out of a model's GGUF key-value metadata at
 * catalog-generation time, from what the registry captured at ingest.
 *
 * Absent for non-GGUF artifacts and for GGUF files whose metadata extraction
 * failed — that absence is what makes a pre-download estimate unknown rather
 * than wrong.
 */
export const ggufFactsSchema = z.object({
  architecture: z.string().describe('`general.architecture`, e.g. `qwen35`, `bert`.'),
  blockCount: z.number().describe('Number of transformer blocks (layers).'),
  headCount: z.number().describe('Attention heads per block.'),
  headCountKv: z
    .number()
    .describe('KV heads per block; the maximum when the file stores one value per layer.'),
  keyLength: z.number().describe('Key head dimension, in elements.'),
  valueLength: z.number().describe('Value head dimension, in elements.'),
  embeddingLength: z.number().describe('Model embedding width, in elements.'),
  contextLength: z.number().describe('Trained context window, in tokens.'),
  parameterCount: z.number().optional().describe('Total parameters, when the file records it.'),
  slidingWindow: z
    .number()
    .optional()
    .describe('Sliding-window size, in tokens, for sliding-window-attention models.'),
  keyLengthSwa: z.number().optional().describe('Key head dimension on sliding-window blocks.'),
  valueLengthSwa: z.number().optional().describe('Value head dimension on sliding-window blocks.'),
  kvLayerClasses: z
    .array(kvLayerClassSchema)
    .optional()
    .describe(
      'Per-layer KV-cache breakdown, when the file describes attention per block. Absent means the flat fields above describe every block.'
    ),
  fullAttentionInterval: z
    .number()
    .optional()
    .describe(
      'For hybrid attention/recurrent models: only every Nth block holds a KV cache, the rest hold a fixed-size state.'
    ),
  ssmStateSize: z.number().optional().describe('SSM state size, for hybrid recurrent models.'),
  ssmConvKernel: z.number().optional().describe('SSM convolution kernel width.'),
  ssmInnerSize: z.number().optional().describe('SSM inner width.'),
  ssmGroupCount: z.number().optional().describe('SSM group count.'),
  assumptions: z
    .array(z.string())
    .optional()
    .describe('Notes on any value that was derived rather than read from the file.')
})

/**
 * Per-model data the pre-download resource estimators consume. Generated into
 * `models/registry/resource-profiles.ts` alongside the model catalog.
 *
 * Profiles hold facts only — no memory numbers — so re-calibrating an estimator
 * never requires regenerating the catalog.
 */
export const modelResourceProfileSchema = z.object({
  schemaVersion: z.literal(1).describe('Bumped whenever the emitted profile shape changes.'),
  engine: modelRegistryEngineSchema.describe('Canonical inference engine identifier.'),
  artifactBytes: z
    .number()
    .describe(
      'Total bytes that land on disk for this model: the summed shards, or every file of its companion set.'
    ),
  ggufFacts: ggufFactsSchema
    .optional()
    .describe('Absent when the model is not a GGUF or the registry has no usable metadata for it.'),
  assumptions: z
    .array(z.string())
    .optional()
    .describe('Notes on how the numbers above were derived.')
})

export type KvLayerClass = z.infer<typeof kvLayerClassSchema>
export type GgufFacts = z.infer<typeof ggufFactsSchema>
export type ModelResourceProfile = z.infer<typeof modelResourceProfileSchema>
