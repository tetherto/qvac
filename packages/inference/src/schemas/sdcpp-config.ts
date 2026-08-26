import { z } from 'zod'
import { modelSrcInputSchema } from '@/schemas/model-src-utils'

const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

const ABSOLUTE_PATH_PATTERN = /^(\/|[A-Za-z]:[\\/]|\\\\)/

const base64StringSchema = z.string().min(1).regex(BASE64_PATTERN)

const samplingMethodSchema = z.enum([
  'euler',
  'euler_a',
  'heun',
  'dpm2',
  'dpm++2m',
  'dpm++2mv2',
  'dpm++2s_a',
  'lcm',
  'ipndm',
  'ipndm_v',
  'ddim_trailing',
  'tcd',
  'res_multistep',
  'res_2s'
])

const scheduleTypeSchema = z.enum([
  'discrete',
  'karras',
  'exponential',
  'ays',
  'gits',
  'sgm_uniform',
  'simple',
  'lcm',
  'smoothstep',
  'kl_optimal',
  'bong_tangent'
])

const videoScheduleTypeSchema = z.enum([...scheduleTypeSchema.options, 'ltx2'])

const cacheModeSchema = z.enum([
  'disabled',
  'easycache',
  'ucache',
  'dbcache',
  'taylorseer',
  'cache-dit'
])

