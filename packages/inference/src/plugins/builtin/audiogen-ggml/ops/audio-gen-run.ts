import { AudioGen, audiogenBackendName, audiogenGpuFallbackReason } from '@qvac/audiogen-ggml'
import { z } from 'zod'
import {
  audioGenStatsSchema,
  type AudioGenStreamResponse,
  type AudioGenUnderstandResult,
  type AudioUnderstandResponse
} from '@/schemas/audio-gen'
import {
  graphicsDriverSchema,
  type BackendFallback,
  type InferenceBackendDiagnostics
} from '@/schemas/index'
import { getEngineLogger, type Logger } from '@/logging/index'
import { attachBackendDiagnostics } from '@/profiling/backend-diagnostics'
import { getModel } from '@/runtime/model-registry'
import { getRequestRegistry, withRequestContext, type RequestContext } from '@/runtime/index'
import { generateRequestId } from '@/runtime/request-id'
import { ModelOperationNotSupportedError } from '@/errors/index'

/**
 * Wire types that stream an AudioGen run: generation, source-driven editing,
 * and the reverse pipeline behind `audioUnderstand()`.
 */
export type AudioGenRunType = 'audioGenStream' | 'audioEditStream' | 'audioUnderstand'

/**
 * A stream frame for `TType`. Generation and editing share every field but
 * `type`; understanding carries a description instead of PCM.
 *
 * The frames below are built as object literals inside a generic function, so
 * TypeScript cannot match them to the narrowed conditional type on its own —
 * each `yield` asserts the frame it just built. The shapes are pinned at the
 * boundary regardless: every frame is parsed against this handler's response
 * schema before it reaches a caller.
 */
export type AudioGenRunFrame<TType extends AudioGenRunType> = TType extends 'audioUnderstand'
  ? AudioUnderstandResponse
  : Omit<AudioGenStreamResponse, 'type'> & { type: TType }

export type AudioGenRunResponse = Awaited<ReturnType<AudioGen['run']>>

export interface AudioGenRunOptions<TType extends AudioGenRunType> {
  type: TType
  request: { modelId: string; requestId?: string | undefined }
  /**
   * Prepares the inputs and admits the native job once the request holds the
   * model slot. Preparation (decoding audio) can take real time, so the
   * callback must re-check `ctx.signal` after it and return `undefined`
   * without starting the job when an abort fired mid-way: that abort found no
   * active native job to cancel, and starting the run afterwards would leave
   * a ghost generation on the slot.
   */
  start: (
    model: AudioGen,
    ctx: RequestContext,
    logger: Logger
  ) => Promise<AudioGenRunResponse | undefined>
}

/**
 * Runs one AudioGen job under the request registry and streams it as
 * `TType` frames: progress ticks, PCM chunks, then the terminal frame with
 * stats and backend diagnostics. Owns admission (`kind: 'audiogen'`, one
 * active job per model), abort-to-cancel wiring, and the cancelled terminal.
 */
