import { z } from "zod";
import { modelSrcInputSchema } from "./model-src-utils";

export const sdcppConfigSchema = z
  .object({
    threads: z.number().optional(),
    device: z.enum(["gpu", "cpu"]).optional(),
    prediction: z
      .enum(["auto", "eps", "v", "edm_v", "flow", "flux_flow", "flux2_flow"])
      .optional()
      .describe("Prediction type; auto-detected from model when omitted"),
    type: z
      .enum([
        "auto", "f32", "f16", "bf16",
        "q2_k", "q3_k", "q4_0", "q4_1", "q4_k",
        "q5_0", "q5_1", "q5_k", "q6_k", "q8_0",
      ])
      .optional()
      .describe("Weight quantization type override; auto-detected when omitted"),
    rng: z.enum(["cpu", "cuda", "std_default"]).optional(),
    sampler_rng: z.enum(["cpu", "cuda", "std_default"]).optional(),
    clip_on_cpu: z.boolean().optional().describe("Force CLIP text encoder to run on CPU"),
    vae_on_cpu: z.boolean().optional().describe("Force VAE decoder to run on CPU"),
    vae_tiling: z.boolean().optional().describe("Enable VAE tiling for large images on limited VRAM"),
    flash_attn: z.boolean().optional().describe("Enable flash attention to reduce memory usage"),
    verbosity: z.number().optional(),
    clipLModelSrc: modelSrcInputSchema.optional()
      .describe("CLIP-L text encoder model — required for SD3"),
    clipGModelSrc: modelSrcInputSchema.optional()
      .describe("CLIP-G text encoder model — required for SDXL and SD3"),
    t5XxlModelSrc: modelSrcInputSchema.optional()
      .describe("T5-XXL text encoder model — required for SD3"),
    llmModelSrc: modelSrcInputSchema.optional()
      .describe("LLM text encoder model (e.g. Qwen3) — required for FLUX.2 [klein]"),
    vaeModelSrc: modelSrcInputSchema.optional()
      .describe("VAE decoder model — required for FLUX.2 [klein], optional for SDXL"),
  });

export type SdcppConfig = z.infer<typeof sdcppConfigSchema>;

export const diffusionStatsSchema = z.object({
  modelLoadMs: z.number().optional(),
  generationMs: z.number().optional(),
  totalGenerationMs: z.number().optional(),
  totalWallMs: z.number().optional(),
  totalSteps: z.number().optional(),
  totalGenerations: z.number().optional(),
  totalImages: z.number().optional(),
  totalPixels: z.number().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  seed: z.number().optional(),
});

export type DiffusionStats = z.infer<typeof diffusionStatsSchema>;

export const diffusionStreamResponseSchema = z.object({
  type: z.literal("diffusionStream"),
  step: z.number().optional(),
  totalSteps: z.number().optional(),
  elapsedMs: z.number().optional(),
  data: z.string().optional(),
  outputIndex: z.number().optional(),
  done: z.boolean().optional(),
  stats: diffusionStatsSchema.optional(),
});

export type DiffusionStreamResponse = z.infer<
  typeof diffusionStreamResponseSchema
>;

export const diffusionRequestSchema = z.object({
  modelId: z.string(),
  prompt: z.string(),
  negative_prompt: z.string().optional(),
  width: z.number().int().positive().multipleOf(8).optional(),
  height: z.number().int().positive().multipleOf(8).optional(),
  steps: z.number().int().positive().optional(),
  cfg_scale: z.number().optional()
    .describe("Classifier-free guidance scale for SD 1.x / 2.x / XL / SD3 models; typical range 1–20, default 7"),
  guidance: z.number().optional()
    .describe("Distilled guidance for FLUX models; typical range 1–10, default 3.5"),
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
    .enum([
      "discrete", "karras", "exponential", "ays", "gits",
      "sgm_uniform", "simple", "lcm", "smoothstep", "kl_optimal", "bong_tangent",
    ])
    .optional(),
  seed: z.number().int().optional(),
  batch_count: z.number().int().positive().optional(),
  vae_tiling: z.boolean().optional(),
  cache_preset: z.string().optional(),

});

export type DiffusionRequest = z.infer<typeof diffusionRequestSchema>;

export const diffusionStreamRequestSchema = diffusionRequestSchema.extend({
  type: z.literal("diffusionStream"),
});

export type DiffusionStreamRequest = z.infer<
  typeof diffusionStreamRequestSchema
>;

export type DiffusionClientParams = DiffusionRequest;