export const sdcppConfigSchema = z.object({
  mode: z
    .enum(['diffusion', 'upscale', 'video', 'world'])
    .default('diffusion')
    .describe(
      'Operation mode for the diffusion plugin. ' +
        "`'diffusion'` (default) builds a full SD / SDXL / SD3 / FLUX pipeline from " +
        'the primary model plus optional auxiliary text encoders, VAE, unconditional ' +
        'diffusion model, and ESRGAN ' +
        'upscaler, and exposes diffusion({ ... }). ' +
        "`'upscale'` builds a standalone ESRGAN upscaler from the primary model " +
        'file alone (auxiliary model sources are ignored) and exposes upscale({ ... }). ' +
        "`'video'` builds a `VideoStableDiffusion` pipeline and exposes video({ ... }). " +
        'The video layout is selected from the auxiliary sources: supplying ' +
        '`embeddingsConnectorsModelSrc` loads the LTX-2 layout (Gemma text encoder ' +
        'via `llmModelSrc` + video VAE + connectors, optional `audioVaeModelSrc` for ' +
        'synchronized audio); otherwise the Wan layout is used (UMT5 text encoder ' +
        'via `t5XxlModelSrc` + VAE). ' +
        'On React Native, loading the video model on-device will likely fail ' +
        'because the video diffusion models currently ' +
        'shipped by QVAC are too large to load on typical mobile devices. ' +
        "`'world'` builds an ABot-World interactive world session and exposes " +
        'worldCreateScene({ ... }) and worldStep({ ... }). It requires ' +
        '`taehvModelSrc`, plus `t5XxlModelSrc` + `vaeModelSrc` to create scenes ' +
        'and/or `sceneSrc` to walk a pre-built one. World sessions run only on ' +
        'the machine hosting the worker and need a dedicated GPU with at least ' +
        '20 GB free VRAM.'
    ),
  threads: z.number().optional(),
  device: z.enum(['gpu', 'cpu']).optional(),
  'main-gpu': z
    .union([z.number().int().min(0), z.enum(['integrated', 'dedicated'])])
    .optional()
    .describe(
      'GPU to pin when `device` is "gpu": a GPU-device index, "integrated", or ' +
        '"dedicated" (the discrete GPU with the most VRAM). Omit to let the ' +
        'backend choose the first enumerated device. Resolved against the ' +
        "addon's own ggml device enumeration, so it cannot desync from the " +
        'device list the backend actually uses. If an explicit request cannot ' +
        'be satisfied (e.g. "integrated" with no integrated GPU, "dedicated" ' +
        'with no discrete GPU, or an out-of-range index) the addon falls back ' +
        'to CPU rather than substituting a different GPU. Stripped on mobile ' +
        '(single-GPU devices).'
    ),
  prediction: z
    .enum(['auto', 'eps', 'v', 'edm_v', 'flow', 'flux2_flow'])
    .optional()
    .describe('Prediction type; auto-detected from model when omitted'),
  type: z
    .enum([
      'auto',
      'f32',
      'f16',
      'bf16',
      'q2_k',
      'q3_k',
      'q4_0',
      'q4_1',
      'q4_k',
      'q5_0',
      'q5_1',
      'q5_k',
      'q6_k',
      'q8_0'
    ])
    .optional()
    .describe('Weight quantization type override; auto-detected when omitted'),
  rng: z.enum(['cpu', 'cuda', 'std_default']).optional(),
  sampler_rng: z.enum(['cpu', 'cuda', 'std_default']).optional(),
  clip_on_cpu: z.boolean().optional().describe('Force CLIP text encoder to run on CPU'),
  vae_on_cpu: z.boolean().optional().describe('Force VAE decoder to run on CPU'),
  vae_auto_cpu_fallback: z
    .boolean()
    .optional()
    .describe('Automatically move the VAE to CPU when GPU memory is insufficient'),
  vae_auto_cpu_fallback_memory_ratio: z
    .number()
    .gt(0)
    .max(1)
    .optional()
    .describe('GPU-memory threshold for automatic VAE CPU fallback as a ratio in (0, 1]'),
  vae_tiling: z.boolean().optional().describe('Enable VAE tiling for large images on limited VRAM'),
  offload_to_cpu: z
    .boolean()
    .optional()
    .describe('Keep model weights in CPU memory and offload them during GPU compute'),
  flash_attn: z.boolean().optional().describe('Enable flash attention to reduce memory usage'),
  diffusion_fa: z
    .boolean()
    .optional()
    .describe('Enable flash attention for the diffusion transformer only'),
  lora_apply_mode: z
    .enum(['auto', 'immediately', 'at_runtime'])
    .optional()
    .describe(
      'How LoRA adapters passed via diffusion({ lora }) or video({ lora }) are applied. ' +
        "'auto' (default): picked based on weight type — 'at_runtime' for " +
        "quantized weights, 'immediately' for full-precision. " +
        "'immediately': adapter is fused into the model on first use and " +
        'persists across subsequent generation calls until the model is ' +
        'unloaded. ' +
        "'at_runtime': adapter is applied per-call and not persisted; use this mode " +
        'for the LTX Ingredients workflow.'
    ),
  verbosity: z.number().optional(),
  clipLModelSrc: modelSrcInputSchema
    .optional()
    .describe('CLIP-L text encoder model — required for SD3'),
  clipGModelSrc: modelSrcInputSchema
    .optional()
    .describe('CLIP-G text encoder model — required for SDXL and SD3'),
  t5XxlModelSrc: modelSrcInputSchema
    .optional()
    .describe('T5-XXL text encoder model — required for SD3'),
  llmModelSrc: modelSrcInputSchema
    .optional()
    .describe(
      'LLM text encoder model — required for FLUX.2 [klein] (Qwen3), ' +
        'Ideogram 4 (Qwen3-VL), and LTX-2 video (Gemma).'
    ),
  vaeModelSrc: modelSrcInputSchema
    .optional()
    .describe(
      'VAE decoder model — required for FLUX.2 [klein], Ideogram 4, and ' +
        'LTX-2 video (video VAE); optional for SDXL.'
    ),
  highNoiseDiffusionModelSrc: modelSrcInputSchema
    .optional()
    .describe(
      'High-noise diffusion expert — required for Wan 2.2 A14B ' +
        'mixture-of-experts video models, and the only thing that enables the ' +
        'high_noise_* / moe_boundary request fields. Omit for single-expert ' +
        'models such as Wan 2.1 and Wan 2.2 TI2V-5B.'
    ),
  uncondModelSrc: modelSrcInputSchema
    .optional()
    .describe(
      'Unconditional diffusion model — Ideogram 4 only. Requires diffusion mode, ' +
        'llmModelSrc (Qwen3-VL), vaeModelSrc, and a JSON-serialized structured ' +
        'caption with explicit bounding boxes as the generation prompt. Plain-text ' +
        "prompts produce degenerate output or the model's placeholder response."
    ),
  clipVisionModelSrc: modelSrcInputSchema
    .optional()
    .describe(
      'OpenCLIP ViT-H/14 weights (`clip_vision_h.safetensors`). Required for ' +
        'Wan image-to-video (`img2vid`); omit for text-to-video-only pipelines. ' +
        'Not used by LTX-2 (its img2vid path needs no CLIP-vision projection).'
    ),
  audioVaeModelSrc: modelSrcInputSchema
    .optional()
    .describe(
      'Audio VAE decoder model — LTX-2 video only. Enables the synchronized ' +
        '48 kHz audio track muxed into the output AVI; omit for silent video. ' +
        'Ignored by the Wan layout.'
    ),
  embeddingsConnectorsModelSrc: modelSrcInputSchema
    .optional()
    .describe(
      'Text-embedding connector weights — required for LTX-2 video. Its ' +
        'presence selects the LTX-2 video layout (Gemma text encoder via ' +
        '`llmModelSrc` + video VAE via `vaeModelSrc` + these connectors) instead ' +
        'of the Wan layout.'
    ),
  taehvModelSrc: modelSrcInputSchema
    .optional()
    .describe(
      'taew2_2 streaming pixel decoder (`taew2_2_f16.gguf`) — required for ' +
        "mode: 'world'. Decodes each generated block's latents to RGB frames. " +
        'Rejected in every other mode.'
    ),
  sceneSrc: modelSrcInputSchema
    .optional()
    .describe(
      "Pre-built ABot-World scene pack (`.safetensors`) — mode: 'world' only. " +
        'Supplying it loads the walk session eagerly at loadModel time, so a ' +
        'bad pack fails fast. Omit it to start with no world and build one with ' +
        'worldCreateScene({ ... }), in which case the session activates on the ' +
        'first worldStep. Scene packs are produced by worldCreateScene and are ' +
        'specific to the resolution they were created at.'
    ),
  world: z
    .object({
      seed: z.number().int().optional().describe('Walk RNG seed.'),
      // Mirrors parseAutoOrPositiveInt in the addon's WorldSessionHandlers.cpp:
      // -1 or > 0. Zero and other negatives throw natively at load, after the
      // multi-gigabyte artifacts have already been resolved.
      threads: z
        .union([z.literal(-1), z.number().int().positive()])
        .optional()
        .describe('CPU threads for the session. -1 = auto-detect (default).'),
      backend: z
        .string()
        .min(1)
        .optional()
        .describe(
          'Per-module backend override, e.g. "diffusion=cuda0,vae=cuda1" to keep ' +
            'scene creation off the walk GPU on a multi-GPU host.'
        ),
      // Both are parseIntInRange(..., 0, 1 << 10) natively.
      numFramePerBlock: z
        .number()
        .int()
        .min(0)
        .max(64)
        .optional()
        .describe(
          'Latent frames denoised per step. 0 = model default (3), and 64 is the ' +
            'ceiling. The native parser accepts up to 1024, but that is a range ' +
            'check rather than a memory budget: a block delivers roughly 4x this ' +
            'many decoded frames, so 1024 is ~4096 frames and several GB of raw ' +
            'pixels at 832x480 before any of it is encoded. 64 is ~20x the default ' +
            'and bounds a block at a few hundred MB.'
        ),
      localAttnSize: z
        .number()
        .int()
        .min(0)
        .max(1024)
        .optional()
        .describe(
          'History attention window in latent frames. 0 = engine default (8). ' +
            'With `kvCache` the engine validates this against the compiled KV ' +
            'ring and fails at load on an unsupported combination.'
        ),
      offloadParamsToCpu: z
        .boolean()
        .optional()
        .describe('Keep weights in CPU memory and offload during GPU compute.'),
      frameJpegQuality: z
        .number()
        .int()
        .min(0)
        .max(100)
        .optional()
        .describe(
          'Frame encoding. 0 (default) emits lossless PNG; 1..100 emits JPEG at ' +
            'that quality on the standard scale (higher = better quality and ' +
            'larger frames). A block is roughly 14 MB of raw pixels at 832x480 and ' +
            'the default numFramePerBlock — more at a higher resolution or a larger ' +
            'block — so 85 is a good choice whenever frames cross a process or ' +
            'network boundary.'
        ),
      kvCache: z
        .boolean()
        .optional()
        .describe(
          'Per-layer history KV cache (~3.7x fewer frame-passes per block). ' +
            'Costs ~1.2 GB more VRAM but keeps block times flat; without it they ' +
            'ramp from ~1.8 s to ~7.5 s as the recompute window fills.'
        ),
      profile: z.boolean().optional().describe('Per-stage timing logs from the native session.')
    })
    .strict()
    .optional()
    .describe(
      "ABot-World session tuning — mode: 'world' only, rejected in every other " +
        'mode. Forwarded to the native session as-is.'
    ),
  upscaler: z
    .object({
      type: z
        .literal('esrgan')
        .optional()
        .describe(
          'Type of upscaler to use for post-generation upscaling when requested in diffusion({ upscale }).'
        ),
      model_src: modelSrcInputSchema
        .optional()
        .describe(
          'ESRGAN upscaler model (e.g. RealESRGAN_x4plus_anime_6B.pth). ' +
            'Required in diffusion mode when this `upscaler` block is set — ' +
            'configures the post-generation upscaler invoked via diffusion({ upscale }). ' +
            "In `mode: 'upscale'` the primary modelSrc itself is the ESRGAN model, " +
            'so this field is ignored.'
        ),
      tile_size: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          'ESRGAN upscaler tile size in pixels. Smaller tiles use less VRAM ' +
            'at the cost of more passes.'
        ),
      direct: z
        .boolean()
        .optional()
        .describe(
          'Use direct convolution in the ESRGAN upscaler instead of im2col + ' +
            'GEMM. Faster on some backends, slower on others.'
        ),
      offload_params_to_cpu: z
        .boolean()
        .optional()
        .describe(
          'Keep ESRGAN upscaler weights on CPU and offload them during compute. ' +
            'Trades latency for VRAM headroom on memory-constrained GPUs.'
        ),
      threads: z
        .union([z.literal(-1), z.number().int().positive()])
        .optional()
        .describe('Number of CPU threads dedicated to the ESRGAN upscaler. -1 = auto.')
    })
    .strict()
    .optional()
    .describe(
      'ESRGAN upscaler configuration. In diffusion mode this enables the ' +
        'post-generation upscale path invoked via diffusion({ upscale }) and ' +
        "requires `model_src`. In `mode: 'upscale'` only the tuning fields " +
        '(tile_size, direct, offload_params_to_cpu, threads) are honored — ' +
        'the primary modelSrc IS the ESRGAN model in that mode and ' +
        "`model_src` here is ignored. In `mode: 'video'` the entire `upscaler` " +
        'object is ignored. Mode-dependent constraints (e.g. `model_src` ' +
        'required in diffusion mode) are enforced by the sdcpp-generation ' +
        'plugin at load time, not at the schema layer.'
    )
})

