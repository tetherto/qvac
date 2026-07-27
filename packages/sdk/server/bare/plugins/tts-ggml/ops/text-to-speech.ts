import { getModel } from '@/server/bare/registry/model-registry'
import { ttsRequestSchema, type TtsRequest, type TtsStats } from '@/schemas'
import { nowMs } from '@/profiling'
import { buildStreamResult, hasDefinedValues } from '@/profiling/model-execution'
import type { TtsResponse } from '@/server/bare/types/addon-responses'
import { TextToSpeechFailedError } from '@/utils/errors-server'
import {
  type TtsStreamChunk,
  type TtsOpYield,
  collectTtsStats
} from '@/server/bare/utils/tts-stats'

type ParlerJobOptions = Pick<
  TtsRequest,
  | 'description'
  | 'voiceDescription'
  | 'voice'
  | 'emotion'
  | 'pitch'
  | 'pace'
  | 'expressivity'
  | 'noise'
  | 'reverb'
  | 'quality'
>

type RunStreamModel = {
  runStream: (
    text: string,
    options?: ParlerJobOptions & { locale?: string; maxChunkScalars?: number }
  ) => Promise<{
    iterate: () => AsyncIterable<TtsStreamChunk>
    stats?: {
      audioDurationMs?: number
      totalSamples?: number
      enhancerBackendDevice?: number
      enhancerBackendId?: number
    }
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

function getParlerJobOptions(request: TtsRequest): ParlerJobOptions {
  return {
    ...(request.description !== undefined ? { description: request.description } : {}),
    ...(request.voiceDescription !== undefined
      ? { voiceDescription: request.voiceDescription }
      : {}),
    ...(request.voice !== undefined ? { voice: request.voice } : {}),
    ...(request.emotion !== undefined ? { emotion: request.emotion } : {}),
    ...(request.pitch !== undefined ? { pitch: request.pitch } : {}),
    ...(request.pace !== undefined ? { pace: request.pace } : {}),
    ...(request.expressivity !== undefined ? { expressivity: request.expressivity } : {}),
    ...(request.noise !== undefined ? { noise: request.noise } : {}),
    ...(request.reverb !== undefined ? { reverb: request.reverb } : {}),
    ...(request.quality !== undefined ? { quality: request.quality } : {})
  }
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
      for await (const data of response.iterate()) {
        if (data.outputArray != null) {
          completeBuffer = completeBuffer.concat(Array.from(data.outputArray))
        }
      }
      const modelExecutionMs = nowMs() - modelStart
      const stats = collectTtsStats(response)
      yield { buffer: completeBuffer }
      return buildStreamResult(modelExecutionMs, hasDefinedValues(stats) ? stats : undefined)
    }

    for await (const data of response.iterate()) {
      if (data.outputArray == null) continue
      const buf = Array.from(data.outputArray)
      if (buf.length === 0) continue
      yield {
        buffer: buf,
        ...(data.chunkIndex !== undefined ? { chunkIndex: data.chunkIndex } : {}),
        ...(typeof data.sentenceChunk === 'string' && data.sentenceChunk.length > 0
          ? { sentenceChunk: data.sentenceChunk }
          : {})
      }
    }

    const modelExecutionMs = nowMs() - modelStart
    const stats = collectTtsStats(response)
    return buildStreamResult(modelExecutionMs, hasDefinedValues(stats) ? stats : undefined)
  }

  const response = (await model.run({
    input: text,
    inputType,
    ...(stream ? { streamOutput: true } : {}),
    ...parlerJobOptions
  })) as unknown as TtsResponse

  if (!stream) {
    let completeBuffer: number[] = []

    for await (const data of response.iterate()) {
      completeBuffer = completeBuffer.concat(Array.from(data.outputArray))
    }

    const modelExecutionMs = nowMs() - modelStart
    const stats = collectTtsStats(response)

    yield { buffer: completeBuffer }
    return buildStreamResult(modelExecutionMs, hasDefinedValues(stats) ? stats : undefined)
  }

  for await (const data of response.iterate()) {
    yield { buffer: Array.from(data.outputArray) }
  }

  const modelExecutionMs = nowMs() - modelStart
  const stats = collectTtsStats(response)

  return buildStreamResult(modelExecutionMs, hasDefinedValues(stats) ? stats : undefined)
}
