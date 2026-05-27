import { z } from "zod";
import { modelSrcInputSchema } from "./model-src-utils";

const BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

const ABSOLUTE_PATH_PATTERN = /^(\/|[A-Za-z]:[\\/]|\\\\)/;

const base64StringSchema = z.string().min(1).regex(BASE64_PATTERN);

const samplingMethodSchema = z.enum([
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
]);

const scheduleTypeSchema = z.enum([
  "discrete", "karras", "exponential", "ays", "gits",
  "sgm_uniform", "simple", "lcm", "smoothstep", "kl_optimal", "bong_tangent",
]);

const cacheModeSchema = z.enum([
  "disabled",
  "easycache",
  "ucache",
  "dbcache",
  "taylorseer",
  "cache-dit",
]);

export const sdcppConfigSchema = z
  .object({
    mode: z.enum(["diffusion", "upscale", "video"]).default("diffusion")
      .describe(
        "Operation mode for the diffusion plugin. " +
        "`'diffusion'` (default) builds a full SD / SDXL / SD3 / FLUX pipeline from " +
        "the primary model plus optional auxiliary text encoders, VAE, and ESRGAN " +
        "upscaler, and exposes diffusion({ ... }). " +
        "`'upscale'` builds a standalone ESRGAN upscaler from the primary model " +
        "file alone (auxiliary model sources are ignored) and exposes upscale({ ... }). " +
        "`'video'` builds a Wan `VideoStableDiffusion` pipeline and exposes video({ ... }). " +
        "On React Native, loading the video model on-device will likely fail " +
        "because the video diffusion models currently " +
        "shipped by the SDK are too large to load on typical mobile devices; " +
        "pass a `delegate` to `loadModel(...)` to run generation on a desktop peer instead.",
      ),
    threads: z.number().optional(),
    device: z.enum(["gpu", "cpu"]).optional(),
    prediction: z
      .enum(["auto", "eps", "v", "edm_v", "flow", "flux2_flow"])
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
    offload_to_cpu: z.boolean().optional()
      .describe("Keep model weights in CPU memory and offload them during GPU compute"),
    flash_attn: z.boolean().optional().describe("Enable flash attention to reduce memory usage"),
    diffusion_fa: z.boolean().optional().describe("Enable flash attention for the diffusion transformer only"),
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
    highNoiseDiffusionModelSrc: modelSrcInputSchema.optional()
      .describe("High-noise diffusion expert — required for Wan 2.2 mixture-of-experts video models"),
    upscaler: z.object({
      type: z.literal("esrgan").optional()
        .describe("Type of upscaler to use for post-generation upscaling when requested in diffusion({ upscale })."),
      model_src: modelSrcInputSchema.optional()
        .describe(
          "ESRGAN upscaler model (e.g. RealESRGAN_x4plus_anime_6B.pth). " +
          "Required in diffusion mode when this `upscaler` block is set — " +
          "configures the post-generation upscaler invoked via diffusion({ upscale }). " +
          "In `mode: 'upscale'` the primary modelSrc itself is the ESRGAN model, " +
          "so this field is ignored.",
        ),
      tile_size: z.number().int().positive().optional()
        .describe(
          "ESRGAN upscaler tile size in pixels. Smaller tiles use less VRAM " +
          "at the cost of more passes.",
        ),
      direct: z.boolean().optional()
        .describe(
          "Use direct convolution in the ESRGAN upscaler instead of im2col + " +
          "GEMM. Faster on some backends, slower on others.",
        ),
      offload_params_to_cpu: z.boolean().optional()
        .describe(
          "Keep ESRGAN upscaler weights on CPU and offload them during compute. " +
          "Trades latency for VRAM headroom on memory-constrained GPUs.",
        ),
      threads: z.union([
        z.literal(-1),
        z.number().int().positive(),
      ])
        .optional()
        .describe(
          "Number of CPU threads dedicated to the ESRGAN upscaler. -1 = auto.",
        ),
    }).strict().optional()
      .describe(
        "ESRGAN upscaler configuration. In diffusion mode this enables the " +
        "post-generation upscale path invoked via diffusion({ upscale }) and " +
        "requires `model_src`. In `mode: 'upscale'` only the tuning fields " +
        "(tile_size, direct, offload_params_to_cpu, threads) are honored — " +
        "the primary modelSrc IS the ESRGAN model in that mode and " +
        "`model_src` here is ignored. In `mode: 'video'` the entire `upscaler` " +
        "object is ignored. Mode-dependent constraints (e.g. `model_src` " +
        "required in diffusion mode) are enforced by the sdcpp-generation " +
        "plugin at load time, not at the schema layer.",
      ),
  });

export type SdcppConfig = z.input<typeof sdcppConfigSchema>;

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