export type SdcppConfig = z.input<typeof sdcppConfigSchema>

export const diffusionStatsSchema = z.object({
  modelLoadMs: z
    .number()
    .optional()
    .describe('Time in milliseconds spent loading the diffusion model.'),
  generationMs: z
    .number()
    .optional()
    .describe('Wall-clock time in milliseconds spent generating the output.'),
  conditionerMs: z
    .number()
    .optional()
    .describe('Time in milliseconds spent conditioning the prompt before denoising.'),
  denoiseMs: z
    .number()
    .optional()
    .describe('Time in milliseconds spent in the diffusion denoising loop.'),
  vaeMs: z
    .number()
    .optional()
    .describe('Time in milliseconds spent decoding diffusion latents with the VAE.'),
  postProcessMs: z
    .number()
    .optional()
    .describe('Time in milliseconds spent encoding, upscaling, muxing, and emitting outputs.'),
  stepsPerSecond: z
    .number()
    .optional()
    .describe('Diffusion denoising throughput in sampling steps per second.'),
  totalGenerationMs: z
    .number()
    .optional()
    .describe('Total generation time in milliseconds across all images in the batch.'),
  totalWallMs: z
    .number()
    .optional()
    .describe('Total wall-clock time in milliseconds including model load and sampling.'),
  totalSteps: z.number().optional().describe('Total number of diffusion sampling steps executed.'),
  totalGenerations: z.number().optional().describe('Total number of generation passes executed.'),
  totalImages: z.number().optional().describe('Total number of images produced.'),
  totalPixels: z
    .number()
    .optional()
    .describe('Total number of pixels generated across all images.'),
  width: z.number().optional().describe('Width in pixels of each generated image.'),
  height: z.number().optional().describe('Height in pixels of each generated image.'),
  seed: z
    .number()
    .optional()
    .describe('Seed that produced these outputs (randomized when not supplied by the caller).')
})

export type DiffusionStats = z.infer<typeof diffusionStatsSchema>

export const videoStatsSchema = diffusionStatsSchema
  .pick({
    modelLoadMs: true,
    generationMs: true,
    conditionerMs: true,
    denoiseMs: true,
    vaeMs: true,
    postProcessMs: true,
    stepsPerSecond: true,
    totalGenerationMs: true,
    totalWallMs: true,
    totalSteps: true,
    totalGenerations: true,
    totalImages: true,
    totalPixels: true,
    width: true,
    height: true,
    seed: true
  })
  .extend({
    totalVideos: z.number().optional().describe('Total number of videos produced.'),
    totalVideoFrames: z.number().optional().describe('Total number of video frames produced.'),
    videoFrames: z.number().optional().describe('Frame count of the most recent generated video.'),
    fps: z
      .number()
      .optional()
      .describe('Frames-per-second metadata for the most recent generated video.'),
    hasAudio: z
      .boolean()
      .optional()
      .describe(
        'True when the output AVI includes a muxed audio track (LTX-2 loaded ' +
          'with audioVaeModelSrc), false otherwise.'
      ),
    audioSampleRate: z
      .number()
      .optional()
      .describe('Sample rate (Hz) of the muxed audio track; 0 when there is no audio.')
  })

export type VideoStats = z.infer<typeof videoStatsSchema>

export const diffusionStreamResponseSchema = z.object({
  type: z.literal('diffusionStream'),
  step: z.number().optional(),
  totalSteps: z.number().optional(),
  elapsedMs: z.number().optional(),
  data: z.string().optional(),
  outputIndex: z.number().optional(),
  done: z.boolean().optional(),
  stats: diffusionStatsSchema.optional()
})

export type DiffusionStreamResponse = z.infer<typeof diffusionStreamResponseSchema>

export const videoStreamResponseSchema = z.object({
  type: z.literal('videoStream'),
  step: z.number().optional(),
  totalSteps: z.number().optional(),
  elapsedMs: z.number().optional(),
  data: z.string().optional(),
  outputIndex: z.number().optional(),
  done: z.boolean().optional(),
  stats: videoStatsSchema.optional()
})

export type VideoStreamResponse = z.infer<typeof videoStreamResponseSchema>

