import test from 'brittle'
import Buffer from 'bare-buffer'
import { registerModel, unregisterModel } from '@/runtime/model-registry'
import { ttsPlugin } from '@/plugins/builtin/tts-ggml/plugin'
import { ttsResponseSchema, textToSpeechStreamResponseSchema } from '@/schemas/index'
import { decodeTtsPcm } from '@/schemas/tts-pcm'

// The ops hand int16 engine audio to the handlers as base64 `pcm` with an
// empty `buffer`. The handlers must put that `pcm` on the wire frame: a client
// decodes it back into `buffer`, so a dropped field is a silent reply.
function fakeTtsModel(calls: unknown[]) {
  const response = {
    stats: { totalSamples: 2 },
    async *iterate() {
      yield {
        outputArray: new Int16Array([10, -20]),
        sampleRate: 24000,
        chunkIndex: 0,
        isLast: true
      }
    }
  }
  return {
    getEngineType: () => 'supertonic',
    async cancel() {},
    async run(job: unknown) {
      calls.push(job)
      return response
    },
    async runStream(text: string) {
      calls.push(text)
      return response
    },
    async runStreaming(source: AsyncIterable<string>) {
      for await (const text of source) calls.push(text)
      return response
    }
  }
}

test('textToSpeech handler puts the op pcm on the wire frame', async (t) => {
  const modelId = 'tts-handler-pcm'
  const calls: unknown[] = []
  registerModel(modelId, {
    model: fakeTtsModel(calls) as never,
    path: '/tmp/supertonic.gguf',
    config: { ttsEngine: 'supertonic' },
    modelType: 'tts-ggml'
  })
  try {
    const frames: unknown[] = []
    const run = ttsPlugin.handlers.textToSpeech.handler(
      {
        type: 'textToSpeech',
        modelId,
        inputType: 'text',
        text: 'Hello.',
        stream: true
      } as never,
      undefined as never
    ) as unknown as AsyncIterable<unknown>
    for await (const frame of run) {
      frames.push(frame)
    }
    t.is(frames.length, 2, 'one audio frame and the terminal frame')
    const audio = ttsResponseSchema.parse(frames[0])
    t.alike(audio.buffer, [], 'buffer stays empty on the wire')
    t.is(typeof audio.pcm, 'string', 'pcm reaches the wire frame')
    t.alike(Array.from(decodeTtsPcm(audio.pcm!)), [10, -20], 'the samples survive')
    t.is(audio.sampleRate, 24000)
    t.is(audio.chunkIndex, 0)
    t.is(audio.isLast, true)
    const terminal = ttsResponseSchema.parse(frames[1])
    t.is(terminal.done, true)
    t.is('pcm' in terminal, false, 'the terminal frame carries no audio')
  } finally {
    unregisterModel(modelId)
  }
})

test('textToSpeechStream handler puts the op pcm on the duplex wire frame', async (t) => {
  const modelId = 'tts-handler-pcm-duplex'
  const calls: unknown[] = []
  registerModel(modelId, {
    model: fakeTtsModel(calls) as never,
    path: '/tmp/supertonic.gguf',
    config: { ttsEngine: 'supertonic' },
    modelType: 'tts-ggml'
  })
  try {
    const frames: unknown[] = []
    const run = ttsPlugin.handlers.textToSpeechStream.handler(
      { type: 'textToSpeechStream', modelId, inputType: 'text' } as never,
      (async function* () {
        yield Buffer.from('Hello.')
      })() as never
    ) as unknown as AsyncIterable<unknown>
    for await (const frame of run) {
      frames.push(frame)
    }
    t.is(frames.length, 2, 'one audio frame and the terminal frame')
    const audio = textToSpeechStreamResponseSchema.parse(frames[0])
    t.alike(audio.buffer, [])
    t.alike(Array.from(decodeTtsPcm(audio.pcm!)), [10, -20], 'the samples survive the duplex path')
    t.is(audio.isLast, true)
    t.is(textToSpeechStreamResponseSchema.parse(frames[1]).done, true)
  } finally {
    unregisterModel(modelId)
  }
})
