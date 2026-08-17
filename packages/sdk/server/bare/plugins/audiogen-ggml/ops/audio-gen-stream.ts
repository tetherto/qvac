import { AudioGen } from '@qvac/audiogen-ggml'
import {
  audioGenStatsSchema,
  type AudioGenStreamRequest,
  type AudioGenStreamResponse
} from '@/schemas/audio-gen'
import { getServerLogger } from '@/logging'
import { resolveAudioGenPcm } from '@/server/bare/plugins/audiogen-ggml/ops/audio-gen-input'
import { getModel } from '@/server/bare/registry/model-registry'
import { getRequestRegistry, withRequestContext } from '@/server/bare/runtime'
import { generateServerRequestId } from '@/server/bare/runtime/request-id'
import { ModelOperationNotSupportedError } from '@/utils/errors-server'

export async function* audioGenStream(
  request: AudioGenStreamRequest
): AsyncGenerator<AudioGenStreamResponse> {
  await using ctx = await getRequestRegistry().begin({
    requestId: request.requestId ?? generateServerRequestId(),
    kind: 'audiogen',
    modelId: request.modelId
  })
  const logger = withRequestContext(getServerLogger(), ctx)
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
  if (Boolean(ctx.signal.aborted)) {
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
      // Reference/source audio is decoded before the run is admitted so the
      // model slot is never held by a request that fails on input decoding.
      const [referenceAudio, sourceAudio] = await Promise.all([
        request.referenceAudio && resolveAudioGenPcm(request.referenceAudio, 'referenceAudio'),
        request.sourceAudio && resolveAudioGenPcm(request.sourceAudio, 'sourceAudio')
      ])
      response = await model.run(request.caption, {
        ...(request.lyrics !== undefined && { lyrics: request.lyrics }),
        ...(request.seed !== undefined && { seed: request.seed }),
        ...(request.vocalLanguage !== undefined && { vocalLanguage: request.vocalLanguage }),
        ...(request.bpm !== undefined && { bpm: request.bpm }),
        ...(request.keyscale !== undefined && { keyscale: request.keyscale }),
        ...(request.timesignature !== undefined && { timesignature: request.timesignature }),
        ...(request.duration !== undefined && { duration: request.duration }),
        ...(request.lmTemperature !== undefined && { lmTemperature: request.lmTemperature }),
        ...(request.lmTopP !== undefined && { lmTopP: request.lmTopP }),
        ...(request.lmTopK !== undefined && { lmTopK: request.lmTopK }),
        ...(request.lmCfgScale !== undefined && { lmCfgScale: request.lmCfgScale }),
        ...(request.lmPhase1 !== undefined && { lmPhase1: request.lmPhase1 }),
        ...(request.dcwEnabled !== undefined && { dcwEnabled: request.dcwEnabled }),
        ...(request.dcwScaler !== undefined && { dcwScaler: request.dcwScaler }),
        ...(request.dcwHighScaler !== undefined && { dcwHighScaler: request.dcwHighScaler }),
        ...(request.taskType !== undefined && { taskType: request.taskType }),
        ...(request.audioCoverStrength !== undefined && {
          audioCoverStrength: request.audioCoverStrength
        }),
        ...(request.coverNoiseStrength !== undefined && {
          coverNoiseStrength: request.coverNoiseStrength
        }),
        ...(referenceAudio && { referenceAudio }),
        ...(sourceAudio && { sourceAudio })
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