export const diffusionRequestSchema = z
  .object({
    modelId: z.string().describe('The identifier of the diffusion model to use for generation.'),
    prompt: z.string().describe('Positive prompt describing the image to generate.'),
    negative_prompt: z
      .string()
      .optional()
      .describe('Optional negative prompt describing what to avoid.'),
    width: z
      .number()
      .int()
      .positive()
      .multipleOf(8)
      .optional()
      .describe('Image width in pixels (must be a multiple of 8).'),
    height: z
      .number()
      .int()
      .positive()
      .multipleOf(8)
      .optional()
      .describe('Image height in pixels (must be a multiple of 8).'),
    steps: z.number().int().positive().optional().describe('Number of sampling steps to run.'),
    cfg_scale: z
      .number()
      .optional()
      .describe(
        'Classifier-free guidance scale for SD 1.x / 2.x / XL / SD3 models; typical range 1–20, default 7'
      ),
    img_cfg_scale: z
      .number()
      .default(-1)
      .describe(
        'Image CFG scale for img2img/inpaint workflows where the image and prompt should have different guidance weights; defaults to -1 which reuses cfg_scale'
      ),
    guidance: z
      .number()
      .optional()
      .describe('Distilled guidance for FLUX models; typical range 1–10, default 3.5'),
    sampling_method: samplingMethodSchema
      .optional()
      .describe('Sampling algorithm used by the diffusion scheduler.'),
    scheduler: scheduleTypeSchema.optional().describe('Noise schedule to apply when sampling.'),
    seed: z
      .number()
      .int()
      .optional()
      .describe('Random seed; when omitted we pick one and return it in stats.'),
    batch_count: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Number of images to generate in this call.'),
    vae_tiling: z
      .boolean()
      .optional()
      .describe('Enable VAE tiling for large images on constrained VRAM (overrides model config).'),
    cache_preset: z
      .string()
      .optional()
      .describe('Optional name of a cached sampler preset to reuse.'),
    init_image: base64StringSchema
      .optional()
      .describe(
        'Base64-encoded image for img2img generation. Mutually exclusive with init_images.'
      ),
    init_images: z
      .array(base64StringSchema)
      .min(1)
      .optional()
      .describe(
        'FLUX.2-only multi-reference fusion: array of base64-encoded PNG/JPEG buffers. ' +
          'Each buffer becomes a separate reference image that the FLUX.2 transformer attends to. ' +
          'Mutually exclusive with init_image; requires the model to be loaded with ' +
          "config.prediction='flux2_flow' and a Qwen3 text encoder via llmModelSrc."
      ),
    increase_ref_index: z
      .boolean()
      .optional()
      .describe(
        'FLUX.2 fusion only. When omitted, the addon default (false) is used. When false, all ' +
          'reference latents share one RoPE index slot and blend via attention (recommended for ' +
          'FLUX.2-klein). When true, each reference gets its own RoPE index slot — use only with ' +
          'text encoders that receive per-image vision tokens.'
      ),
    auto_resize_ref_image: z
      .boolean()
      .optional()
      .describe(
        'FLUX.2 only. When omitted, the addon default (true) is used. When true, every reference ' +
          'image (single or fusion) is auto-resized to the target width/height before VAE-encoding. ' +
          'Disable only if the buffers are already at the exact target dimensions.'
      ),
    lora: z
      .string()
      .min(1)
      .regex(ABSOLUTE_PATH_PATTERN, {
        message: 'lora must be an absolute path'
      })
      .optional()
      .describe(
        'Optional local LoRA adapter path to apply for this generation. ' +
          'Must be an absolute filesystem path. ' +
          'Whether the adapter persists across subsequent diffusion() calls is controlled ' +
          'by sdcppConfigSchema.lora_apply_mode (set at loadModel time).'
      ),
    strength: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe(
        'img2img denoising strength (0.0 = keep source, 1.0 = ignore source); used by the SD/SDXL SDEdit path. No-op for FLUX.2, which uses in-context conditioning and ignores this field.'
      ),
    upscale: z
      .union([
        z.boolean(),
        z
          .object({
            repeats: z.number().int().positive().optional()
          })
          .strict()
      ])
      .optional()
      .describe(
        'Post-generation ESRGAN upscale. ' +
          '`true` (or `{}` / `{ repeats: 1 }`) runs a single upscale pass at the ' +
          "model's native scale factor (e.g. x4 for RealESRGAN_x4plus). " +
          '`false` is a no-op (same as omitting the field). ' +
          '`{ repeats: N }` runs the upscaler N times sequentially — each pass ' +
          "multiplies the output dimensions by the model's scale factor. When " +
          '`batch_count > 1`, every output image is upscaled independently. ' +
          'Requires the model to be loaded with `upscaler.model_src` set in modelConfig.'
      )
  })
  .refine((d) => d.init_image === undefined || d.init_images === undefined, {
    message: 'init_image and init_images are mutually exclusive — pass one or the other, not both.'
  })

export type DiffusionRequest = z.input<typeof diffusionRequestSchema>

export const diffusionStreamRequestSchema = diffusionRequestSchema.extend({
  type: z.literal('diffusionStream')
})

export type DiffusionStreamRequest = z.input<typeof diffusionStreamRequestSchema>

type DiffusionClientParamsBase = Omit<DiffusionRequest, 'init_image' | 'init_images'>

export type DiffusionClientParams = DiffusionClientParamsBase &
  (
    | { init_image?: Uint8Array; init_images?: never }
    | { init_image?: never; init_images?: Uint8Array[] }
  )

