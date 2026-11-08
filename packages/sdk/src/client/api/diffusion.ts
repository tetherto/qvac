import {
  diffusionStreamResponseSchema,
  type DiffusionStreamRequest,
  type DiffusionClientParams,
  type DiffusionStats
} from '@qvac/inference/surface'
import { stream as streamRpc } from '@/client/rpc/rpc-client'
import { decodeBase64, encodeBase64 } from '@/utils/encoding'

export interface DiffusionProgressTick {
  step: number
  totalSteps: number
  elapsedMs: number
}

interface DiffusionResult {
  progressStream: AsyncGenerator<DiffusionProgressTick>
  outputs: Promise<Uint8Array[]>
  stats: Promise<DiffusionStats | undefined>
}

/**
 * Generates images using a loaded diffusion model.
 *
 * @throws {InferenceCancelledError} The run's promises reject and progress stream throws when an active generation is cancelled.
 *
 * @throws {RequestRejectedByPolicyError} The run rejects when another image or video generation owns the model.
 *
 * Supports txt2img without input images, img2img via `init_image`,
 * and ordered multi-reference editing via `init_images` on supported models.
 */
export function diffusion(params: DiffusionClientParams): DiffusionResult {
  const { init_image, init_images, ...rest } = params

  const request: DiffusionStreamRequest = {
    ...rest,
    ...(init_image !== undefined && { init_image: encodeBase64(init_image) }),
    ...(init_images !== undefined && {
      init_images: init_images.map(encodeBase64)
    }),
    type: 'diffusionStream'
  }

  let statsResolver: (value: DiffusionStats | undefined) => void = () => {}
  let statsRejecter: (error: unknown) => void = () => {}
  const statsPromise = new Promise<DiffusionStats | undefined>((resolve, reject) => {
    statsResolver = resolve
    statsRejecter = reject
  })
  statsPromise.catch(() => {})

  const progressQueue: DiffusionProgressTick[] = []
  const collectedBuffers: Uint8Array[] = []
  let progressDone = false
  let progressResolve: (() => void) | null = null
  let streamError: Error | null = null

  let outputsResolver: (value: Uint8Array[]) => void = () => {}
  let outputsRejecter: (error: unknown) => void = () => {}
  const outputsPromise = new Promise<Uint8Array[]>((resolve, reject) => {
    outputsResolver = resolve
    outputsRejecter = reject
  })
  outputsPromise.catch(() => {})

  const processResponses = async () => {
    try {
      for await (const response of streamRpc(request)) {
        if (
          response &&
          typeof response === 'object' &&
          'type' in response &&
          response.type === 'diffusionStream'
        ) {
          const parsed = diffusionStreamResponseSchema.parse(response)

          if (
            parsed.step !== undefined &&
            parsed.totalSteps !== undefined &&
            parsed.elapsedMs !== undefined
          ) {
            progressQueue.push({
              step: parsed.step,
              totalSteps: parsed.totalSteps,
              elapsedMs: parsed.elapsedMs
            })
            if (progressResolve) {
              progressResolve()
              progressResolve = null
            }
          }

          if (parsed.data) {
            collectedBuffers.push(decodeBase64(parsed.data))
          }

          if (parsed.done) {
            statsResolver(parsed.stats)
            outputsResolver(collectedBuffers)
          }
        }
      }
    } catch (error) {
      streamError = error instanceof Error ? error : new Error(String(error))
      statsRejecter(streamError)
      outputsRejecter(streamError)
    }

    progressDone = true
    if (progressResolve) {
      progressResolve()
      progressResolve = null
    }
  }

  void processResponses()

  const progressStream = (async function* (): AsyncGenerator<DiffusionProgressTick> {
    while (true) {
      if (progressQueue.length > 0) {
        yield progressQueue.shift()!
      } else if (progressDone) {
        if (streamError) throw streamError as Error
        return
      } else {
        await new Promise<void>((resolve) => {
          progressResolve = resolve
        })
      }
    }
  })()

  return {
    progressStream,
    outputs: outputsPromise,
    stats: statsPromise
  }
}
