import test from 'brittle'
import Buffer from 'bare-buffer'
import { registerModel, unregisterModel, type AnyModel } from '@/runtime/model-registry'
import { transcribeStream } from '@/plugins/ops/transcribe'
import { parakeetPlugin } from '@/plugins/builtin/parakeet-transcription/plugin'
import { whisperPlugin } from '@/plugins/builtin/whispercpp-transcription/plugin'
import {
  ModelType,
  type CanonicalModelType,
  type TranscribeStats,
  type TranscribeStreamResponse
} from '@/schemas/index'

const ADDON_STATS = {
  audioDurationMs: 1250,
  realTimeFactor: 0.4,
  encoderMs: 12,
  decoderMs: 18
}

function createStreamingModel(onAwait?: () => void) {
  return {
    addon: {
      async cancel() {}
    },
    async runStreaming() {
      return {
        stats: ADDON_STATS,
        async *iterate() {
          yield { text: 'hello', startMs: 0, endMs: 100 }
        },
        async await() {
          onAwait?.()
        }
      }
    }
  } as unknown as AnyModel
}

function registerStreamingModel(modelId: string, modelType: CanonicalModelType, model: AnyModel) {
  registerModel(modelId, {
    model,
    path: '',
    config: {},
    modelType
  })
}

async function collectFrames(
  stream: AsyncIterable<TranscribeStreamResponse>
): Promise<TranscribeStreamResponse[]> {
  const frames: TranscribeStreamResponse[] = []
  for await (const frame of stream) {
    frames.push(frame)
  }
  return frames
}

function emptyInput(): AsyncIterable<Buffer> {
  return (async function* () {})()
}

test('transcribeStream returns normalized terminal stats after awaiting the addon response', async (t) => {
  const modelId = 'transcribe-stream-stats-op'
  let awaited = false
  registerStreamingModel(
    modelId,
    ModelType.parakeetTranscription,
    createStreamingModel(() => {
      awaited = true
    })
  )
  t.teardown(() => unregisterModel(modelId))

  const stream = transcribeStream(modelId, emptyInput(), undefined, false)
  const first = await stream.next()
  const terminal = await stream.next()

  t.is(first.value, 'hello')
  t.is(terminal.done, true)
  t.is(awaited, true)
  t.alike((terminal.value as { stats?: TranscribeStats }).stats, {
    audioDuration: 1250,
    realTimeFactor: 0.4,
    encoderTime: 12,
    decoderTime: 18
  })
})

test('parakeet duplex handler forwards stats on its terminal frame', async (t) => {
  const modelId = 'transcribe-stream-stats-parakeet'
  registerStreamingModel(modelId, ModelType.parakeetTranscription, createStreamingModel())
  t.teardown(() => unregisterModel(modelId))

  const frames = await collectFrames(
    parakeetPlugin.handlers.transcribeStream.handler(
      { type: 'transcribeStream', modelId },
      emptyInput()
    ) as unknown as AsyncIterable<TranscribeStreamResponse>
  )

  t.is(frames[0]?.text, 'hello')
  t.alike(frames.at(-1)?.stats, {
    audioDuration: 1250,
    realTimeFactor: 0.4,
    encoderTime: 12,
    decoderTime: 18
  })
  t.is(frames.at(-1)?.done, true)
})

test('whisper duplex handler forwards stats on its terminal frame', async (t) => {
  const modelId = 'transcribe-stream-stats-whisper'
  registerStreamingModel(modelId, ModelType.whispercppTranscription, createStreamingModel())
  t.teardown(() => unregisterModel(modelId))

  const frames = await collectFrames(
    whisperPlugin.handlers.transcribeStream.handler(
      { type: 'transcribeStream', modelId },
      emptyInput()
    ) as unknown as AsyncIterable<TranscribeStreamResponse>
  )

  t.is(frames[0]?.text, 'hello')
  t.alike(frames.at(-1)?.stats, {
    audioDuration: 1250,
    realTimeFactor: 0.4,
    encoderTime: 12,
    decoderTime: 18
  })
  t.is(frames.at(-1)?.done, true)
})