const videoGenerationBaseSchema = z.object({
  modelId: z
    .string()
    .describe(
      'The identifier of the loaded video model to use for generation. ' +
        'On React Native, the video diffusion models currently shipped by ' +
        'QVAC are too large to load on typical mobile devices.'
    ),
  requestId: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Stable identifier for this in-flight video generation. Optional — falls back to a generated id when the field is missing.'
    ),
  prompt: z.string().describe('Positive prompt describing the video to generate.'),
  negative_prompt: z
    .string()
    .optional()
    .describe('Optional negative prompt describing what to avoid.'),
  lora: z
    .string()
    .min(1)
    .regex(ABSOLUTE_PATH_PATTERN, {
      message: 'lora must be an absolute path'
    })
    .optional()
    .describe('LTX video only. Worker-local absolute path to a LoRA adapter.'),
  lora_strength: z
    .number()
    .min(0)
    .max(10)
    .optional()
    .describe('LTX video only. Runtime LoRA multiplier in [0, 10]; requires lora.'),
  stg_scale: z
    .number()
    .min(0)
    .max(10)
    .optional()
    .describe('LTX video only. Spatiotemporal guidance scale in [0, 10].'),
  stg_block: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe('LTX video only. Transformer block skipped for spatiotemporal guidance.'),
  width: z
    .number()
    .int()
    .positive()
    .multipleOf(16)
    .optional()
    .describe(
      'Video width in pixels (must be a multiple of 16). LTX-2 and Wan 2.2 ' +
        'TI2V-5B additionally require a multiple of 32. LTX-2 is validated ' +
        'against the loaded model before generation; the TI2V requirement is ' +
        'enforced natively, derived from the loaded GGUF rather than its filename.'
    ),
  height: z
    .number()
    .int()
    .positive()
    .multipleOf(16)
    .optional()
    .describe(
      'Video height in pixels (must be a multiple of 16). LTX-2 and Wan 2.2 ' +
        'TI2V-5B additionally require a multiple of 32. LTX-2 is validated ' +
        'against the loaded model before generation; the TI2V requirement is ' +
        'enforced natively, derived from the loaded GGUF rather than its filename.'
    ),
  video_frames: z
    .number()
    .int()
    .refine((value) => value >= 5 && (value - 1) % 4 === 0, {
      message: 'video_frames must be an integer >= 5 of the form (4*k + 1)'
    })
    .optional()
    .describe(
      'Frame count for the generated video; must satisfy (4*k + 1), where k>=1. ' +
        'LTX-2 additionally requires the stricter (8*k + 1) with a max of 257, ' +
        'validated against the loaded model before generation.'
    ),
  fps: z
    .number()
    .positive()
    .max(120)
    .optional()
    .describe('AVI framerate metadata in frames per second; must be in (0, 120].'),
  seed: z
    .number()
    .int()
    .optional()
    .describe('Random seed; when omitted we pick one and return it in stats.'),
  steps: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Low-noise or single-expert denoising step count.'),
  sampling_method: samplingMethodSchema
    .optional()
    .describe('Sampling algorithm used by the low-noise diffusion scheduler.'),
  scheduler: videoScheduleTypeSchema
    .optional()
    .describe('Noise schedule to apply for the low-noise diffusion path.'),
  cfg_scale: z.number().optional().describe('Classifier-free guidance scale.'),
  flow_shift: z.number().optional().describe('Per-request flow-matching guidance shift override.'),
  high_noise_steps: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      'Wan 2.2 A14B high-noise expert step count. Requires a model loaded ' +
        'with modelConfig.highNoiseDiffusionModelSrc; rejected otherwise. ' +
        'Omit to let native routing derive the split from moe_boundary.'
    ),
  high_noise_sampler: samplingMethodSchema
    .optional()
    .describe(
      'Wan 2.2 A14B high-noise expert sampler. Requires a model loaded with ' +
        'modelConfig.highNoiseDiffusionModelSrc; rejected otherwise.'
    ),
  high_noise_scheduler: scheduleTypeSchema
    .optional()
    .describe(
      'Wan 2.2 A14B high-noise expert scheduler. Requires a model loaded with ' +
        'modelConfig.highNoiseDiffusionModelSrc; rejected otherwise.'
    ),
  high_noise_cfg_scale: z
    .number()
    .optional()
    .describe(
      'Wan 2.2 A14B high-noise expert CFG scale. Requires a model loaded with ' +
        'modelConfig.highNoiseDiffusionModelSrc; rejected otherwise.'
    ),
  high_noise_flow_shift: z
    .number()
    .optional()
    .describe(
      'Wan 2.2 A14B high-noise expert flow shift override. Requires a model ' +
        'loaded with modelConfig.highNoiseDiffusionModelSrc; rejected otherwise.'
    ),
  moe_boundary: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe(
      'Wan 2.2 A14B mixture-of-experts boundary in [0, 1]. Requires a model ' +
        'loaded with modelConfig.highNoiseDiffusionModelSrc; rejected otherwise.'
    ),
  vace_strength: z.number().min(0).max(1).optional().describe('Control-frame guidance strength.'),
  control_frames: z
    .array(base64StringSchema)
    .min(1)
    .optional()
    .describe('Optional array of base64-encoded control-frame images.'),
  vae_tiling: z
    .boolean()
    .optional()
    .describe('Enable VAE tiling for large videos on constrained VRAM.'),
  vae_tile_size: z
    .union([z.number().positive(), z.string().min(1)])
    .optional()
    .describe('VAE tile size override.'),
  vae_tile_overlap: z.number().optional().describe('VAE tile overlap override.'),
  temporal_tiling: z
    .boolean()
    .optional()
    .describe(
      'LTX-2 only: tile the video VAE decode along the time axis to cap peak ' +
        'VRAM for HD / long clips. No effect on Wan (spatial-only VAE).'
    ),
  cache_mode: cacheModeSchema.optional().describe('Step-caching algorithm.'),
  cache_preset: z
    .string()
    .optional()
    .describe('Optional name of a cached sampler preset to reuse.'),
  cache_threshold: z.number().optional().describe('Direct cache reuse threshold override.')
})

// Single request object with mode-dependent rules expressed via a shared refine.
// Keeping the request schema a plain object (instead of a discriminated union)
// lets the request builder construct the request without an `as` cast that
// would otherwise disable field-level type-checking. The compile-time
// "img2vid requires init_image" guarantee lives on the caller-facing
// discriminated union types below.
const videoRequestObjectSchema = videoGenerationBaseSchema.extend({
  mode: z
    .enum(['txt2vid', 'img2vid'])
    .describe("Generation mode: 'txt2vid' (no source frame) or 'img2vid' (first-frame image)."),
  init_image: base64StringSchema
    .optional()
    .describe(
      'Base64-encoded first-frame image (PNG/JPEG). Required for img2vid; rejected for txt2vid.'
    ),
  strength: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe('img2vid denoise strength in [0, 1]; rejected for txt2vid.'),
  reference_images: z
    .array(base64StringSchema)
    .length(1)
    .optional()
    .describe(
      'LTX txt2vid only. Exactly one base64-encoded composite reference sheet; requires lora.'
    ),
  reference_attention_strength: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe(
      'LTX txt2vid only. Reference denoise-mask strength in [0, 1]; requires reference_images.'
    ),
  reference_downscale_factor: z
    .literal(1)
    .optional()
    .describe('LTX txt2vid only. Reference-image spatial factor; currently exactly 1.')
})

function refineVideoMode(data: z.infer<typeof videoRequestObjectSchema>, ctx: z.RefinementCtx) {
  if (data.mode === 'img2vid' && data.init_image === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['init_image'],
      message: "init_image is required when mode is 'img2vid'."
    })
  }
  if (data.mode === 'txt2vid') {
    if (data.init_image !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['init_image'],
        message: 'init_image is only valid for img2vid.'
      })
    }
    if (data.strength !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['strength'],
        message: 'strength is only valid for img2vid.'
      })
    }
  }
  if (data.mode === 'img2vid') {
    const referenceFields = [
      'reference_images',
      'reference_attention_strength',
      'reference_downscale_factor'
    ] as const
    for (const field of referenceFields) {
      if (data[field] === undefined) continue
      ctx.addIssue({
        code: 'custom',
        path: [field],
        message: `${field} is only valid for txt2vid.`
      })
    }
  }
}

export const videoRequestSchema = videoRequestObjectSchema.superRefine(refineVideoMode)

function refineLtxVideoRequest(
  data: z.infer<typeof videoRequestObjectSchema>,
  ctx: z.RefinementCtx
) {
  if (data.width !== undefined && data.width % 32 !== 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['width'],
      message: 'LTX-2 width must be a multiple of 32.'
    })
  }
  if (data.height !== undefined && data.height % 32 !== 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['height'],
      message: 'LTX-2 height must be a multiple of 32.'
    })
  }
  if (
    data.video_frames !== undefined &&
    (data.video_frames > 257 || (data.video_frames - 1) % 8 !== 0)
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['video_frames'],
      message: 'LTX-2 video_frames must be at most 257 and satisfy (8*k + 1), where k>=1.'
    })
  }
  if (data.lora_strength !== undefined && data.lora === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['lora_strength'],
      message: 'lora_strength requires lora.'
    })
  }
  if (data.reference_images !== undefined) {
    if (data.lora === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['reference_images'],
        message: 'reference_images requires lora.'
      })
    }
    if (data.video_frames === undefined || data.video_frames < 121) {
      ctx.addIssue({
        code: 'custom',
        path: ['video_frames'],
        message:
          'LTX reference conditioning requires video_frames to be explicitly set to at least 121.'
      })
    }
  } else {
    for (const field of ['reference_attention_strength', 'reference_downscale_factor'] as const) {
      if (data[field] === undefined) continue
      ctx.addIssue({
        code: 'custom',
        path: [field],
        message: `${field} requires reference_images.`
      })
    }
  }
}

