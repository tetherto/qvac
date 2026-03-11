import { z } from "zod";

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
  system_prompt: z.string().optional(),
  no_mmap: z.boolean().optional(),
  verbosity: verbositySchema.optional(),
  presence_penalty: z.number().optional(),
  frequency_penalty: z.number().optional(),
  repeat_penalty: z.number().optional(),
  stop_sequences: z.array(z.string()).optional(),
  n_discarded: z.number().optional(),
  tools: z.boolean().optional(),
});

export type LlmConfigInput = z.infer<typeof llmConfigBaseSchema>;

// Default values - typed as partial of the config
export const LLM_CONFIG_DEFAULTS = {
  ctx_size: 1024,
  gpu_layers: 99,
  device: "gpu",
  system_prompt: "You are a helpful assistant.",
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
  mainGpu: z.union([z.number().int().min(0), z.enum(["integrated", "dedicated"])]).optional(),
  verbosity: verbositySchema.optional(),
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
