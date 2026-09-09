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
import { bindTtsCancel } from '@/plugins/builtin/tts-ggml/ops/cancel-binding'

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

export async function* textToSpeech(
  params: TtsRequest
): AsyncGenerator<TtsOpYield, { modelExecutionMs: number; stats?: TtsStats }> {
  const request = ttsRequestSchema.parse(params)
  const {
    modelId,
    inputType,
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
  if (ctx.signal.aborted) return buildStreamResult(0)

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
      for await (const data of response.iterate()) {
        // lunte-disable-next-line eqeqeq -- `!= null` intentionally matches null and undefined
        if (data.outputArray != null) {
          sampleRate ??= data.sampleRate
          completeBuffer = completeBuffer.concat(Array.from(data.outputArray))
        }
      }
      const modelExecutionMs = nowMs() - modelStart
      const stats = collectTtsStats(response)
      yield { buffer: completeBuffer, ...(sampleRate !== undefined ? { sampleRate } : {}) }
      return buildStreamResult(modelExecutionMs, hasDefinedValues(stats) ? stats : undefined)
    }

    for await (const data of response.iterate()) {
      // lunte-disable-next-line eqeqeq -- `== null` intentionally matches null and undefined
      if (data.outputArray == null) continue
      const buf = Array.from(data.outputArray)
      if (buf.length === 0) continue
      yield { buffer: buf, ...chunkMetadata(data) }
    }

    const modelExecutionMs = nowMs() - modelStart
    const stats = collectTtsStats(response)
    return buildStreamResult(modelExecutionMs, hasDefinedValues(stats) ? stats : undefined)
  }

  const response = (await model.run({
    input: text,
    // The addon's job field is `type`; `inputType` was never read. (The native
    // layer ignores it today, so this is wiring, not a behaviour change.)
    type: inputType,
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

    for await (const data of response.iterate()) {
      sampleRate ??= data.sampleRate
      completeBuffer = completeBuffer.concat(Array.from(data.outputArray))
    }

    const modelExecutionMs = nowMs() - modelStart
    const stats = collectTtsStats(response)

    yield { buffer: completeBuffer, ...(sampleRate !== undefined ? { sampleRate } : {}) }
    return buildStreamResult(modelExecutionMs, hasDefinedValues(stats) ? stats : undefined)
  }

  for await (const data of response.iterate()) {
    yield { buffer: Array.from(data.outputArray), ...chunkMetadata(data) }
  }

  const modelExecutionMs = nowMs() - modelStart
  const stats = collectTtsStats(response)

  return buildStreamResult(modelExecutionMs, hasDefinedValues(stats) ? stats : undefined)
}