export const ltxVideoRequestSchema = videoRequestSchema.superRefine(refineLtxVideoRequest)

const nonLtxVideoMask = {
  lora: true,
  lora_strength: true,
  stg_scale: true,
  stg_block: true,
  reference_images: true,
  reference_attention_strength: true,
  reference_downscale_factor: true,
  scheduler: true
} as const
const nonLtxVideoSchema = videoRequestObjectSchema.pick(nonLtxVideoMask)
const nonLtxVideoFields = [
  'lora',
  'lora_strength',
  'stg_scale',
  'stg_block',
  'reference_images',
  'reference_attention_strength',
  'reference_downscale_factor'
] as const

function refineNonLtxVideoRequest(data: z.infer<typeof nonLtxVideoSchema>, ctx: z.RefinementCtx) {
  for (const field of nonLtxVideoFields) {
    if (data[field] === undefined) continue
    ctx.addIssue({
      code: 'custom',
      path: [field],
      message: `${field} is only supported by LTX video models.`
    })
  }
  if (data.scheduler === 'ltx2') {
    ctx.addIssue({
      code: 'custom',
      path: ['scheduler'],
      message: "scheduler 'ltx2' is only supported by LTX video models."
    })
  }
}

export const nonLtxVideoRequestSchema = nonLtxVideoSchema.superRefine(refineNonLtxVideoRequest)

const wan22MoeMask = {
  high_noise_steps: true,
  high_noise_sampler: true,
  high_noise_scheduler: true,
  high_noise_cfg_scale: true,
  high_noise_flow_shift: true,
  moe_boundary: true
} as const
const wan22MoeSchema = videoGenerationBaseSchema.pick(wan22MoeMask)
const wan22MoeFields = Object.keys(wan22MoeMask) as (keyof typeof wan22MoeMask)[]

function refineSingleExpertVideoRequest(
  data: z.infer<typeof wan22MoeSchema>,
  ctx: z.RefinementCtx
) {
  for (const field of wan22MoeFields) {
    if (data[field] === undefined) continue
    ctx.addIssue({
      code: 'custom',
      path: [field],
      message:
        `${field} is a Wan 2.2 A14B mixture-of-experts parameter and the loaded ` +
        'model has no high-noise expert. Only a model loaded with ' +
        'modelConfig.highNoiseDiffusionModelSrc routes to a second expert; ' +
        'single-expert layouts (Wan 2.1, Wan 2.2 TI2V-5B, LTX-2) do not.'
    })
  }
}

export const singleExpertVideoRequestSchema = wan22MoeSchema.superRefine(
  refineSingleExpertVideoRequest
)

export type VideoRequest = z.input<typeof videoRequestSchema>

export const videoStreamRequestSchema = videoRequestObjectSchema
  .extend({ type: z.literal('videoStream') })
  .superRefine(refineVideoMode)

export type VideoStreamRequest = z.input<typeof videoStreamRequestSchema>

type VideoClientParamsCommon = Omit<
  VideoRequest,
  | 'requestId'
  | 'mode'
  | 'init_image'
  | 'strength'
  | 'control_frames'
  | 'lora'
  | 'lora_strength'
  | 'reference_images'
  | 'reference_attention_strength'
  | 'reference_downscale_factor'
> & {
  control_frames?: Uint8Array[]
}

type VideoClientLoraParams =
  { lora?: never; lora_strength?: never } | { lora: string; lora_strength?: number }

export type VideoTxt2vidClientParams =
  | (VideoClientParamsCommon &
      VideoClientLoraParams & {
        mode: 'txt2vid'
        init_image?: never
        strength?: never
        reference_images?: never
        reference_attention_strength?: never
        reference_downscale_factor?: never
      })
  | (VideoClientParamsCommon & {
      mode: 'txt2vid'
      init_image?: never
      strength?: never
      lora: string
      lora_strength?: number
      reference_images: readonly [Uint8Array]
      video_frames: number
      reference_attention_strength?: number
      reference_downscale_factor?: 1
    })

export type VideoImg2vidClientParams = VideoClientParamsCommon &
  VideoClientLoraParams & {
    mode: 'img2vid'
    init_image: Uint8Array
    strength?: number
    reference_images?: never
    reference_attention_strength?: never
    reference_downscale_factor?: never
  }

export type VideoClientParams = VideoTxt2vidClientParams | VideoImg2vidClientParams

// ============================================
// Standalone ESRGAN upscale (mode: "upscale")
// ============================================

export const upscaleStatsSchema = z.object({
  modelLoadMs: z
    .number()
    .optional()
    .describe('Wall-clock time in milliseconds spent loading the upscaler model.'),
  upscaleMs: z
    .number()
    .optional()
    .describe('Wall-clock time in milliseconds for the most recent upscale job.'),
  totalUpscaleMs: z
    .number()
    .optional()
    .describe('Cumulative upscale time in milliseconds across all jobs.'),
  totalWallMs: z
    .number()
    .optional()
    .describe('Total wall-clock time in milliseconds including model load and upscaling.'),
  totalUpscales: z.number().optional().describe('Cumulative number of upscale calls.'),
  totalImages: z.number().optional().describe('Cumulative number of images produced.'),
  totalPixels: z
    .number()
    .optional()
    .describe('Cumulative number of pixels produced across all images.'),
  width: z.number().optional().describe('Width of the most recent emitted PNG.'),
  height: z.number().optional().describe('Height of the most recent emitted PNG.'),
  repeats: z
    .number()
    .optional()
    .describe('Number of ESRGAN passes used by the most recent upscale job.'),
  backendDevice: z
    .enum(['cpu', 'gpu'])
    .optional()
    .describe(
      'Actual compute device used by the ESRGAN upscaler. ' +
        'Reflects the backend stable-diffusion.cpp selected (e.g. Android `gpu` ' +
        'falls back to `cpu` because the mobile GPU/OpenCL path is unstable).'
    )
})

export type UpscaleStats = z.infer<typeof upscaleStatsSchema>

export const upscaleRequestSchema = z.object({
  modelId: z
    .string()
    .describe(
      'Identifier of the loaded upscaler model. The model must have been loaded ' +
        "with `modelType: 'diffusion'` and `modelConfig.mode: 'upscale'`."
    ),
  image: z
    .string()
    .min(1)
    .regex(BASE64_PATTERN)
    .describe('Base64-encoded PNG/JPEG bytes of the source image.'),
  repeats: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      'Number of ESRGAN passes to run sequentially. Each pass multiplies ' +
        "dimensions by the model's native scale factor; only the final image " +
        'is emitted (`outputs.length === 1`). Defaults to 1.'
    )
})

