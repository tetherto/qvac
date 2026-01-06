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

export const llmConfigSchema = z.object({
  ctx_size: z.number().default(1024),
  temp: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  top_k: z.number().int().min(0).max(128).optional(),
  seed: z.number().optional(),
  gpu_layers: z.number().default(99),
  lora: z.string().optional(),
  device: z.string().default("gpu"),
  predict: z
    .union([
      z.literal(-1), // special: until stop token
      z.literal(-2), // special: until context filled
      z.number().int().min(1), // positive integer: fixed token count
    ])
    .optional(),
  system_prompt: z.string().default("You are a helpful assistant."),
  no_mmap: z.boolean().optional(),
  verbosity: verbositySchema.optional(),
  presence_penalty: z.number().optional(),
  frequency_penalty: z.number().optional(),
  repeat_penalty: z.number().optional(),
  stop_sequences: z.array(z.string()).optional(),
  n_discarded: z.number().optional(),
  tools: z.boolean().optional(),
});

export const embedConfigSchema = z.object({
  // https://github.com/tetherto/qvac-lib-infer-llamacpp-embed/tree/main?tab=readme-ov-file#4-create-config
  config: z.string().default("-ngl\t99\n-dev\tgpu\n--batch_size\t1024"),
});

export type LlmConfig = z.infer<typeof llmConfigSchema>;
export type EmbedConfig = z.infer<typeof embedConfigSchema>;
