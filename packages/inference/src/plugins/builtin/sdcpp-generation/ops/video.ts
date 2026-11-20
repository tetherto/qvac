import { requestParent, type PluginHandlerContext } from '@/schemas/plugin'
import { VideoStableDiffusion } from '@qvac/diffusion-cpp'
import type { VideoRuntimeStats } from '@qvac/diffusion-cpp'
import type { z } from 'zod'
import Buffer from 'bare-buffer'
import path from 'bare-path'
import { getEngineLogger } from '@/logging/index'
import { getModel, getModelEntry } from '@/runtime/model-registry'
import { getRequestRegistry, withRequestContext } from '@/runtime/index'
import { generateRandomRequestId } from '@/runtime/request-id'
import { ModelOperationNotSupportedError, PluginRequestValidationFailedError } from '@/errors/index'
import { formatZodError } from '@/utils/zod-error'
import { ModelType } from '@/schemas/index'
import {
  ltxVideoRequestSchema,
  h3VideoRequestSchema,
  wanVideoRequestSchema,
  nonLtxVideoRequestSchema,
  sdcppConfigSchema,
  singleExpertVideoRequestSchema,
  type VideoRequest,
  type VideoStreamResponse,
  type VideoStats
} from '@/schemas/sdcpp-config'
import type { TrackedRequest } from '@/schemas/request-base'

interface ResponseWithStats {
  stats?: VideoRuntimeStats
}

const ltxVideoModels = new WeakSet<VideoStableDiffusion>()
const h3VideoModels = new WeakSet<VideoStableDiffusion>()
const moeCapableVideoModels = new WeakSet<VideoStableDiffusion>()

export function markLtxVideoModel(model: VideoStableDiffusion) {
  ltxVideoModels.add(model)
}

export function markH3VideoModel(model: VideoStableDiffusion) {
  h3VideoModels.add(model)
}

export function markMoeCapableVideoModel(model: VideoStableDiffusion) {
  moeCapableVideoModels.add(model)
}

function parseVideoRequest(schema: z.ZodType, request: VideoRequest) {
  const result = schema.safeParse(request)
  if (!result.success) {
    throw new PluginRequestValidationFailedError('videoStream', formatZodError(result.error))
  }
}

function validateProviderPaths(request: VideoRequest) {
  if (request.lora !== undefined && !path.isAbsolute(request.lora)) {
    throw new PluginRequestValidationFailedError(
      'videoStream',
      'lora must be an absolute path on the inference provider'
    )
  }
}

// The addon reports `hasAudio` as a numeric flag (1/0); it is surfaced as
// a boolean so consumers get a readable `stats.hasAudio` instead of a magic
// number. Everything else passes through and is validated client-side.
function toVideoStats(stats: VideoRuntimeStats | undefined): VideoStats | undefined {
  if (!stats) return undefined
  const { hasAudio, ...rest } = stats
  return {
    ...rest,
    ...(hasAudio !== undefined && { hasAudio: hasAudio !== 0 })
  }
}

// The diffusion plugin instantiates `VideoStableDiffusion` when the model is
// loaded with `modelConfig.mode === "video"` and `ImgStableDiffusion` (or
// `EsrganUpscaler`) otherwise. Those have no video `run()` shape, so we refuse
// the call upfront with a structured error rather than letting a native-addon
// error propagate.
function asVideoModel(model: unknown, modelId: string): VideoStableDiffusion {
  if (model instanceof VideoStableDiffusion) {
    return model
  }

  const entry = getModelEntry(modelId)
  const modelType = entry ? entry.local.modelType : ModelType.sdcppGeneration
  throw new ModelOperationNotSupportedError(modelId, modelType, 'video', ['diffusion'], [])
}

export type VideoOpResult = { stats: VideoStats | undefined }