export type UpscaleRequest = z.input<typeof upscaleRequestSchema>

export const upscaleStreamRequestSchema = upscaleRequestSchema.extend({
  type: z.literal('upscaleStream')
})

export type UpscaleStreamRequest = z.input<typeof upscaleStreamRequestSchema>

export const upscaleStreamResponseSchema = z.object({
  type: z.literal('upscaleStream'),
  data: z.string().optional(),
  outputIndex: z.number().optional(),
  done: z.boolean().optional(),
  stats: upscaleStatsSchema.optional()
})

export type UpscaleStreamResponse = z.infer<typeof upscaleStreamResponseSchema>

export type UpscaleClientParams = Omit<UpscaleRequest, 'image'> & {
  image: Uint8Array
}

// ============================================
// ABot-World interactive world sessions (mode: "world")
// ============================================

export const walkKeySchema = z.enum(['W', 'A', 'S', 'D', 'I', 'J', 'K', 'L'])

export type WalkKey = z.infer<typeof walkKeySchema>

/**
 * Keys held for one block, as accepted by the client helpers: an array
 * (`['W', 'J']`), a keys object (`{ W: true }`), or a raw 8-bit mask
 * (bit 0..7 = W,A,S,D,I,J,K,L). All three normalize to the array form
 * before the request goes on the wire.
 */
export type WalkKeysInput =
  number | readonly string[] | Readonly<Record<string, boolean | undefined>>

export const worldStepStatsSchema = z.object({
  modelLoadMs: z
    .number()
    .optional()
    .describe('Time in milliseconds spent loading the DiT, decoder and scene pack.'),
  stepMs: z
    .number()
    .optional()
    .describe('Generation time in milliseconds for this block, excluding frame encoding.'),
  totalStepMs: z
    .number()
    .optional()
    .describe('Cumulative generation time in milliseconds across the session.'),
  totalSteps: z
    .number()
    .int()
    .optional()
    .describe(
      'Number of blocks generated so far in this session; resets when the session reloads.'
    ),
  totalFrames: z
    .number()
    .int()
    .optional()
    .describe('Cumulative frames delivered across the session.'),
  frames: z
    .number()
    .int()
    .optional()
    .describe(
      'Frames delivered for this block — 9 for the first block after a load ' +
        '(decoder warmup), 12 thereafter at the default numFramePerBlock.'
    ),
  width: z.number().int().optional().describe('Frame width in pixels.'),
  height: z.number().int().optional().describe('Frame height in pixels.'),
  actionMask: z
    .number()
    .int()
    .optional()
    .describe('The 8-bit key mask this block was generated under (bit 0..7 = W,A,S,D,I,J,K,L).')
})

export type WorldStepStats = z.infer<typeof worldStepStatsSchema>

export const worldSceneStatsSchema = z.object({
  sceneCreateMs: z
    .number()
    .optional()
    .describe(
      'Wall-clock time in milliseconds for the scene pack: loading the prompt ' +
        'and image encoders, encoding both, and writing the pack.'
    ),
  width: z.number().int().optional().describe('Scene width in pixels, baked into the pack.'),
  height: z.number().int().optional().describe('Scene height in pixels, baked into the pack.')
})

export type WorldSceneStats = z.infer<typeof worldSceneStatsSchema>

export const worldStepRequestSchema = z.object({
  modelId: z
    .string()
    .describe(
      "Identifier of a model loaded with modelConfig.mode: 'world'. The session " +
        'activates on the first step when no sceneSrc was supplied at load.'
    ),
  requestId: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Stable identifier for this in-flight block, for cancel(). Optional on the ' +
        'wire — the server generates one when the field is missing.'
    ),
  keys: z
    .array(walkKeySchema)
    .optional()
    .describe(
      'Keys held for this block. WASD move, IJKL steer the camera; duplicates are ' +
        'collapsed. Omit or pass an empty array to idle.'
    )
})

export type WorldStepRequest = z.input<typeof worldStepRequestSchema>

export const worldStepStreamRequestSchema = worldStepRequestSchema.extend({
  type: z.literal('worldStepStream')
})

export type WorldStepStreamRequest = z.input<typeof worldStepStreamRequestSchema>

export const worldStepStreamResponseSchema = z.object({
  type: z.literal('worldStepStream'),
  // Same three fields, same names, as diffusionStream and videoStream: the
  // engine's own tick, forwarded rather than dropped.
  //
  // It is NOT mid-block liveness, and cannot be. WorldSessionModel.cpp runs
  // sd_abot_session_step() to completion, delivers every frame, and only then
  // fires its progress callback — exactly once per block, after the frames.
  // So this arrives as an end-of-block summary. A caller wanting a "still
  // working" signal during the 1.8-7.5s a block takes needs an addon change;
  // do not build a hang detector on this.
  step: z
    .number()
    .int()
    .optional()
    .describe(
      "The engine's own `step` counter, forwarded verbatim: blocks completed on " +
        'this session. One tick is emitted per block, after its frames, so this ' +
        'is not progress within a block.'
    ),
  totalSteps: z
    .number()
    .int()
    .optional()
    .describe(
      'Frames DELIVERED by the block that just finished — a final count, not a ' +
        'running one, because the engine emits this after the frames rather than ' +
        'during. Named `totalSteps` only so the wire shape matches videoStream ' +
        'and diffusionStream, where that slot holds a sampler-step total.'
    ),
  elapsedMs: z.number().optional().describe('Milliseconds elapsed within this block so far.'),
  data: z
    .string()
    .optional()
    .describe('Base64 of one decoded frame — PNG, or JPEG when world.frameJpegQuality is 1..100.'),
  frameIndex: z
    .number()
    .int()
    .optional()
    .describe('Zero-based index of this frame within the block.'),
  done: z.boolean().optional(),
  stats: worldStepStatsSchema.optional()
})

export type WorldStepStreamResponse = z.infer<typeof worldStepStreamResponseSchema>

/**
 * Per-axis ceiling for a generated world. Neither the SDK nor the addon bounded
 * these before: the addon checks only "positive multiple of 32", and the pack
 * ceiling in ops/world.ts runs after native generation has already allocated the
 * GPU buffers and written the file, so it cannot prevent the OOM.
 */
export const MAX_SCENE_DIMENSION = 4096

/**
 * Total pixel budget, ~1080p rounded onto the 32 grid. Bounds the product as
 * well as each axis, so 4096x4096 is refused even though both axes pass. The
 * validated 832x480 tier sits 5x under it.
 */
export const MAX_SCENE_PIXELS = 1920 * 1088

