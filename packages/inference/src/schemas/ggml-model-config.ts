import { z } from 'zod'

/**
 * Load options every `@qvac/classification-ggml` model takes (its
 * `GgmlModelOptions`). Each engine spreads these into its own config schema,
 * so an engine can still add fields of its own.
 */
export const ggmlModelConfigShape = {
  backend: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Exact GGML device name, such as CPU, CUDA0, Vulkan0 or MTL0. Omit to select GPU, then CPU. Metal and Metal0 are accepted aliases. An unavailable explicit device fails to load.'
    ),
  threads: z
    .number()
    .int()
    .min(1)
    .max(1024)
    .optional()
    .describe('CPU thread count, from 1 to 1024. Omit to use the native default.'),
  backendsDir: z
    .string()
    .min(1)
    .optional()
    .describe('Directory of GGML backend modules. Omit to use the modules shipped with Fabric.')
}
