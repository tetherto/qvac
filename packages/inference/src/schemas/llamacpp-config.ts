import { z } from 'zod'
import { modelSrcInputSchema } from '@/schemas/model-src-utils'

/**
 * Upper bound for `reasoning_budget`. Mirrors the llm-llamacpp addon, which
 * stores the budget as a 32-bit `int` and rejects values above
 * `std::numeric_limits<int>::max()`.
 */
export const REASONING_BUDGET_MAX = 2147483647

export const VERBOSITY = {
  ERROR: 0,
  WARN: 1,
  INFO: 2,
  DEBUG: 3
} as const

const verbositySchema = z.enum(VERBOSITY)

// Base schema - validates types, all fields optional (for input validation)
export const llmConfigBaseSchema = z.object({
  ctx_size: z
    .number()
    .optional()
    .describe(
      "Context window size in tokens; `0` uses the model's trained context length. Default 1024."
    ),
  temp: z.number().min(0).max(2).optional().describe('Sampling temperature (0–2). Default 0.8.'),
  top_p: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe('Top-p (nucleus) sampling cutoff (0–1). Default 0.9.'),
  top_k: z
    .number()
    .int()
    .min(0)
    .max(128)
    .optional()
    .describe('Top-k sampling — keep only the top K tokens (0–128). Default 40.'),
  seed: z.number().optional().describe('Sampling RNG seed; `-1` (default) picks a random seed.'),
  gpu_layers: z
    .number()
    .optional()
    .describe('Number of model layers to offload to the GPU. Default 99 (offload all).'),
  lora: z
    .string()
    .optional()
    .describe('Path to a LoRA adapter file to apply on top of the base model.'),
  device: z
    .string()
    .optional()
    .describe("Device to run inference on: `'gpu'` or `'cpu'`. Default `'gpu'`."),
  predict: z
    .union([
      z.literal(-1), // special: until stop token
      z.literal(-2), // special: until context filled
      z.number().int().min(1) // positive integer: fixed token count
    ])
    .optional()
    .describe('Max tokens to predict. `-1` = until stop token, `-2` = until context filled.'),
  system_prompt: z
    .string()
    .optional()
    .describe(
      "Seeds conversation history on the JS side only; never forwarded to the addon. Default `'You are a helpful assistant.'`"
    ),
  load_mode: z
    .enum(['none', 'mmap', 'mlock', 'mmap+mlock', 'dio'])
    .optional()
    .describe(
      "Model loading mode: `'none'`, `'mmap'`, `'mlock'`, `'mmap+mlock'`, or `'dio'`. Unset uses the addon's default (`'mmap'`)."
    ),
  verbosity: verbositySchema
    .optional()
    .describe('Native log verbosity: `0`=ERROR, `1`=WARN, `2`=INFO, `3`=DEBUG. Default 0.'),
  presence_penalty: z
    .number()
    .optional()
    .describe('Presence penalty applied to tokens that have already appeared. Default 0.'),
  frequency_penalty: z
    .number()
    .optional()
    .describe('Frequency penalty applied to tokens by their frequency so far. Default 0.'),
  repeat_penalty: z
    .number()
    .optional()
    .describe('Repetition penalty applied to repeated tokens. Default 1.1.'),
  stop_sequences: z
    .array(z.string())
    .optional()
    .describe(
      'Strings that stop generation when produced (forwarded to the addon as `reverse_prompt`).'
    ),
  n_discarded: z
    .number()
    .optional()
    .describe(
      'Tokens to discard from the front of the context when it fills (sliding window); `0` (default) disables sliding. In batch mode clamped to the per-slot window (`ctx_size / parallel`).'
    ),
  parallel: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      'Concurrent sequence slots for continuous batching (1–256). Default 1 (sequential, batching off); `>= 2` enables batched decoding and splits the KV cache evenly across slots.'
    ),
  tools: z
    .boolean()
    .optional()
    .describe("Enable tool calling via the model's jinja chat template. Default false."),
  'cache-type-k': z
    .string()
    .optional()
    .describe(
      'KV-cache key quantization type (`f16`, `f32`, `bf16`, `q8_0`, `q4_0`, …). Unset selects a backend-safe default.'
    ),
  'cache-type-v': z
    .string()
    .optional()
    .describe(
      'KV-cache value quantization type; quantizing the value cache requires flash attention. Unset selects a backend-safe default.'
    ),
  'main-gpu': z
    .union([z.number().int().min(0), z.enum(['integrated', 'dedicated'])])
    .optional()
    .describe(
      "GPU to use on multi-GPU systems: a device index, or `'integrated'`/`'dedicated'` to restrict selection to that class."
    ),
  'split-mode': z
    .enum(['none', 'layer', 'row'])
    .optional()
    .describe(
      "How to split the model across GPUs: `'none'` (default, single GPU), `'layer'` (pipeline parallelism), or `'row'` (tensor parallelism)."
    ),
  'tensor-split': z
    .string()
    .optional()
    .describe(
      "Proportions for distributing layers/rows across GPUs, e.g. `'1,1'` (equal) or `'3,1'` (75/25)."
    ),
  openclCacheDir: z
    .string()
    .optional()
    .describe(
      'Writable directory for the OpenCL kernel binary cache; required on Android for fast GPU startup.'
    ),
  reasoning_budget: z
    .number()
    .int()
    .min(-1)
    .max(REASONING_BUDGET_MAX)
    .optional()
    .describe(
      'Reasoning-channel token budget. `-1` (default) unrestricted, `0` disables it, any positive integer caps the reasoning channel at that many tokens (the closing think tag is force-emitted once the budget is spent).'
    ),
  projectionModelSrc: modelSrcInputSchema
    .optional()
    .describe(
      'Multimodal projection (mmproj / vision encoder) model source; multimodal models only.'
    ),
  image_tile_mode: z
    .enum(['disabled', 'batched', 'sequential'])
    .optional()
    .describe(
      "Qwen3.5-VL multi-tile image encoding mode (multimodal models only): `'sequential'` (default) encodes image tiles one at a time, `'batched'` encodes all tiles in a single batched pass, `'disabled'` does no multi-tile encoding (single tile). Ignored by text-only models."
    ),
  image_no_upscale: z
    .enum(['on', 'off'])
    .optional()
    .describe(
      "idefics3-style image preprocessing rule (multimodal models only): `'on'` rounds the image's long side up to a whole number of slices and caps it, so an image smaller than the cap keeps its own resolution and becomes far fewer slices; `'off'` always stretches the long side to the cap. When unset, the model's own GGUF value is used; ignored with a warning by models that do not use idefics3-style preprocessing. Changes the number of image tokens (and therefore both accuracy and encode time), so a checkpoint whose GGUF omits the key needs this set to preprocess correctly."
    ),
  'mmproj-use-gpu': z
    .boolean()
    .optional()
    .describe(
      'Run the multimodal projector (mmproj / vision encoder) on the GPU (multimodal models only). `true` forces GPU, `false` forces CPU. When unset, the backend is auto-selected per device class: GPU on desktop/iOS and Android Adreno 800+; CPU on every other Android GPU (Arm Mali, Adreno <800, and undetectable Adreno tiers), with the LLM layers still on the GPU. Only honoured when the model itself runs on a GPU backend — ignored with a warning on CPU.'
    )
})

