import { EsrganUpscaler } from '@qvac/diffusion-cpp'
import Buffer from 'bare-buffer'
import { getModel, getModelEntry } from '@/runtime/model-registry'
import { getRequestRegistry } from '@/runtime/index'
import { generateRandomRequestId } from '@/runtime/request-id'
import { InferenceCancelledError, ModelOperationNotSupportedError } from '@/errors/index'
import { ModelType } from '@/schemas/index'
import type { TrackedRequest } from '@/schemas/request-base'
import type { UpscaleRequest, UpscaleStats, UpscaleStreamResponse } from '@/schemas/sdcpp-config'

interface ResponseWithStats {
  stats?: UpscaleStats
}

// The diffusion plugin instantiates `EsrganUpscaler` when the model is loaded
// with `modelConfig.mode === "upscale"` and `ImgStableDiffusion` otherwise. The
// latter has no `.upscale()` method, so we refuse the call upfront with a
// structured error rather than letting a TypeError propagate.
function asUpscalerModel(model: unknown, modelId: string): EsrganUpscaler {
  if (model instanceof EsrganUpscaler) {
    return model
  }

  const entry = getModelEntry(modelId)
  const modelType = entry ? entry.local.modelType : ModelType.sdcppGeneration
  throw new ModelOperationNotSupportedError(modelId, modelType, 'upscale', ['diffusion'], [])
}

export async function* upscale(
  request: UpscaleRequest & TrackedRequest
): AsyncGenerator<UpscaleStreamResponse> {
  // Registered under the diffusion kind: the upscaler shares the model's single
  // native job slot, so an upscale and a generation on one model queue through
  // the same lane. The addon has no abort hook; a cancel stops delivery and
  // the native pass runs to completion.
  await using ctx = await getRequestRegistry().begin({
    requestId: request.requestId ?? generateRandomRequestId(),
    sessionId: request.sessionId,
    kind: 'diffusion',
    modelId: request.modelId
  })
  if (ctx.signal.aborted) throw new InferenceCancelledError(ctx.requestId)

  const model = asUpscalerModel(getModel(request.modelId), request.modelId)
  const response = await model.upscale(
    Buffer.from(request.image, 'base64'),
    request.repeats === undefined ? undefined : { repeats: request.repeats }
  )

  // The addon emits exactly one final PNG regardless of `repeats`, so
  // this loop typically iterates once. `outputIndex` is still emitted for
  // wire parity with diffusionStream and to leave headroom for future
  // multi-output variants.
  let outputIndex = 0
  for await (const chunk of response.iterate()) {
    if (ctx.signal.aborted) continue
    if (chunk instanceof Uint8Array) {
      yield {
        type: 'upscaleStream',
        data: Buffer.from(chunk).toString('base64'),
        outputIndex: outputIndex++
      }
    }
  }
  if (ctx.signal.aborted) throw new InferenceCancelledError(ctx.requestId)

  const responseWithStats = response as unknown as ResponseWithStats
  yield {
    type: 'upscaleStream',
    requestId: ctx.requestId,
    done: true,
    stats: responseWithStats.stats ?? undefined
  }
}
