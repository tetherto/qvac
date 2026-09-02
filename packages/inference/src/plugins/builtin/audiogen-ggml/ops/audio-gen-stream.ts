import { AudioGen, audiogenBackendName } from '@qvac/audiogen-ggml'
import {
  audioGenStatsSchema,
  type AudioGenStats,
  type AudioGenStreamRequest,
  type AudioGenStreamResponse
} from '@/schemas/audio-gen'
import { graphicsDriverSchema, type InferenceBackendDiagnostics } from '@/schemas/index'
import { getEngineLogger } from '@/logging/index'
import { attachBackendDiagnostics } from '@/profiling/backend-diagnostics'
import { resolveAudioGenPcm } from '@/plugins/builtin/audiogen-ggml/ops/audio-gen-input'
import { getModel } from '@/runtime/model-registry'
import { getRequestRegistry, withRequestContext } from '@/runtime/index'
import { generateRequestId } from '@/runtime/request-id'
import { ModelOperationNotSupportedError } from '@/errors/index'

export async function* audioGenStream(
  request: AudioGenStreamRequest
): AsyncGenerator<AudioGenStreamResponse> {
  await using ctx = await getRequestRegistry().begin({
    requestId: request.requestId ?? generateRequestId(),
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
    // Reference/source audio is decoded before the run is admitted so the
    // model slot is never held by a request that fails on input decoding.
    // Decoding can take real time, so the abort state is re-checked after it:
    // an abort that fired mid-decode found no active native job to cancel, and
    // starting the run afterwards would leave a ghost generation on the slot.
    const { referenceAudio, sourceAudio } = ctx.signal.aborted
      ? {}
      : await resolveAudioInputs(request, logger)
    if (!ctx.signal.aborted) {
      response = await model.run(request.caption, {
        ...(request.lyrics !== undefined && { lyrics: request.lyrics }),
        ...(request.seed !== undefined && { seed: request.seed }),
        ...(request.vocalLanguage !== undefined && { vocalLanguage: request.vocalLanguage }),
        ...(request.bpm !== undefined && { bpm: request.bpm }),
        ...(request.keyscale !== undefined && { keyscale: request.keyscale }),
        ...(request.timesignature !== undefined && { timesignature: request.timesignature }),
        ...(request.duration !== undefined && { duration: request.duration }),
        ...(request.maxFrames !== undefined && { maxFrames: request.maxFrames }),
        ...(request.inferenceSteps !== undefined && { inferenceSteps: request.inferenceSteps }),
        ...(request.cfgScale !== undefined && { cfgScale: request.cfgScale }),
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
  const diagnostics = buildBackendDiagnostics(stats)
  const terminal: AudioGenStreamResponse = {
    type: 'audioGenStream',
    done: true,
    stopReason: 'completed',
    stats,
    ...(diagnostics && { diagnostics })
  }
  yield diagnostics ? attachBackendDiagnostics(terminal, diagnostics) : terminal
}

/** An unrecognized GPU id yields no diagnostics rather than a guessed backend name. */
function buildBackendDiagnostics(stats: AudioGenStats): InferenceBackendDiagnostics | undefined {
  if (stats.backendDevice === undefined) return undefined
  if (stats.backendDevice !== 1) return { selectedBackend: 'cpu', selectedDevice: 'cpu' }

  // A 'cpu' name against backendDevice 1 is the addon contradicting itself.
  const selectedBackend = audiogenBackendName(stats.backendId)
  if (selectedBackend === undefined || selectedBackend === 'cpu') return undefined

  const graphicsApi = graphicsDriverSchema.safeParse(selectedBackend)
  return {
    selectedBackend,
    selectedDevice: 'gpu',
    ...(graphicsApi.success && { graphicsApi: graphicsApi.data })
  }
}

/**
 * Decode both optional audio inputs concurrently. When both fail, the first
 * failure is thrown and the second is logged so neither diagnostic is lost.
 */
async function resolveAudioInputs(
  request: AudioGenStreamRequest,
  logger: ReturnType<typeof withRequestContext>
) {
  const [reference, source] = await Promise.allSettled([
    request.referenceAudio
      ? resolveAudioGenPcm(request.referenceAudio, 'referenceAudio')
      : Promise.resolve(undefined),
    request.sourceAudio
      ? resolveAudioGenPcm(request.sourceAudio, 'sourceAudio')
      : Promise.resolve(undefined)
  ])
  const failures = [reference, source].filter(
    (result): result is PromiseRejectedResult => result.status === 'rejected'
  )
  if (failures.length > 0) {
    for (const extra of failures.slice(1)) {
      logger.warn(
        `[audiogen] additional audio input failure for modelId=${request.modelId}: ${
          extra.reason instanceof Error ? extra.reason.message : String(extra.reason)
        }`
      )
    }
    throw failures[0]!.reason
  }
  return {
    referenceAudio: reference.status === 'fulfilled' ? reference.value : undefined,
    sourceAudio: source.status === 'fulfilled' ? source.value : undefined
  }
}
