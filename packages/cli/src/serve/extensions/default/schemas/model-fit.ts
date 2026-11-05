import { z } from 'zod'

/** Each candidate fetches a registry fit stub, so the list size bounds network work. */
export const MAX_FIT_MODELS = 16

const fitCandidate = z.strictObject({
  model: z
    .string()
    .min(1)
    .describe(
      'A `serve.models` alias, or an SDK model constant name such as `QWEN3_600M_INST_Q4`.'
    ),
  modelConfig: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      "Config to assess the load with. Merged over an alias's own `config`, nested objects key by key. Companion model sources (`*ModelSrc`) must name SDK model constants."
    )
})

/** Mirrors the SDK's `assessModelFit()` input, with models named rather than sourced. */
export const modelFitBody = z.strictObject({
  models: z
    .array(fitCandidate)
    .min(1)
    .max(MAX_FIT_MODELS)
    .describe('Models to assess together under one memory budget.'),
  execution: z
    .enum(['sequential', 'concurrent'])
    .optional()
    .describe(
      '`sequential` (default) counts only the largest working-memory peak; `concurrent` counts every peak. A declared assumption, not a scheduling instruction.'
    ),
  policy: z
    .literal('interactive-v1')
    .optional()
    .describe('Headroom policy. `interactive-v1` (default) withholds 20% of available memory.')
})

const verdict = z.enum(['likely-fits', 'likely-too-large', 'unknown'])

// Loose, so a field the SDK adds later still reaches the client through the
// response serializer. Evidence and basis stay open strings for the same reason.
const modelResult = z.looseObject({
  model: z.string().describe('The alias or constant name as requested.'),
  name: z.string().describe('Catalog name of the assessed model.'),
  verdict,
  evidence: z.string().optional(),
  floorBytes: z.number().optional(),
  estimatorVersion: z.string().optional(),
  device: z.string().optional(),
  reasons: z.array(z.string())
})

const budget = z.looseObject({
  totalBytes: z.number(),
  usedBytes: z.number(),
  availableBytes: z.number(),
  reservedBytes: z.number(),
  availableAfterReserveBytes: z.number()
})

export const modelFitResult = z.looseObject({
  object: z.literal('model_fit'),
  verdict,
  basis: z.string(),
  execution: z.enum(['sequential', 'concurrent']),
  evidence: z.string().optional(),
  budget: budget.optional(),
  floorBytes: z.number().optional(),
  models: z.array(modelResult).describe('Per-model verdicts, in request order.'),
  reasons: z.array(z.string()),
  assumptions: z.array(z.string())
})

export const MODEL_FIT_FIELD_CODES: Record<string, string> = {
  models: 'invalid_models',
  'models:too_big': 'too_many_models',
  execution: 'invalid_execution',
  policy: 'invalid_policy'
}
