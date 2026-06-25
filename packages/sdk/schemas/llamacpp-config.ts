import { z } from "zod";
import { modelSrcInputSchema } from "./model-src-utils";
import { TOOLS_MODE } from "./tools";

/**
 * Upper bound for `reasoning_budget`. Mirrors the llm-llamacpp addon, which
 * stores the budget as a 32-bit `int` and rejects values above
 * `std::numeric_limits<int>::max()`.
 */
export const REASONING_BUDGET_MAX = 2147483647;

export const VERBOSITY = {
  ERROR: 0,
  WARN: 1,
  INFO: 2,
  DEBUG: 3,
} as const;

const verbositySchema = z.union([
  z.literal(VERBOSITY.ERROR),
  z.literal(VERBOSITY.WARN),
  z.literal(VERBOSITY.INFO),
  z.literal(VERBOSITY.DEBUG),
]);

// Base schema - validates types, all fields optional (for client-side validation)
export const llmConfigBaseSchema = z.object({
  ctx_size: z.number().optional(),
  temp: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  top_k: z.number().int().min(0).max(128).optional(),
  seed: z.number().optional(),
  gpu_layers: z.number().optional(),
  lora: z.string().optional(),
  device: z.string().optional(),
  predict: z
    .union([
      z.literal(-1), // special: until stop token
      z.literal(-2), // special: until context filled
      z.number().int().min(1), // positive integer: fixed token count
    ])
    .optional(),
  /** JS-side only: seeds conversation history. Never forwarded to the C++ addon. */
  system_prompt: z.string().optional(),
  no_mmap: z.boolean().optional(),
  verbosity: verbositySchema.optional(),
  presence_penalty: z.number().optional(),
  frequency_penalty: z.number().optional(),
  repeat_penalty: z.number().optional(),
  stop_sequences: z.array(z.string()).optional(),
  n_discarded: z.number().optional(),
  tools: z.boolean().optional(),
  toolsMode: z
    .enum([TOOLS_MODE.static, TOOLS_MODE.dynamic])
    .describe(
      'Controls tool placement in the prompt. "static" (default) prepends the tool set once and reuses it across the session. "dynamic" anchors tools after the last user message and trims them from the kv-cache after the chain resolves so each user prompt can carry its own tools.',
    )
    .optional(),
  "cache-type-k": z.string().optional(),
  "cache-type-v": z.string().optional(),
  "main-gpu": z
    .union([z.number().int().min(0), z.enum(["integrated", "dedicated"])])
    .optional(),
  "split-mode": z.enum(["none", "layer", "row"]).optional(),
  "tensor-split": z.string().optional(),
  /**
   * Writable directory for OpenCL kernel binary cache. Required on Android
   * for fast GPU startup.
   */
  openclCacheDir: z.string().optional(),
  /**
   * Reasoning channel token budget. `-1` = unrestricted, `0` = disabled, any
   * positive integer caps the reasoning channel at that many tokens (the
   * sampler force-emits the closing think tag once the budget is exhausted).
   */
  reasoning_budget: z.number().int().min(-1).max(REASONING_BUDGET_MAX).optional(),
  projectionModelSrc: modelSrcInputSchema.optional(),
  /**
   * Qwen3.5-VL multi-tile image encoding mode (multimodal models only):
   *   - `"sequential"` (default): encode image tiles one tile at a time.
   *   - `"batched"`: encode all tiles in a single batched pass.
   *   - `"disabled"`: no multi-tile encoding (single tile).
   * Ignored by text-only models. Default is `"sequential"`.
   */
  image_tile_mode: z.enum(["disabled", "batched", "sequential"]).optional(),
});

export type LlmConfigInput = z.infer<typeof llmConfigBaseSchema>;

// Default values - typed as partial of the config
export const LLM_CONFIG_DEFAULTS = {
  ctx_size: 1024,
  gpu_layers: 99,
  device: "gpu",
  system_prompt: "You are a helpful assistant.",
  image_tile_mode: "sequential",
} as const satisfies Partial<LlmConfigInput>;

// Full schema - applies defaults via transform (no duplication)
export const llmConfigSchema = llmConfigBaseSchema.transform((data) => ({
  ...LLM_CONFIG_DEFAULTS,
  ...data,
}));

export type LlmConfig = z.infer<typeof llmConfigSchema>;

// Base schema - validates types, all fields optional (for client-side validation)
export const embedConfigBaseSchema = z.object({
  gpuLayers: z.number().int().optional(),
  device: z.enum(["gpu", "cpu"]).optional(),
  batchSize: z.number().int().min(1).optional(),
  pooling: z.enum(["none", "mean", "cls", "last", "rank"]).optional(),
  attention: z.enum(["causal", "non-causal"]).optional(),
  embdNormalize: z.number().int().optional(),
  flashAttention: z.enum(["on", "off", "auto"]).optional(),
  mainGpu: z
    .union([z.number().int().min(0), z.enum(["integrated", "dedicated"])])
    .optional(),
  splitMode: z.enum(["none", "layer", "row"]).optional(),
  tensorSplit: z.string().optional(),
  verbosity: verbositySchema.optional(),
  /**
   * Writable directory for OpenCL kernel binary cache. Required on Android
   * for fast GPU startup.
   */
  openclCacheDir: z.string().optional(),
});

export type EmbedConfigInput = z.infer<typeof embedConfigBaseSchema>;

// Default values - typed as partial of the config
export const EMBED_CONFIG_DEFAULTS = {
  gpuLayers: 99,
  device: "gpu",
  batchSize: 1024,
} as const satisfies Partial<EmbedConfigInput>;

// Full schema - validates then applies defaults via transform
export const embedConfigSchema = embedConfigBaseSchema.transform((data) => ({
  ...EMBED_CONFIG_DEFAULTS,
  ...data,
}));

export type EmbedConfig = z.infer<typeof embedConfigSchema>;
