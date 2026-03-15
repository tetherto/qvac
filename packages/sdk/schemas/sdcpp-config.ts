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
  totalTime: z.number().optional(),
  stepsPerSecond: z.number().optional(),
  msPerStep: z.number().optional(),
  megapixelsPerSecond: z.number().optional(),
  totalSteps: z.number().optional(),
  totalGenerations: z.number().optional(),
  totalImages: z.number().optional(),
  totalPixels: z.number().optional(),
  modelLoadMs: z.number().optional(),
  generationMs: z.number().optional(),
  totalGenerationMs: z.number().optional(),
  totalWallMs: z.number().optional(),
  steps: z.number().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  seed: z.number().optional(),
  output_count: z.number().optional(),
});

export type DiffusionStats = z.infer<typeof diffusionStatsSchema>;

export const generationStreamResponseSchema = z.object({
  type: z.literal("generationStream"),
  step: z.number().optional(),
  totalSteps: z.number().optional(),
  elapsedMs: z.number().optional(),
  data: z.string().optional(),
  outputIndex: z.number().optional(),
  done: z.boolean().optional(),
  stats: diffusionStatsSchema.optional(),
});

export type GenerationStreamResponse = z.infer<
  typeof generationStreamResponseSchema
>;

export const generationRequestSchema = z.object({
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
      "euler",
      "euler_a",
      "heun",
      "dpm2",
      "dpm++2m",
      "dpm++2mv2",
      "dpm++2s_a",
      "lcm",
      "ipndm",
      "ipndm_v",
      "ddim_trailing",
      "tcd",
      "res_multistep",
      "res_2s",
    ])
    .optional(),
  scheduler: z
    .enum(["default", "discrete", "karras", "exponential", "ays", "gits"])
    .optional(),
  seed: z.number().int().optional(),
  batch_count: z.number().int().positive().optional(),
  vae_tiling: z.boolean().optional(),
  cache_preset: z.string().optional(),
  init_image: z.string().optional(),
  /** img2img denoising strength (0–1). Only valid when init_image is provided. */
  strength: z.number().min(0).max(1).optional(),
});

export type GenerationRequest = z.infer<typeof generationRequestSchema>;

// RPC request schema (wire format with `type` literal for routing)
export const generationStreamRequestSchema = generationRequestSchema.extend({
  type: z.literal("generationStream"),
});

export type GenerationStreamRequest = z.infer<
  typeof generationStreamRequestSchema
>;

// Client params (no `type` field — added by the client wrapper)
export type GenerationClientParams = {
  modelId: string;
  prompt: string;
  negative_prompt?: string;
  width?: number;
  height?: number;
  steps?: number;
  cfg_scale?: number;
  guidance?: number;
  sampling_method?: GenerationRequest["sampling_method"];
  scheduler?: GenerationRequest["scheduler"];
  seed?: number;
  batch_count?: number;
  vae_tiling?: boolean;
  cache_preset?: string;
  init_image?: string | Buffer;
  strength?: number;
  stream?: boolean;
};
