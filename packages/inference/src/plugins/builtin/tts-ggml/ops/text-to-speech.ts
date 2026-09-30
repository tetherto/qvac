import type { AbortSignal } from 'bare-abort-controller'
import { getModel } from '@/runtime/model-registry'
import { ttsRequestSchema, type TtsRequest, type TtsStats } from '@/schemas/index'
import { nowMs } from '@/profiling/index'
import { buildStreamResult, hasDefinedValues } from '@/profiling/model-execution'
import type { TtsResponse, TtsStats as AddonTtsStats } from '@/utils/addon-responses'
import { TextToSpeechFailedError } from '@/errors/index'
import {
  type TtsStreamChunk,
  type TtsOpYield,
  collectTtsStats,
  chunkMetadata
} from '@/utils/tts-stats'
import {
  assertParlerJobOptionsSupported,
  getParlerJobOptions,
  type ParlerJobOptions
} from '@/plugins/builtin/tts-ggml/ops/parler-options'
import { bindTtsCancel, cancelIfAborted } from '@/plugins/builtin/tts-ggml/ops/cancel-binding'

type RunStreamModel = {
  runStream: (
    text: string,
    options?: ParlerJobOptions & { locale?: string; maxChunkScalars?: number }
  ) => Promise<{
    iterate: () => AsyncIterable<TtsStreamChunk>
    stats?: AddonTtsStats
  }>
}

function hasRunStream(model: unknown): model is RunStreamModel {
  return (
    typeof model === 'object' &&
    model !== null &&
    'runStream' in model &&
    typeof (model as RunStreamModel).runStream === 'function'
  )
}

/** What the handler turns into the terminal frame. */
export type TtsOpResult = { modelExecutionMs: number; stats?: TtsStats; cancelled?: boolean }

function finish(
  modelStart: number,
  response: { stats?: AddonTtsStats },
  cancelled: boolean
): TtsOpResult {
  const stats = collectTtsStats(response)
  return {
    ...buildStreamResult(nowMs() - modelStart, hasDefinedValues(stats) ? stats : undefined),
    ...(cancelled ? { cancelled: true } : {})
  }
}

// The addon fails the response with its own 'Job cancelled' error once a
// cancel lands on a live job. After an abort that is the expected way out,
// not a failure to surface.
function rethrowUnlessCancelled(error: unknown, signal: AbortSignal) {
  if (!signal.aborted) throw error
}

export async function* textToSpeech(params: TtsRequest): AsyncGenerator<TtsOpYield, TtsOpResult> {
  const request = ttsRequestSchema.parse(params)
  const {
    modelId,
    text,
    stream,
    sentenceStream,
    sentenceStreamLocale,
    sentenceStreamMaxChunkScalars
  } = request
  const parlerJobOptions = getParlerJobOptions(request)

  const model = getModel(modelId)
  assertParlerJobOptionsSupported(model, parlerJobOptions, 'textToSpeech')

  await using ctx = await bindTtsCancel(model, modelId, request.requestId)
  if (ctx.signal.aborted) return { ...buildStreamResult(0), cancelled: true }

  const modelStart = nowMs()

  if (sentenceStream) {
    if (!hasRunStream(model)) {
      throw new TextToSpeechFailedError('sentenceStream requires a TTS model with runStream')
    }

    const streamOpts =
      sentenceStreamLocale !== undefined ||
      sentenceStreamMaxChunkScalars !== undefined ||
      Object.keys(parlerJobOptions).length > 0
        ? {
            ...(sentenceStreamLocale !== undefined ? { locale: sentenceStreamLocale } : {}),
            ...(sentenceStreamMaxChunkScalars !== undefined
              ? { maxChunkScalars: sentenceStreamMaxChunkScalars }
              : {}),
            ...parlerJobOptions
          }
        : undefined

    const response = await model.runStream(text, streamOpts)

    if (!stream) {
      let completeBuffer: number[] = []
      let sampleRate: number | undefined
      try {
        for await (const data of response.iterate()) {
          if (await cancelIfAborted(model, ctx.signal)) continue
          // lunte-disable-next-line eqeqeq -- `!= null` intentionally matches null and undefined
          if (data.outputArray != null) {
            sampleRate ??= data.sampleRate
            completeBuffer = completeBuffer.concat(Array.from(data.outputArray))
          }
        }
      } catch (error) {
        rethrowUnlessCancelled(error, ctx.signal)
      }
      // A cancelled collect must not hand back a partial buffer as if complete.
      if (ctx.signal.aborted) return finish(modelStart, response, true)
      yield { buffer: completeBuffer, ...(sampleRate !== undefined ? { sampleRate } : {}) }
      return finish(modelStart, response, false)
    }

    try {
      for await (const data of response.iterate()) {
        if (await cancelIfAborted(model, ctx.signal)) continue
        // lunte-disable-next-line eqeqeq -- `== null` intentionally matches null and undefined
        if (data.outputArray == null) continue
        const buf = Array.from(data.outputArray)
        if (buf.length === 0) continue
        yield { buffer: buf, ...chunkMetadata(data) }
      }
    } catch (error) {
      rethrowUnlessCancelled(error, ctx.signal)
    }
    return finish(modelStart, response, ctx.signal.aborted)
  }

  const response = (await model.run({
    input: text,
    // The addon's job field is `type`, and its native layer accepts only
    // 'text' (AddonJs.hpp runJob) — the addon's own streaming paths hard-code
    // it. Pin it here too, so the request's `inputType` (which the schema
    // does not constrain) behaves the same on every path.
    type: 'text',
    ...(stream ? { streamOutput: true } : {}),
    // `run({ streamOutput: true })` runs the same chunker as `runStream()`, so
    // the chunking knobs apply here too — they used to be honoured only on the
    // sentenceStream path.
    ...(stream && sentenceStreamLocale !== undefined ? { locale: sentenceStreamLocale } : {}),
    ...(stream && sentenceStreamMaxChunkScalars !== undefined
      ? { maxChunkScalars: sentenceStreamMaxChunkScalars }
      : {}),
    ...parlerJobOptions
  })) as unknown as TtsResponse

  if (!stream) {
    let completeBuffer: number[] = []
    let sampleRate: number | undefined

    try {
      for await (const data of response.iterate()) {
        if (await cancelIfAborted(model, ctx.signal)) continue
        sampleRate ??= data.sampleRate
        completeBuffer = completeBuffer.concat(Array.from(data.outputArray))
      }
    } catch (error) {
      rethrowUnlessCancelled(error, ctx.signal)
    }
    if (ctx.signal.aborted) return finish(modelStart, response, true)
    yield { buffer: completeBuffer, ...(sampleRate !== undefined ? { sampleRate } : {}) }
    return finish(modelStart, response, false)
  }

  try {
    for await (const data of response.iterate()) {
      if (await cancelIfAborted(model, ctx.signal)) continue
      yield { buffer: Array.from(data.outputArray), ...chunkMetadata(data) }
    }
  } catch (error) {
    rethrowUnlessCancelled(error, ctx.signal)
  }
  return finish(modelStart, response, ctx.signal.aborted)
}
