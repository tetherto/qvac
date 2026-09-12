import type { AbortSignal } from 'bare-abort-controller'
import { getModel } from '@/runtime/model-registry'
import { textToSpeechStreamRequestSchema, type TextToSpeechStreamRequest } from '@/schemas/index'
import Buffer from 'bare-buffer'
import { nowMs } from '@/profiling/index'
import { buildStreamResult, hasDefinedValues } from '@/profiling/model-execution'
import { TextToSpeechStreamFailedError } from '@/errors/index'
import type { TtsStats as AddonTtsStats } from '@/utils/addon-responses'
import {
  type TtsStreamChunk,
  type TtsOpYield,
  collectTtsStats,
  chunkMetadata
} from '@/utils/tts-stats'
import {
  assertParlerJobOptionsSupported,
  getParlerJobOptions
} from '@/plugins/builtin/tts-ggml/ops/parler-options'
import { bindTtsCancel, cancelIfAborted } from '@/plugins/builtin/tts-ggml/ops/cancel-binding'
import type { TtsOpResult } from '@/plugins/builtin/tts-ggml/ops/text-to-speech'

// Ends the text source the moment the run is cancelled. Without this an idle
// duplex session — cancelled while the accumulator is waiting for the next
// fragment, with no native job live — would sit in `runStreaming` holding the
// model's slot until the client wrote more text, and then synthesise it.
async function* untilAborted<T>(
  source: AsyncIterable<T>,
  signal: AbortSignal
): AsyncGenerator<T, void, unknown> {
  const iterator = source[Symbol.asyncIterator]()
  const aborted = new Promise<IteratorResult<T>>((resolve) => {
    const end = () => resolve({ done: true, value: undefined })
    if (signal.aborted) end()
    else signal.addEventListener('abort', end, { once: true })
  })
  try {
    while (true) {
      const next = await Promise.race([iterator.next(), aborted])
      if (next.done) return
      yield next.value
    }
  } finally {
    await iterator.return?.()
  }
}

type RunStreamingModel = {
  runStreaming: (
    textStream: AsyncIterable<string>,
    options?: Record<string, unknown>
  ) => Promise<{
    iterate: () => AsyncIterable<TtsStreamChunk>
    stats?: AddonTtsStats
  }>
}

function hasRunStreaming(model: unknown): model is RunStreamingModel {
  return (
    typeof model === 'object' &&
    model !== null &&
    'runStreaming' in model &&
    typeof (model as RunStreamingModel).runStreaming === 'function'
  )
}

function findLastCompleteUtf8End(buf: Buffer): number {
  const len = buf.length
  for (let i = len - 1; i >= 0 && i >= len - 3; i--) {
    const b = buf[i] as number
    if ((b & 0x80) === 0) {
      return i + 1
    }
    if ((b & 0xc0) === 0xc0) {
      let expected: number
      if ((b & 0xe0) === 0xc0) expected = 2
      else if ((b & 0xf0) === 0xe0) expected = 3
      else if ((b & 0xf8) === 0xf0) expected = 4
      else return len
      return i + expected <= len ? len : i
    }
  }
  return len
}

async function* buffersToUtf8Fragments(
  inputStream: AsyncIterable<Buffer>
): AsyncGenerator<string, void, unknown> {
  let pending: Buffer = Buffer.alloc(0)
  for await (const buf of inputStream) {
    const combined = pending.length === 0 ? buf : Buffer.concat([pending, buf])
    const completeEnd = findLastCompleteUtf8End(combined)
    if (completeEnd > 0) {
      const s = (combined.subarray(0, completeEnd) as Buffer).toString('utf8')
      if (s.length > 0) {
        yield s
      }
    }
    pending =
      completeEnd < combined.length ? Buffer.from(combined.subarray(completeEnd)) : Buffer.alloc(0)
  }
  if (pending.length > 0) {
    const s = pending.toString('utf8')
    if (s.length > 0) {
      yield s
    }
  }
}

function buildRunStreamingOptions(
  request: TextToSpeechStreamRequest,
  parlerJobOptions: ReturnType<typeof getParlerJobOptions>
) {
  const o: Record<string, unknown> = {}
  if (request.accumulateSentences !== undefined) {
    o['accumulateSentences'] = request.accumulateSentences
  }
  if (request.sentenceDelimiterPreset !== undefined) {
    o['sentenceDelimiterPreset'] = request.sentenceDelimiterPreset
  }
  if (request.maxBufferScalars !== undefined) {
    o['maxBufferScalars'] = request.maxBufferScalars
  }
  if (request.flushAfterMs !== undefined) {
    o['flushAfterMs'] = request.flushAfterMs
  }
  return { ...o, ...parlerJobOptions }
}

export async function* textToSpeechStream(
  params: TextToSpeechStreamRequest,
  inputStream: AsyncIterable<Buffer>
): AsyncGenerator<TtsOpYield, TtsOpResult, unknown> {
  const request = textToSpeechStreamRequestSchema.parse(params)

  const model = getModel(request.modelId)
  const parlerJobOptions = getParlerJobOptions(request)
  assertParlerJobOptionsSupported(model, parlerJobOptions, 'textToSpeechStream')

  await using ctx = await bindTtsCancel(model, request.modelId, request.requestId)
  if (ctx.signal.aborted) return { ...buildStreamResult(0), cancelled: true }

  const modelStart = nowMs()

  if (!hasRunStreaming(model)) {
    throw new TextToSpeechStreamFailedError(
      'textToSpeechStream requires a TTS model with runStreaming'
    )
  }

  const textSource = untilAborted(buffersToUtf8Fragments(inputStream), ctx.signal)
  const streamOpts = buildRunStreamingOptions(request, parlerJobOptions)
  const response = await model.runStreaming(
    textSource,
    Object.keys(streamOpts).length > 0 ? streamOpts : undefined
  )

  try {
    for await (const data of response.iterate()) {
      if (await cancelIfAborted(model, ctx.signal)) continue
      // lunte-disable-next-line eqeqeq -- `== null` intentionally matches null and undefined
      if (data.outputArray == null) {
        continue
      }
      const buf = Array.from(data.outputArray)
      if (buf.length === 0) {
        continue
      }
      yield { buffer: buf, ...chunkMetadata(data) }
    }
  } catch (error) {
    // The addon fails the response with its own 'Job cancelled' error once a
    // cancel lands on a live job; after an abort that is the expected exit.
    if (!ctx.signal.aborted) throw error
  }

  const stats = collectTtsStats(response)
  return {
    ...buildStreamResult(nowMs() - modelStart, hasDefinedValues(stats) ? stats : undefined),
    ...(ctx.signal.aborted ? { cancelled: true } : {})
  }
}
