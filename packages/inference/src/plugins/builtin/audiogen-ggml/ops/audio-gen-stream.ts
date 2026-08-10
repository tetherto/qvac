import { AudioGen } from '@qvac/audiogen-ggml'
import Buffer from 'bare-buffer'
import {
  audioGenStatsSchema,
  type AudioGenStreamRequest,
  type AudioGenStreamResponse
} from '@/schemas/audio-gen'
import { getEngineLogger } from '@/logging/index'
import { getModel } from '@/runtime/model-registry'
import { getRequestRegistry, withRequestContext } from '@/runtime/index'
import { generateRandomRequestId } from '@/runtime/request-id'
import { ModelOperationNotSupportedError } from '@/errors/index'

export async function* audioGenStream(
  request: AudioGenStreamRequest
): AsyncGenerator<AudioGenStreamResponse> {
  await using ctx = await getRequestRegistry().begin({
    requestId: request.requestId ?? generateRandomRequestId(),
    kind: 'audiogen',
    modelId: request.modelId
  })
  const logger = withRequestContext(getEngineLogger(), ctx)
  const candidate = getModel(request.modelId)

  if (!(candidate instanceof AudioGen)) {
    throw new ModelOperationNotSupportedError(
      request.modelId,
      'audiogen-ggml',
      'audioGenStream',
      [],
      []
    )
  }
  const model: AudioGen = candidate

  // A queued request can resume from begin() already aborted. It never owned
  // the model slot, so calling the model-scoped cancel here would interrupt
  // the earlier same-model generation that still owns it.
  if (ctx.signal.aborted) {
    yield {
      type: 'audioGenStream',
      done: true,
      stopReason: 'cancelled'
    }
    return
  }

  let cancelPromise: Promise<void> | undefined
  const onAbort = () => {
    cancelPromise ??= model.cancel().catch((error: unknown) => {
      logger.warn(
        `[cancel] model.cancel() rejected during abort for modelId=${request.modelId}: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    })
  }
  ctx.signal.addEventListener('abort', onAbort, { once: true })
  if (ctx.signal.aborted) onAbort()
  ctx.scope.defer(async () => {
    ctx.signal.removeEventListener('abort', onAbort)
    await cancelPromise
  })

  let response!: Awaited<ReturnType<AudioGen['run']>>
  try {
    if (!ctx.signal.aborted) {
      response = await model.run(request.caption, {
        ...(request.lyrics !== undefined && { lyrics: request.lyrics }),
        ...(request.seed !== undefined && { seed: request.seed }),
        ...(request.vocalLanguage !== undefined && { vocalLanguage: request.vocalLanguage }),
        ...(request.bpm !== undefined && { bpm: request.bpm }),
        ...(request.keyscale !== undefined && { keyscale: request.keyscale }),
        ...(request.timesignature !== undefined && { timesignature: request.timesignature }),
        ...(request.duration !== undefined && { duration: request.duration })
      })

      for await (const chunk of response.iterate()) {
        if (ctx.signal.aborted) break

        if ('progress' in chunk) {
          yield {
            type: 'audioGenStream',
            progress: chunk.progress,
            done: false
          }
          continue
        }

        const pcm = new Uint8Array(
          chunk.outputArray.buffer,
          chunk.outputArray.byteOffset,
          chunk.outputArray.byteLength
        )
        yield {
          type: 'audioGenStream',
          data: Buffer.from(pcm).toString('base64'),
          sampleRate: chunk.sampleRate,
          channels: chunk.channels,
          bitsPerSample: Int16Array.BYTES_PER_ELEMENT * 8,
          done: false
        }
      }
    }
  } catch (error) {
    if (!ctx.signal.aborted) throw error
  }

  if (ctx.signal.aborted) {
    yield {
      type: 'audioGenStream',
      done: true,
      stopReason: 'cancelled'
    }
    return
  }

  const stats = audioGenStatsSchema.parse(await response.await())
  yield {
    type: 'audioGenStream',
    done: true,
    stopReason: 'completed',
    stats
  }
}
