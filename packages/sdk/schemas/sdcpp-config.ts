import { z } from "zod";
import { modelSrcInputSchema } from "./model-src-utils";

const BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

const ABSOLUTE_PATH_PATTERN = /^(\/|[A-Za-z]:[\\/]|\\\\)/;

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
    lora_apply_mode: z.enum(["auto", "immediately", "at_runtime"]).optional()
      .describe(
        "How LoRA adapters passed via diffusion({ lora }) are applied. " +
        "'auto' (default): picked based on weight type — 'at_runtime' for " +
        "quantized weights, 'immediately' for full-precision. " +
        "'immediately': adapter is fused into the model on first use and " +
        "persists across subsequent diffusion() calls until the model is " +
        "unloaded. " +
        "'at_runtime': adapter is applied per-call and not persisted.",
      ),
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
  modelLoadMs: z
    .number()
    .optional()
    .describe("Time in milliseconds spent loading the diffusion model."),
  generationMs: z
    .number()
    .optional()
    .describe("Wall-clock time in milliseconds spent generating images."),
  totalGenerationMs: z
    .number()
    .optional()
    .describe(
      "Total generation time in milliseconds across all images in the batch.",
    ),
  totalWallMs: z
    .number()
    .optional()
    .describe(
      "Total wall-clock time in milliseconds including model load and sampling.",
    ),
  totalSteps: z
    .number()
    .optional()
    .describe("Total number of diffusion sampling steps executed."),
  totalGenerations: z
    .number()
    .optional()
    .describe("Total number of generation passes executed."),
  totalImages: z
    .number()
    .optional()
    .describe("Total number of images produced."),
  totalPixels: z
    .number()
    .optional()
    .describe("Total number of pixels generated across all images."),
  width: z
    .number()
    .optional()
    .describe("Width in pixels of each generated image."),
  height: z
    .number()
    .optional()
    .describe("Height in pixels of each generated image."),
  seed: z
    .number()
    .optional()
    .describe(
      "Seed that produced these outputs (randomized when not supplied by the caller).",
    ),
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
  modelId: z
    .string()
    .describe("The identifier of the diffusion model to use for generation."),
  prompt: z.string().describe("Positive prompt describing the image to generate."),
  negative_prompt: z
    .string()
    .optional()
    .describe("Optional negative prompt describing what to avoid."),
  width: z
    .number()
    .int()
    .positive()
    .multipleOf(8)
    .optional()
    .describe("Image width in pixels (must be a multiple of 8)."),
  height: z
    .number()
    .int()
    .positive()
    .multipleOf(8)
    .optional()
    .describe("Image height in pixels (must be a multiple of 8)."),
  steps: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Number of sampling steps to run."),
  cfg_scale: z
    .number()
    .optional()
    .describe(
      "Classifier-free guidance scale for SD 1.x / 2.x / XL / SD3 models; typical range 1–20, default 7",
    ),
  img_cfg_scale: z
    .number()
    .default(-1)
    .describe(
      "Image CFG scale for img2img/inpaint workflows where the image and prompt should have different guidance weights; defaults to -1 which reuses cfg_scale",
    ),
  guidance: z
    .number()
    .optional()
    .describe(
      "Distilled guidance for FLUX models; typical range 1–10, default 3.5",
    ),
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
    .optional()
    .describe("Sampling algorithm used by the diffusion scheduler."),
  scheduler: z
    .enum([
      "discrete", "karras", "exponential", "ays", "gits",
      "sgm_uniform", "simple", "lcm", "smoothstep", "kl_optimal", "bong_tangent",
    ])
    .optional()
    .describe("Noise schedule to apply when sampling."),
  seed: z
    .number()
    .int()
    .optional()
    .describe("Random seed; when omitted the SDK picks one and returns it in stats."),
  batch_count: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Number of images to generate in this call."),
  vae_tiling: z
    .boolean()
    .optional()
    .describe(
      "Enable VAE tiling for large images on constrained VRAM (overrides model config).",
    ),
  cache_preset: z
    .string()
    .optional()
    .describe("Optional name of a cached sampler preset to reuse."),
  init_image: z
    .string()
    .min(1)
    .regex(BASE64_PATTERN)
    .optional()
    .describe("Base64-encoded image for img2img generation. Mutually exclusive with init_images."),
  init_images: z.array(
    z.string().min(1).regex(BASE64_PATTERN),
  )
    .min(1)
    .optional()
    .describe(
      "FLUX.2-only multi-reference fusion: array of base64-encoded PNG/JPEG buffers. " +
      "Each buffer becomes a separate reference image that the FLUX.2 transformer attends to. " +
      "Mutually exclusive with init_image; requires the model to be loaded with " +
      "config.prediction='flux2_flow' and a Qwen3 text encoder via llmModelSrc.",
    ),
  increase_ref_index: z.boolean().optional()
    .describe(
      "FLUX.2 fusion only. When omitted, the addon default (false) is used. When false, all " +
      "reference latents share one RoPE index slot and blend via attention (recommended for " +
      "FLUX.2-klein). When true, each reference gets its own RoPE index slot — use only with " +
      "text encoders that receive per-image vision tokens.",
    ),
  auto_resize_ref_image: z.boolean().optional()
    .describe(
      "FLUX.2 only. When omitted, the addon default (true) is used. When true, every reference " +
      "image (single or fusion) is auto-resized to the target width/height before VAE-encoding. " +
      "Disable only if the buffers are already at the exact target dimensions.",
    ),
  lora: z
    .string()
    .min(1)
    .regex(ABSOLUTE_PATH_PATTERN, {
      message:
        "lora must be an absolute path",
    })
    .optional()
    .describe(
      "Optional local LoRA adapter path to apply for this generation. " +
      "Must be an absolute filesystem path. " +
      "Whether the adapter persists across subsequent diffusion() calls is controlled " +
      "by sdcppConfigSchema.lora_apply_mode (set at loadModel time).",
    ),
  strength: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe(
      "img2img denoising strength (0.0 = keep source, 1.0 = ignore source); used by the SD/SDXL SDEdit path. No-op for FLUX.2, which uses in-context conditioning and ignores this field.",
    ),
}).refine(
  (d) => d.init_image === undefined || d.init_images === undefined,
  {
    message:
      "init_image and init_images are mutually exclusive — pass one or the other, not both.",
  },
);

export type DiffusionRequest = z.input<typeof diffusionRequestSchema>;

export const diffusionStreamRequestSchema = diffusionRequestSchema.extend({
  type: z.literal("diffusionStream"),
});

export type DiffusionStreamRequest = z.input<
  typeof diffusionStreamRequestSchema
>;

type DiffusionClientParamsBase = Omit<
  DiffusionRequest,
  "init_image" | "init_images"
>;

export type DiffusionClientParams = DiffusionClientParamsBase &
  (
    | { init_image?: Uint8Array; init_images?: never }
    | { init_image?: never; init_images?: Uint8Array[] }
  );