export const videoStatsSchema = diffusionStatsSchema.pick({
  modelLoadMs: true,
  generationMs: true,
  totalGenerationMs: true,
  totalWallMs: true,
  totalSteps: true,
  totalGenerations: true,
  totalImages: true,
  totalPixels: true,
  width: true,
  height: true,
  seed: true,
}).extend({
  totalVideos: z
    .number()
    .optional()
    .describe("Total number of videos produced."),
  totalVideoFrames: z
    .number()
    .optional()
    .describe("Total number of video frames produced."),
  videoFrames: z
    .number()
    .optional()
    .describe("Frame count of the most recent generated video."),
  fps: z
    .number()
    .optional()
    .describe("Frames-per-second metadata for the most recent generated video."),
});

export type VideoStats = z.infer<typeof videoStatsSchema>;

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

export const videoStreamResponseSchema = z.object({
  type: z.literal("videoStream"),
  step: z.number().optional(),
  totalSteps: z.number().optional(),
  elapsedMs: z.number().optional(),
  data: z.string().optional(),
  outputIndex: z.number().optional(),
  done: z.boolean().optional(),
  stats: videoStatsSchema.optional(),
});

export type VideoStreamResponse = z.infer<typeof videoStreamResponseSchema>;

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
  sampling_method: samplingMethodSchema
    .optional()
    .describe("Sampling algorithm used by the diffusion scheduler."),
  scheduler: scheduleTypeSchema
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
  init_image: base64StringSchema
    .optional()
    .describe("Base64-encoded image for img2img generation. Mutually exclusive with init_images."),
  init_images: z.array(
    base64StringSchema,
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
  upscale: z
    .union([
      z.boolean(),
      z.object({
        repeats: z.number().int().positive().optional(),
      }).strict(),
    ])
    .optional()
    .describe(
      "Post-generation ESRGAN upscale. " +
      "`true` (or `{}` / `{ repeats: 1 }`) runs a single upscale pass at the " +
      "model's native scale factor (e.g. x4 for RealESRGAN_x4plus). " +
      "`false` is a no-op (same as omitting the field). " +
      "`{ repeats: N }` runs the upscaler N times sequentially — each pass " +
      "multiplies the output dimensions by the model's scale factor. When " +
      "`batch_count > 1`, every output image is upscaled independently. " +
      "Requires the model to be loaded with `upscaler.model_src` set in modelConfig.",
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

export const videoRequestSchema = z.object({
  modelId: z
    .string()
    .describe(
      "The identifier of the loaded video model to use for generation. " +
        "On React Native, prefer a `modelId` loaded with a `delegate` because " +
        "the video diffusion models currently shipped by the SDK are too " +
        "large to load on typical mobile devices.",
    ),
  requestId: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Stable identifier for this in-flight video generation. Optional on the wire — the server falls back to a server-generated id when the field is missing.",
    ),
  mode: z
    .enum(["txt2vid"])
    .describe("Video generation mode. Only `txt2vid` is supported today."),
  prompt: z.string().describe("Positive prompt describing the video to generate."),
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
    .describe("Video width in pixels (must be a multiple of 8)."),
  height: z
    .number()
    .int()
    .positive()
    .multipleOf(8)
    .optional()
    .describe("Video height in pixels (must be a multiple of 8)."),
  video_frames: z
    .number()
    .int()
    .refine((value) => value >= 5 && (value - 1) % 4 === 0, {
      message: "video_frames must be an integer >= 5 of the form (4*k + 1)",
    })
    .optional()
    .describe("Frame count for the generated video; must satisfy (4*k + 1), where k>=1."),
  fps: z
    .number()
    .positive()
    .max(120)
    .optional()
    .describe("AVI framerate metadata in frames per second; must be in (0, 120]."),
  seed: z
    .number()
    .int()
    .optional()
    .describe("Random seed; when omitted the SDK picks one and returns it in stats."),
  steps: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Low-noise or single-expert denoising step count."),
  sampling_method: samplingMethodSchema
    .optional()
    .describe("Sampling algorithm used by the low-noise diffusion scheduler."),
  scheduler: scheduleTypeSchema
    .optional()
    .describe("Noise schedule to apply for the low-noise diffusion path."),
  cfg_scale: z
    .number()
    .optional()
    .describe("Classifier-free guidance scale."),
  flow_shift: z
    .number()
    .optional()
    .describe("Per-request flow-matching guidance shift override."),
  high_noise_steps: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Wan 2.2 high-noise expert step count."),
  high_noise_sampler: samplingMethodSchema
    .optional()
    .describe("Wan 2.2 high-noise expert sampler."),
  high_noise_scheduler: scheduleTypeSchema
    .optional()
    .describe("Wan 2.2 high-noise expert scheduler."),
  high_noise_cfg_scale: z
    .number()
    .optional()
    .describe("Wan 2.2 high-noise expert CFG scale."),
  high_noise_flow_shift: z
    .number()
    .optional()
    .describe("Wan 2.2 high-noise expert flow shift override."),
  moe_boundary: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe("Wan 2.2 mixture-of-experts boundary in [0, 1]."),
  vace_strength: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe("Control-frame guidance strength."),
  control_frames: z.array(base64StringSchema)
    .min(1)
    .optional()
    .describe("Optional array of base64-encoded control-frame images."),
  vae_tiling: z
    .boolean()
    .optional()
    .describe("Enable VAE tiling for large videos on constrained VRAM."),
  vae_tile_size: z
    .union([z.number().positive(), z.string().min(1)])
    .optional()
    .describe("VAE tile size override."),
  vae_tile_overlap: z
    .number()
    .optional()
    .describe("VAE tile overlap override."),
  cache_mode: cacheModeSchema
    .optional()
    .describe("Step-caching algorithm."),
  cache_preset: z
    .string()
    .optional()
    .describe("Optional name of a cached sampler preset to reuse."),
  cache_threshold: z
    .number()
    .optional()
    .describe("Direct cache reuse threshold override."),
});

export type VideoRequest = z.input<typeof videoRequestSchema>;

export const videoStreamRequestSchema = videoRequestSchema.extend({
  type: z.literal("videoStream"),
});

export type VideoStreamRequest = z.input<typeof videoStreamRequestSchema>;

type VideoClientParamsBase = Omit<
  VideoRequest,
  "requestId" | "control_frames"
>;

export type VideoClientParams = VideoClientParamsBase & {
  control_frames?: Uint8Array[];
};

// ============================================
// Standalone ESRGAN upscale (mode: "upscale")
// ============================================

export const upscaleStatsSchema = z.object({
  modelLoadMs: z
    .number()
    .optional()
    .describe("Wall-clock time in milliseconds spent loading the upscaler model."),
  upscaleMs: z
    .number()
    .optional()
    .describe("Wall-clock time in milliseconds for the most recent upscale job."),
  totalUpscaleMs: z
    .number()
    .optional()
    .describe("Cumulative upscale time in milliseconds across all jobs."),
  totalWallMs: z
    .number()
    .optional()
    .describe(
      "Total wall-clock time in milliseconds including model load and upscaling.",
    ),
  totalUpscales: z
    .number()
    .optional()
    .describe("Cumulative number of upscale calls."),
  totalImages: z
    .number()
    .optional()
    .describe("Cumulative number of images produced."),
  totalPixels: z
    .number()
    .optional()
    .describe("Cumulative number of pixels produced across all images."),
  width: z.number().optional().describe("Width of the most recent emitted PNG."),
  height: z.number().optional().describe("Height of the most recent emitted PNG."),
  repeats: z
    .number()
    .optional()
    .describe("Number of ESRGAN passes used by the most recent upscale job."),
  backendDevice: z
    .enum(["cpu", "gpu"])
    .optional()
    .describe(
      "Actual compute device used by the ESRGAN upscaler. " +
      "Reflects the backend stable-diffusion.cpp selected (e.g. Android `gpu` " +
      "falls back to `cpu` because the mobile GPU/OpenCL path is unstable).",
    ),
});

export type UpscaleStats = z.infer<typeof upscaleStatsSchema>;

export const upscaleRequestSchema = z.object({
  modelId: z
    .string()
    .describe(
      "Identifier of the loaded upscaler model. The model must have been loaded " +
      "with `modelType: 'diffusion'` and `modelConfig.mode: 'upscale'`.",
    ),
  image: z
    .string()
    .min(1)
    .regex(BASE64_PATTERN)
    .describe("Base64-encoded PNG/JPEG bytes of the source image."),
  repeats: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Number of ESRGAN passes to run sequentially. Each pass multiplies " +
      "dimensions by the model's native scale factor; only the final image " +
      "is emitted (`outputs.length === 1`). Defaults to 1.",
    ),
});

export type UpscaleRequest = z.input<typeof upscaleRequestSchema>;

export const upscaleStreamRequestSchema = upscaleRequestSchema.extend({
  type: z.literal("upscaleStream"),
});

export type UpscaleStreamRequest = z.input<typeof upscaleStreamRequestSchema>;

export const upscaleStreamResponseSchema = z.object({
  type: z.literal("upscaleStream"),
  data: z.string().optional(),
  outputIndex: z.number().optional(),
  done: z.boolean().optional(),
  stats: upscaleStatsSchema.optional(),
});

export type UpscaleStreamResponse = z.infer<typeof upscaleStreamResponseSchema>;

export type UpscaleClientParams = Omit<UpscaleRequest, "image"> & {
  image: Uint8Array;
};