/**
 * Ceiling on the ENCODED first frame — what crosses the wire, not what the
 * decoder allocates. Those differ by orders of magnitude for a compressed
 * format, so this is not the decompression-bomb guard; the declared-dimension
 * check in `ops/world.ts` is. This one keeps a multi-megabyte base64 string off
 * the worker in the first place.
 *
 * 3 MB is generous for a frame that ends up at most 1920x1088 — and it is also
 * the largest value this can be *enforced* at today. `BASE64_PATTERN` is a
 * starred quad group that both engines give up on a little above this ceiling,
 * but differently, and the difference matters: measured at 4.8M characters, JSC
 * (Bun) returns `false`, while **V8 — which is what Bare runs — THROWS
 * `RangeError: Maximum call stack size exceeded`**. Since Zod runs every string
 * check regardless of order, a larger image reaches the pattern even after
 * `.max()` fails, so `safeParse` throws instead of reporting `too_big`.
 * 3 MB decodes to 4194304 characters, inside the range that still matches on
 * both. The client guards the raw byte length before encoding for the same
 * reason (see `createWorldSceneResult`). The pattern is shared with the
 * diffusion, upscale and VLA image fields, so fixing it belongs in its own
 * change.
 */
export const MAX_SCENE_IMAGE_BYTES = 3 * 1024 * 1024

/**
 * Base64 characters for `MAX_SCENE_IMAGE_BYTES`, four per three bytes. The
 * ceiling is enforced on the encoded length rather than the decoded one so it
 * costs a string compare instead of a decode — and, since padding only ever
 * shortens the payload, a string within this many characters can never exceed
 * `MAX_SCENE_IMAGE_BYTES` once decoded.
 */
export const MAX_SCENE_IMAGE_BASE64_CHARS = (MAX_SCENE_IMAGE_BYTES / 3) * 4

/**
 * Cross-field ceilings for a scene request. Kept as a named function because
 * both the plain and the stream request schema have to enforce it, and because
 * the pixel budget is a contract worth testing directly.
 */
export function refineWorldSceneBudget(
  value: { width?: number | undefined; height?: number | undefined },
  ctx: z.RefinementCtx
) {
  const width = value.width ?? 832
  const height = value.height ?? 480
  if (width * height > MAX_SCENE_PIXELS) {
    ctx.addIssue({
      code: 'custom',
      path: ['width'],
      message:
        `A ${width}x${height} world is ${width * height} pixels, over the ` +
        `${MAX_SCENE_PIXELS}-pixel ceiling. Scene creation allocates for the full ` +
        'frame before anything can check the result, so this is refused up front.'
    })
  }
  // The encoded-size ceiling is a `.max()` on the field rather than a check here.
  // Note Zod runs every check on a string regardless of order, so an oversized
  // image collects the `too_big` issue AND whatever BASE64_PATTERN reports — the
  // ordering only decides which reads first, it does not short-circuit. See
  // MAX_SCENE_IMAGE_BYTES for why the pattern cannot be relied on at that size.
}

const worldSceneRequestShape = {
  modelId: z.string().describe("Identifier of a model loaded with modelConfig.mode: 'world'."),
  requestId: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Stable identifier for this scene creation. Note that scene creation cannot ' +
        'be interrupted — the engine exposes no abort hook — so cancelling it stops ' +
        'the SDK from yielding, but the encode runs to completion.'
    ),
  prompt: z
    .string()
    .min(1)
    .describe(
      'Scene prompt, encoded verbatim by umT5-XXL. The reference pipeline prefixes ' +
        'prompts with "| unknown | ".'
    ),
  image: z
    .string()
    .min(1)
    // Declared before the pattern so an oversized frame reports its size instead
    // of failing as malformed base64.
    .max(MAX_SCENE_IMAGE_BASE64_CHARS)
    .regex(BASE64_PATTERN)
    .describe(
      'Base64 PNG/JPEG bytes of the first frame, up to 3 MB decoded and 8192x8192 ' +
        'pixels. It is cover-scaled and center-cropped to width x height, so a ' +
        'frame larger than the target resolution buys nothing. The pixel ceiling ' +
        'is read from the image header and enforced by the worker before anything ' +
        'decodes it, so a compressed image that expands to gigabytes is refused ' +
        'rather than allocated.'
    ),
  width: z
    .number()
    .int()
    .positive()
    .multipleOf(32)
    .max(MAX_SCENE_DIMENSION)
    .optional()
    .describe(
      'Scene width in pixels, a multiple of 32, at most 4096. Defaults to 832. ' +
        'width x height must also stay within 2088960 pixels (1920x1088). That ' +
        'product rule is a cross-field constraint, so it is NOT expressed in the ' +
        'generated JSON Schema or Python client — those validate each axis only, ' +
        'and the combined limit is enforced by the worker, which rejects the ' +
        'request before any GPU memory is allocated.'
    ),
  height: z
    .number()
    .int()
    .positive()
    .multipleOf(32)
    .max(MAX_SCENE_DIMENSION)
    .optional()
    .describe(
      'Scene height in pixels, a multiple of 32, at most 4096. Defaults to 480. ' +
        'See `width` for the total-pixel ceiling, which bounds the product as ' +
        'well as each axis and is enforced server-side.'
    ),
  returnPack: z
    .boolean()
    .optional()
    .describe(
      'Return the generated scene pack in the response. Off by default: the pack ' +
        'is 10+ MB (a third larger again as base64) and the common ' +
        'create-then-walk-now flow never touches the bytes — the world is already ' +
        'live on the session. Turn it on to persist a world, then pass the saved ' +
        'file back as modelConfig.sceneSrc on a later load to walk it again.'
    )
}

export const worldSceneRequestSchema = z
  .object(worldSceneRequestShape)
  .superRefine(refineWorldSceneBudget)

export type WorldSceneRequest = z.input<typeof worldSceneRequestSchema>

export const worldSceneStreamRequestSchema = z
  .object({ ...worldSceneRequestShape, type: z.literal('worldSceneStream') })
  .superRefine(refineWorldSceneBudget)

export type WorldSceneStreamRequest = z.input<typeof worldSceneStreamRequestSchema>

export const worldSceneStreamResponseSchema = z.object({
  type: z.literal('worldSceneStream'),
  data: z
    .string()
    .optional()
    .describe(
      'Base64 of the finished scene pack (~10 MB). Persist it and pass it back as ' +
        'modelConfig.sceneSrc to walk the same world again later.'
    ),
  done: z.boolean().optional(),
  stats: worldSceneStatsSchema.optional()
})

export type WorldSceneStreamResponse = z.infer<typeof worldSceneStreamResponseSchema>

export type WorldStepClientParams = Omit<WorldStepRequest, 'requestId' | 'keys'> & {
  keys?: WalkKeysInput
}

export type WorldSceneClientParams = Omit<WorldSceneRequest, 'requestId' | 'image'> & {
  image: Uint8Array
}