export type LlmConfigInput = z.infer<typeof llmConfigBaseSchema>

// Default values - typed as partial of the config
export const LLM_CONFIG_DEFAULTS = {
  ctx_size: 1024,
  gpu_layers: 99,
  device: 'gpu',
  system_prompt: 'You are a helpful assistant.',
  image_tile_mode: 'sequential'
} as const satisfies Partial<LlmConfigInput>

// Full schema - applies defaults via transform (no duplication)
export const llmConfigSchema = llmConfigBaseSchema.transform((data) => ({
  ...LLM_CONFIG_DEFAULTS,
  ...data
}))

export type LlmConfig = z.infer<typeof llmConfigSchema>

// Base schema - validates types, all fields optional (for input validation)
export const embedConfigBaseSchema = z.object({
  gpuLayers: z
    .number()
    .int()
    .optional()
    .describe('Number of model layers to offload to the GPU. Default 99 (offload all).'),
  device: z
    .enum(['gpu', 'cpu'])
    .optional()
    .describe("Device to run inference on: `'gpu'` or `'cpu'`. Default `'gpu'`."),
  batchSize: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('Tokens processed per batch (input throughput). Default 1024.'),
  pooling: z
    .enum(['none', 'mean', 'cls', 'last', 'rank'])
    .optional()
    .describe(
      "Pooling strategy collapsing token embeddings into one sequence vector: `'none'`, `'mean'`, `'cls'`, `'last'`, or `'rank'`. Unset uses the model default."
    ),
  attention: z
    .enum(['causal', 'non-causal'])
    .optional()
    .describe("Attention type: `'causal'` or `'non-causal'`. Unset uses the model default."),
  embdNormalize: z
    .number()
    .int()
    .optional()
    .describe(
      'Embedding normalization: `-1` none, `0` max-abs int16, `1` taxicab, `2` euclidean, `>2` p-norm. Default 2 (euclidean).'
    ),
  flashAttention: z
    .enum(['on', 'off', 'auto'])
    .optional()
    .describe("Flash attention: `'on'`, `'off'`, or `'auto'`. Default `'auto'`."),
  mainGpu: z
    .union([z.number().int().min(0), z.enum(['integrated', 'dedicated'])])
    .optional()
    .describe(
      "GPU to use on multi-GPU systems: a device index, or `'integrated'`/`'dedicated'` to restrict selection to that class."
    ),
  splitMode: z
    .enum(['none', 'layer', 'row'])
    .optional()
    .describe(
      "How to split the model across GPUs: `'none'` (default, single GPU), `'layer'` (pipeline parallelism), or `'row'` (tensor parallelism)."
    ),
  tensorSplit: z
    .string()
    .optional()
    .describe(
      "Proportions for distributing layers/rows across GPUs, e.g. `'1,1'` (equal) or `'3,1'` (75/25)."
    ),
  verbosity: verbositySchema
    .optional()
    .describe('Native log verbosity: `0`=ERROR, `1`=WARN, `2`=INFO, `3`=DEBUG. Default 0.'),
  openclCacheDir: z
    .string()
    .optional()
    .describe(
      'Writable directory for the OpenCL kernel binary cache; required on Android for fast GPU startup.'
    )
})

export type EmbedConfigInput = z.infer<typeof embedConfigBaseSchema>

// Default values - typed as partial of the config
export const EMBED_CONFIG_DEFAULTS = {
  gpuLayers: 99,
  device: 'gpu',
  batchSize: 1024
} as const satisfies Partial<EmbedConfigInput>

// Full schema - validates then applies defaults via transform
export const embedConfigSchema = embedConfigBaseSchema.transform((data) => ({
  ...EMBED_CONFIG_DEFAULTS,
  ...data
}))

export type EmbedConfig = z.infer<typeof embedConfigSchema>
