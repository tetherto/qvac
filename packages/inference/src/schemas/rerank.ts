import { z } from 'zod'

const rerankFields = {
  query: z.string().min(1).describe('Query to score each document against.'),
  documents: z
    .array(z.string())
    .min(1)
    .describe('Documents to score. Each one, paired with the query, must fit in `batch_size`.')
}

export const rerankRequestBodySchema = z.object(rerankFields).strict()

const envelope = { modelId: z.string().min(1) }
export const rerankParamsSchema = rerankRequestBodySchema.extend(envelope)
export const rerankRequestSchema = rerankRequestBodySchema.extend({
  ...envelope,
  type: z.literal('rerank'),
  requestId: z.string().min(1).optional()
})

export const rerankScoresSchema = z
  .array(z.number())
  .describe(
    "One relevance score per document, in input order. Higher is more relevant. Scores are the model's raw classifier output, so compare them within one model only."
  )
export const rerankResponseSchema = z.object({
  type: z.literal('rerank'),
  scores: rerankScoresSchema
})

export const rerankConfigBaseSchema = z
  .object({
    device: z.enum(['cpu', 'gpu']).optional().describe("Compute device. Default 'gpu'."),
    gpu_layers: z
      .number()
      .int()
      .optional()
      .describe('Layers to offload. Unset lets the addon choose placement.'),
    batch_size: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'Tokens per forward pass. Default 2048; each document paired with the query must fit.'
      ),
    backend: z
      .array(z.enum(['cuda', 'vulkan', 'metal', 'opencl', 'auto']))
      .min(1)
      .optional()
      .describe(
        "Ordered GPU backend names, such as ['cuda', 'vulkan']. " +
          'Accepted names: cuda, vulkan, metal, opencl, and auto for no preference. ' +
          'If unset, uses the native default order. ' +
          'If none of the specified names has a corresponding available device, selection falls back to the native default order. ' +
          "Use device: 'cpu' for CPU. " +
          "A GPU override cannot be combined with 'split-mode': 'layer'."
      ),
    poll: z
      .number()
      .int()
      .min(0)
      .max(100)
      .optional()
      .describe(
        'CPU polling level, from 0 to 100. If omitted, uses the default native behavior. Higher values may reduce wake latency but consume more CPU during GPU work.'
      ),
    pollBatch: z
      .number()
      .int()
      .min(0)
      .max(100)
      .optional()
      .describe(
        'CPU polling level for batch processing, from 0 to 100. If omitted, uses the default native behavior.'
      ),
    threads: z
      .number()
      .int()
      .optional()
      .describe('CPU threads, at most the CPU count. Zero or below uses all logical CPUs.'),
    'threads-batch': z
      .number()
      .int()
      .optional()
      .describe('Batch CPU threads. Unset uses threads; zero or below uses all logical CPUs.'),
    flash_attn: z
      .enum(['on', 'off', 'auto'])
      .optional()
      .describe('Flash attention mode. Default auto.'),
    verbosity: z
      .number()
      .int()
      .min(0)
      .max(3)
      .optional()
      .describe('Native log level: 0 error, 1 warn, 2 info, 3 debug.'),
    'main-gpu': z
      .union([z.number().int().nonnegative(), z.enum(['integrated', 'dedicated'])])
      .optional()
      .describe('GPU index or device class.'),
    'split-mode': z.enum(['none', 'layer']).optional().describe('Multi-GPU split mode.'),
    'tensor-split': z.string().optional().describe('Per-GPU tensor split proportions.'),
    openclCacheDir: z
      .string()
      .optional()
      .describe('Writable OpenCL kernel cache directory, required on Android.')
  })
  .strict()

export type RerankConfigInput = z.infer<typeof rerankConfigBaseSchema>

export const RERANK_CONFIG_DEFAULTS = {
  device: 'gpu'
} as const satisfies Partial<RerankConfigInput>

export const rerankConfigSchema = rerankConfigBaseSchema.transform((data) => ({
  ...RERANK_CONFIG_DEFAULTS,
  ...data,
  device: data.device ?? RERANK_CONFIG_DEFAULTS.device
}))

export type RerankParams = z.infer<typeof rerankParamsSchema>
export type RerankRequest = z.infer<typeof rerankRequestSchema>
export type RerankScores = z.infer<typeof rerankScoresSchema>
export type RerankResponse = z.infer<typeof rerankResponseSchema>
export type RerankConfig = z.infer<typeof rerankConfigSchema>
