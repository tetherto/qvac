import { z } from "zod";
import { modelSrcInputSchema } from "./model-src-utils";

export const sdcppConfigSchema = z
  .object({
    threads: z.number().optional(),
    device: z.enum(["gpu", "cpu"]).optional(),
    prediction: z
      .enum(["auto", "eps", "v", "edm_v", "flow", "flux_flow", "flux2_flow"])
      .optional(),
    wtype: z
      .enum(["default", "f32", "f16", "q4_0", "q4_1", "q5_0", "q5_1", "q8_0"])
      .optional(),
    rng: z.enum(["cuda", "cpu"]).optional(),
    schedule: z
      .enum(["default", "discrete", "karras", "exponential", "ays", "gits"])
      .optional(),
    clip_on_cpu: z.boolean().optional(),
    vae_on_cpu: z.boolean().optional(),
    vae_tiling: z.boolean().optional(),
    flash_attn: z.boolean().optional(),
    verbosity: z.number().optional(),
    clipLModelSrc: modelSrcInputSchema.optional(),
    clipGModelSrc: modelSrcInputSchema.optional(),
    t5XxlModelSrc: modelSrcInputSchema.optional(),
    llmModelSrc: modelSrcInputSchema.optional(),
    vaeModelSrc: modelSrcInputSchema.optional(),
  });

export type SdcppConfig = z.infer<typeof sdcppConfigSchema>;

export const diffusionStatsSchema = z.object({
  generation_time: z.number().optional(),
});

export type DiffusionStats = z.infer<typeof diffusionStatsSchema>;

export const generateImageStreamResponseSchema = z.object({
  type: z.literal("generateImageStream"),
  step: z.number().optional(),
  totalSteps: z.number().optional(),
  elapsedMs: z.number().optional(),
  image: z.string().optional(),
  imageIndex: z.number().optional(),
  done: z.boolean().optional(),
  stats: diffusionStatsSchema.optional(),
});

export type GenerateImageStreamResponse = z.infer<
  typeof generateImageStreamResponseSchema
>;

export const generateImageRequestSchema = z.object({
  modelId: z.string(),
  prompt: z.string(),
  negative_prompt: z.string().optional(),
  width: z.number().int().multipleOf(8).optional(),
  height: z.number().int().multipleOf(8).optional(),
  steps: z.number().int().positive().optional(),
  cfg_scale: z.number().optional(),
  guidance: z.number().optional(),
  sampling_method: z
    .enum([
      "euler_a",
      "euler",
      "heun",
      "dpm2",
      "dpm++_2m",
      "dpm++_2m_v2",
      "dpm++_2s_a",
      "lcm",
    ])
    .optional(),
  scheduler: z
    .enum(["default", "discrete", "karras", "exponential", "ays", "gits"])
    .optional(),
  seed: z.number().int().optional(),
  batch_count: z.number().int().positive().optional(),
  vae_tiling: z.boolean().optional(),
  cache_preset: z.string().optional(),
});

export type GenerateImageRequest = z.infer<typeof generateImageRequestSchema>;

export const img2imgRequestSchema = generateImageRequestSchema.extend({
  init_image: z.string(),
  strength: z.number().min(0).max(1).optional(),
});

export type Img2imgRequest = z.infer<typeof img2imgRequestSchema>;
