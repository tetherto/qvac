import { requestParent, type PluginHandlerContext } from '@/schemas/plugin'
import { getModel } from '@/runtime/model-registry'
import Buffer from 'bare-buffer'
import type ImgStableDiffusion from '@qvac/diffusion-cpp'
import { getRequestRegistry, withRequestContext } from '@/runtime'
import { generateRandomRequestId } from '@/runtime/request-id'
import { getEngineLogger } from '@/logging'
import { InferenceCancelledError } from '@/errors'
import type {
  DiffusionRequest,
  DiffusionStreamResponse,
  DiffusionStats
} from '@/schemas/sdcpp-config'
import type { TrackedRequest } from '@/schemas/request-base'

interface ResponseWithStats {
  stats?: DiffusionStats
}

export type DiffusionOpResult = { requestId: string; stats: DiffusionStats | undefined }

export async function* diffusion(
  request: DiffusionRequest & TrackedRequest,
  context?: PluginHandlerContext
): AsyncGenerator<DiffusionStreamResponse, DiffusionOpResult> {
  await using ctx = await getRequestRegistry().begin({
    requestId: request.requestId ?? generateRandomRequestId(),
    sessionId: request.sessionId,
    ...requestParent(context),
    kind: 'diffusion',
    modelId: request.modelId
  })
  if (ctx.signal.aborted) throw new InferenceCancelledError(ctx.requestId)
  const model = getModel(request.modelId)
  const cancellable = model as typeof model & Pick<ImgStableDiffusion, 'cancel'>
  const logger = withRequestContext(getEngineLogger(), ctx)

  let cancelPromise: Promise<void> | undefined
  const onAbort = () => {
    cancelPromise ??= cancellable.cancel().catch((error: unknown) => {
      logger.warn(`Diffusion cancel failed: ${String(error)}`)
    })
  }
  ctx.signal.addEventListener('abort', onAbort, { once: true })
  ctx.scope.defer(async () => {
    ctx.signal.removeEventListener('abort', onAbort)
    // A delayed native cancel must finish before another request owns the model.
    await cancelPromise
  })
  if (ctx.signal.aborted) throw new InferenceCancelledError(ctx.requestId)

  const initImage = request.initImage ? Buffer.from(request.initImage, 'base64') : undefined

  const initImages = request.initImages
    ? request.initImages.map((b64) => Buffer.from(b64, 'base64'))
    : undefined

  try {
    const response = await model.run({
      prompt: request.prompt,
      negative_prompt: request.negativePrompt,
      width: request.width,
      height: request.height,
      steps: request.steps,
      cfg_scale: request.cfgScale,
      img_cfg_scale: request.imgCfgScale ?? -1,
      guidance: request.guidance,
      sampling_method: request.samplingMethod,
      scheduler: request.scheduler,
      custom_sigmas: request.customSigmas,
      seed: request.seed,
      batch_count: request.batchCount,
      vae_tiling: request.vaeTiling,
      vae_tile_size: request.vaeTileSize,
      cache_preset: request.cachePreset,
      init_image: initImage,
      init_images: initImages,
      increase_ref_index: request.increaseRefIndex,
      auto_resize_ref_image: request.autoResizeRefImage,
      strength: request.strength,
      lora: request.lora,
      upscale: request.upscale === false ? undefined : request.upscale
    })

    // Keep ownership until native work settles, including an early consumer exit.
    let drained = false
    ctx.scope.defer(async () => {
      if (drained) return
      onAbort()
      try {
        await response.await()
      } catch {
        // The stream carries the original failure or cancellation.
      }
    })

    let outputIndex = 0

    for await (const chunk of response.iterate()) {
      if (ctx.signal.aborted) continue
      if (chunk instanceof Uint8Array) {
        yield {
          type: 'diffusionStream',
          data: Buffer.from(chunk).toString('base64'),
          outputIndex: outputIndex++
        }
      } else if (typeof chunk === 'string') {
        try {
          const tick = JSON.parse(chunk) as Record<string, unknown>
          if ('step' in tick) {
            yield {
              type: 'diffusionStream',
              step: tick['step'] as number,
              totalSteps: tick['total'] as number,
              elapsedMs: tick['elapsed_ms'] as number
            }
          }
        } catch {
          // Ignore non-JSON output.
        }
      }
    }
    drained = true
    if (ctx.signal.aborted) throw new InferenceCancelledError(ctx.requestId)

    const responseWithStats = response as typeof response & ResponseWithStats
    return { requestId: ctx.requestId, stats: responseWithStats.stats ?? undefined }
  } catch (error) {
    if (ctx.signal.aborted) {
      if (error instanceof InferenceCancelledError) throw error
      throw new InferenceCancelledError(ctx.requestId, {}, error)
    }
    ctx.state = 'failed'
    throw error
  }
}
