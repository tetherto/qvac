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
      "Config to assess the load with. Merged over an alias's own `config`, nested objects key by key. Companion sources (every `*Src` key, such as `llmModelSrc` or `tokenizerSrc`, and every entry of a `*Srcs` list) must name SDK model constants."
    )
})

/** Mirrors the SDK's `assessModelFit()` input, with models named rather than sourced. */
export const modelFitBody = z.strictObject({
  models: z
    .array(fitCandidate)
    .min(1)
    .max(MAX_FIT_MODELS)
    .describe('Models to assess as if loaded at the same time.')
})

const verdict = z.enum(['fits', 'does-not-fit', 'unknown'])

// Loose, so a field the SDK adds later still reaches the client through the
// response serializer.
const device = z.looseObject({
  id: z
    .string()
    .describe("The device's PCI bus ID when the backend reports one, its name otherwise."),
  name: z.string().describe("The backend's device name, such as `CPU`, `CUDA0` or `MTL0`."),
  unified: z
    .boolean()
    .describe("Memory the host owns: the CPU, and a GPU that shares the host's memory."),
  usedBytes: z.number().describe('The memory the load takes on this device.'),
  freeBytes: z.number().optional().describe('The free memory the device reported.'),
  totalBytes: z.number().optional().describe('The total memory the device reported.')
})

const pool = z.looseObject({
  id: z
    .string()
    .describe("`host` for the host's memory, the device's `id` for a GPU with its own memory."),
  unified: z.boolean().describe('Whether this is the host pool.'),
  usedBytes: z.number().describe("The sum of every model's rows in this pool."),
  freeBytes: z.number().optional().describe('The lowest free figure reported for the pool.'),
  totalBytes: z.number().optional().describe('The lowest total figure reported for the pool.')
})

const modelResult = z.looseObject({
  model: z.string().describe('The alias or constant name as requested.'),
  status: verdict.describe("The engine fitter's verdict for this model alone."),
  devices: z
    .array(device)
    .describe('One row per device the load uses, the host last. Empty when unknown.'),
  stats: z
    .union([
      z.object({
        ctxSize: z.number().int().describe('The context size the load resolves to.'),
        gpuLayers: z.number().int().describe('The number of layers the load offloads to the GPU.')
      }),
      z.object({}).strict()
    ])
    .describe('The resolved load of a llama.cpp verdict. Empty otherwise.')
})

export const modelFitResult = z.looseObject({
  object: z.literal('model_fit'),
  verdict: verdict.describe('The verdict for every model loaded together.'),
  pools: z
    .array(pool)
    .describe('The memory pools the verdict was judged on, with what the set takes from each.'),
  models: z
    .array(modelResult)
    .describe("One entry per model, in request order: the engine addon's own fit result.")
})

export const MODEL_FIT_FIELD_CODES: Record<string, string> = {
  models: 'invalid_models',
  'models:too_big': 'too_many_models'
}
