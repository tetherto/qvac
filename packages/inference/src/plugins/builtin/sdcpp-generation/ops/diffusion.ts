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

interface ResponseWithStats {
  stats?: DiffusionStats
}

export type DiffusionOpResult = { stats: DiffusionStats | undefined }

export async function* diffusion(
  request: DiffusionRequest
): AsyncGenerator<DiffusionStreamResponse, DiffusionOpResult> {
  await using ctx = await getRequestRegistry().begin({
    requestId: generateRandomRequestId(),
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

  const init_image = request.init_image ? Buffer.from(request.init_image, 'base64') : undefined

  const init_images = request.init_images
    ? request.init_images.map((b64) => Buffer.from(b64, 'base64'))
    : undefined

  try {
    const response = await model.run({
      prompt: request.prompt,
      negative_prompt: request.negative_prompt,
      width: request.width,
      height: request.height,
      steps: request.steps,
      cfg_scale: request.cfg_scale,
      img_cfg_scale: request.img_cfg_scale ?? -1,
      guidance: request.guidance,
      sampling_method: request.sampling_method,
      scheduler: request.scheduler,
      seed: request.seed,
      batch_count: request.batch_count,
      vae_tiling: request.vae_tiling,
      cache_preset: request.cache_preset,
      init_image,
      init_images,
      increase_ref_index: request.increase_ref_index,
      auto_resize_ref_image: request.auto_resize_ref_image,
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
    return { stats: responseWithStats.stats ?? undefined }
  } catch (error) {
    if (ctx.signal.aborted) {
      if (error instanceof InferenceCancelledError) throw error
      throw new InferenceCancelledError(ctx.requestId, {}, error)
    }
    ctx.state = 'failed'
    throw error
  }
}