export async function* streamAudioGenRun<TType extends AudioGenRunType>(
  options: AudioGenRunOptions<TType>
): AsyncGenerator<AudioGenRunFrame<TType>> {
  const { type, request } = options
  await using ctx = await getRequestRegistry().begin({
    requestId: request.requestId ?? generateRequestId(),
    kind: 'audiogen',
    modelId: request.modelId
  })
  const logger = withRequestContext(getEngineLogger(), ctx)
  const candidate = getModel(request.modelId)

  if (!(candidate instanceof AudioGen)) {
    throw new ModelOperationNotSupportedError(request.modelId, 'audiogen-ggml', type, [], [])
  }
  const model: AudioGen = candidate

  // A queued request can resume from begin() already aborted. It never owned
  // the model slot, so calling the model-scoped cancel here would interrupt
  // the earlier same-model generation that still owns it.
  if (ctx.signal.aborted) {
    yield { type, done: true, stopReason: 'cancelled' } as AudioGenRunFrame<TType>
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

  let response: AudioGenRunResponse | undefined
  let streamedUnderstand: AudioGenUnderstandResult | undefined
  try {
    response = await options.start(model, ctx, logger)
    if (response !== undefined) {
      for await (const chunk of response.iterate()) {
        if (ctx.signal.aborted) break

        if ('progress' in chunk) {
          yield { type, progress: chunk.progress, done: false } as AudioGenRunFrame<TType>
          continue
        }

        // `understand()` reports a description instead of audio; generation
        // and editing never produce this item.
        if ('understand' in chunk) {
          // The engine repeats this result on the terminal stats, so the
          // converted form is kept rather than rebuilt from the raw codes.
          streamedUnderstand = toUnderstandResult(chunk.understand)
          yield {
            type,
            understand: streamedUnderstand,
            done: false
          } as AudioGenRunFrame<TType>
          continue
        }

        if (!('outputArray' in chunk)) continue

        const pcm = new Uint8Array(
          chunk.outputArray.buffer,
          chunk.outputArray.byteOffset,
          chunk.outputArray.byteLength
        )
        yield {
          type,
          data: Buffer.from(pcm).toString('base64'),
          sampleRate: chunk.sampleRate,
          channels: chunk.channels,
          bitsPerSample: Int16Array.BYTES_PER_ELEMENT * 8,
          done: false
        } as AudioGenRunFrame<TType>
      }
    }
  } catch (error) {
    if (!ctx.signal.aborted) throw error
  }

  if (ctx.signal.aborted || response === undefined) {
    yield { type, done: true, stopReason: 'cancelled' } as AudioGenRunFrame<TType>
    return
  }

  const raw = await response.await()
  // `understand.audioCodes` arrives as an Int32Array, which the wire schema —
  // and anything downstream of JSON — needs as a plain array of integers.
  // Both parses below read the normalized object: handing the raw one to
  // either schema fails its `z.array` check on the typed array.
  const normalized = raw.understand
    ? { ...raw, understand: streamedUnderstand ?? toUnderstandResult(raw.understand) }
    : raw
  const stats = audioGenStatsSchema.parse(normalized)
  const diagnostics = buildBackendDiagnostics(audiogenStats.parse(normalized))
  const terminal = {
    type,
    done: true,
    stopReason: 'completed',
    stats,
    ...(diagnostics && { diagnostics })
  } as AudioGenRunFrame<TType>
  yield diagnostics ? attachBackendDiagnostics(terminal, diagnostics) : terminal
}

// The addon reports gpuFallbackReason, which the wire shape deliberately does
// not carry: it reaches callers named, on diagnostics.fallback.reason.
const audiogenStats = audioGenStatsSchema.extend({
  gpuFallbackReason: z.number().optional()
})

type AudiogenStats = z.infer<typeof audiogenStats>

/**
 * Normalizes the addon's understand result for the wire: `audioCodes` arrives
 * as an `Int32Array`, which neither the schema nor a JSON transport accepts.
 */
function toUnderstandResult(result: {
  caption: string
  bpm: number
  duration: number
  keyscale: string
  timesignature: string
  vocalLanguage: string
  audioCodes: Int32Array | number[]
}): AudioGenUnderstandResult {
  return { ...result, audioCodes: Array.from(result.audioCodes) }
}

/** An unrecognized GPU id yields no diagnostics rather than a guessed backend name. */
function buildBackendDiagnostics(stats: AudiogenStats): InferenceBackendDiagnostics | undefined {
  if (stats.backendDevice === undefined) return undefined
  if (stats.backendDevice !== 1) {
    const fallback = gpuFallbackDetail(stats)
    return { selectedBackend: 'cpu', selectedDevice: 'cpu', ...(fallback && { fallback }) }
  }

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

// `none` and `not-requested` describe a run that never lost a GPU, and an
// unmapped code must not become a guessed reason.
function gpuFallbackDetail(stats: AudiogenStats): BackendFallback | undefined {
  const reason = audiogenGpuFallbackReason(stats.gpuFallbackReason)
  if (reason === undefined || reason === 'none' || reason === 'not-requested') return undefined
  return { requestedDevice: 'gpu', reason }
}