export async function* video(
  request: VideoRequest & TrackedRequest,
  context?: PluginHandlerContext
): AsyncGenerator<VideoStreamResponse, VideoOpResult> {
  await using ctx = await getRequestRegistry().begin({
    requestId: request.requestId ?? generateRandomRequestId(),
    sessionId: request.sessionId,
    ...requestParent(context),
    kind: 'diffusion',
    modelId: request.modelId
  })
  const requestLogger = withRequestContext(getEngineLogger(), ctx)
  const model = asVideoModel(getModel(request.modelId), request.modelId)
  if (ltxVideoModels.has(model)) parseVideoRequest(ltxVideoRequestSchema, request)
  else {
    parseVideoRequest(nonLtxVideoRequestSchema, request)
    parseVideoRequest(
      h3VideoModels.has(model) ? h3VideoRequestSchema : wanVideoRequestSchema,
      request
    )
  }
  if (!moeCapableVideoModels.has(model)) parseVideoRequest(singleExpertVideoRequestSchema, request)
  validateProviderPaths(request)
  const modelEntry = getModelEntry(request.modelId)
  const modelConfig = modelEntry ? sdcppConfigSchema.safeParse(modelEntry.local.config) : null
  const loraApplyMode = modelConfig?.success ? (modelConfig.data.loraApplyMode ?? 'auto') : 'auto'
  if (request.lora !== undefined && loraApplyMode !== 'at_runtime') {
    requestLogger.warn(
      `[video] loraApplyMode="${loraApplyMode}" may persist the request LoRA across later generations; use "at_runtime" for per-call application.`
    )
  }

  let cancelPromise: Promise<void> | undefined
  const onAbort = () => {
    cancelPromise ??= model.cancel().catch((err: unknown) => {
      requestLogger.warn(
        `[cancel] model.cancel() rejected during abort for modelId=${request.modelId}: ${err instanceof Error ? err.message : String(err)}`
      )
    })
  }
  ctx.signal.addEventListener('abort', onAbort, { once: true })
  if (ctx.signal.aborted) onAbort()
  ctx.scope.defer(async () => {
    ctx.signal.removeEventListener('abort', onAbort)
    await cancelPromise
  })

  const runParams = {
    prompt: request.prompt,
    ...(request.negativePrompt !== undefined && {
      negative_prompt: request.negativePrompt
    }),
    ...(request.lora !== undefined && { lora: request.lora }),
    ...(request.loraStrength !== undefined && {
      lora_strength: request.loraStrength
    }),
    ...(request.stgScale !== undefined && { stg_scale: request.stgScale }),
    ...(request.stgBlock !== undefined && { stg_block: request.stgBlock }),
    ...(request.width !== undefined && { width: request.width }),
    ...(request.height !== undefined && { height: request.height }),
    ...(request.videoFrames !== undefined && {
      video_frames: request.videoFrames
    }),
    ...(request.fps !== undefined && { fps: request.fps }),
    ...(request.seed !== undefined && { seed: request.seed }),
    ...(request.steps !== undefined && { steps: request.steps }),
    ...(request.samplingMethod !== undefined && {
      sampling_method: request.samplingMethod
    }),
    ...(request.scheduler !== undefined && { scheduler: request.scheduler }),
    ...(request.cfgScale !== undefined && { cfg_scale: request.cfgScale }),
    ...(request.flowShift !== undefined && { flow_shift: request.flowShift }),
    ...(request.highNoiseSteps !== undefined && {
      high_noise_steps: request.highNoiseSteps
    }),
    ...(request.highNoiseSampler !== undefined && {
      high_noise_sampler: request.highNoiseSampler
    }),
    ...(request.highNoiseScheduler !== undefined && {
      high_noise_scheduler: request.highNoiseScheduler
    }),
    ...(request.highNoiseCfgScale !== undefined && {
      high_noise_cfg_scale: request.highNoiseCfgScale
    }),
    ...(request.highNoiseFlowShift !== undefined && {
      high_noise_flow_shift: request.highNoiseFlowShift
    }),
    ...(request.moeBoundary !== undefined && {
      moe_boundary: request.moeBoundary
    }),
    ...(request.vaceStrength !== undefined && {
      vace_strength: request.vaceStrength
    }),
    ...(request.strength !== undefined && {
      strength: request.strength
    }),
    ...(request.controlFrames !== undefined && {
      control_frames: request.controlFrames.map((b64) => Buffer.from(b64, 'base64'))
    }),
    ...(request.referenceImages !== undefined && {
      reference_images: request.referenceImages.map((b64) => Buffer.from(b64, 'base64'))
    }),
    ...(request.referenceAttentionStrength !== undefined && {
      reference_attention_strength: request.referenceAttentionStrength
    }),
    ...(request.referenceDownscaleFactor !== undefined && {
      reference_downscale_factor: request.referenceDownscaleFactor
    }),
    ...(request.vaeTiling !== undefined && { vae_tiling: request.vaeTiling }),
    ...(request.vaeTileSize !== undefined && {
      vae_tile_size: request.vaeTileSize
    }),
    ...(request.vaeTileOverlap !== undefined && {
      vae_tile_overlap: request.vaeTileOverlap
    }),
    ...(request.temporalTiling !== undefined && {
      temporal_tiling: request.temporalTiling
    }),
    ...(request.cacheMode !== undefined && { cache_mode: request.cacheMode }),
    ...(request.cachePreset !== undefined && {
      cache_preset: request.cachePreset
    }),
    ...(request.cacheThreshold !== undefined && {
      cache_threshold: request.cacheThreshold
    })
  }
  const response =
    request.mode === 'img2vid'
      ? await model.run({
          ...runParams,
          mode: 'img2vid',
          // parseVideoRequest requires this field for image-to-video requests.
          init_image: Buffer.from(request.initImage!, 'base64')
        })
      : await model.run({ ...runParams, mode: 'txt2vid' })

  let drained = false
  ctx.scope.defer(async () => {
    if (drained) return
    onAbort()
    try {
      await response.await()
    } catch {
      // Preserve the stream's original failure or consumer exit.
    }
  })

  let outputIndex = 0

  for await (const chunk of response.iterate()) {
    if (ctx.signal.aborted) continue
    if (chunk instanceof Uint8Array) {
      yield {
        type: 'videoStream',
        data: Buffer.from(chunk).toString('base64'),
        outputIndex: outputIndex++
      }
    } else if (typeof chunk === 'string') {
      try {
        const tick = JSON.parse(chunk) as Record<string, unknown>
        if ('step' in tick) {
          yield {
            type: 'videoStream',
            step: tick['step'] as number,
            totalSteps: tick['total'] as number,
            elapsedMs: tick['elapsed_ms'] as number
          }
        }
      } catch {
        // Non-JSON string output — skip
      }
    }
  }
  drained = true

  const responseWithStats = response as unknown as ResponseWithStats
  return { stats: toVideoStats(responseWithStats.stats) }
}
