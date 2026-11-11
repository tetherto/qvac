import test from 'brittle'
import Buffer from 'bare-buffer'
import { registerModel, unregisterModel } from '@/runtime/model-registry'
import { textToSpeech } from '@/plugins/builtin/tts-ggml/ops/text-to-speech'
import { textToSpeechStream } from '@/plugins/builtin/tts-ggml/ops/text-to-speech-stream'
import type { TtsOpResult } from '@/plugins/builtin/tts-ggml/ops/text-to-speech'
import type { TtsOpYield } from '@/utils/tts-stats'
import { withDecodedTtsPcm } from '@/schemas/tts-pcm'

// CosyVoice3 0.15 owns its speech-token trajectory and hands it back on the
// output: with the PCM in batch synthesis, and on a final empty `isLast`
// chunk under native chunk streaming. The ops used to drop the field, and the
// streaming paths skipped every empty chunk as a native end marker, so the
// trajectory never reached a caller who wanted to replay it.

type Chunk = {
  outputArray: Int16Array
  sampleRate?: number
  chunkIndex?: number
  isLast?: boolean
  speechTokenIds?: number[]
}

function register(modelId: string, engine: string, chunks: Chunk[]) {
  const response = {
    stats: { totalSamples: 4 },
    async *iterate() {
      yield* chunks
    }
  }
  registerModel(modelId, {
    model: {
      getEngineType: () => engine,
      async cancel() {},
      async run() {
        return response
      },
      async runStream() {
        return response
      },
      async runStreaming(source: AsyncIterable<string>) {
        for await (const _ of source) {
          // drain
        }
        return response
      }
    } as never,
    path: `/tmp/${engine}.gguf`,
    config: { ttsEngine: engine },
    modelType: 'tts-ggml'
  })
}

async function collect(op: AsyncGenerator<TtsOpYield, TtsOpResult, unknown>) {
  const frames: TtsOpYield[] = []
  let result = await op.next()
  while (!result.done) {
    frames.push(withDecodedTtsPcm(result.value))
    result = await op.next()
  }
  return { frames, result: result.value }
}

const BATCH: Chunk[] = [
  { outputArray: new Int16Array([10, 20, 30, 40]), sampleRate: 24000, speechTokenIds: [12, 480, 3] }
]

const NATIVE_STREAM: Chunk[] = [
  { outputArray: new Int16Array([10, 20]), sampleRate: 24000, chunkIndex: 0 },
  { outputArray: new Int16Array([30, 40]), sampleRate: 24000, chunkIndex: 1 },
  { outputArray: new Int16Array(0), isLast: true, speechTokenIds: [12, 480, 3] }
]

test('batch synthesis forwards the speech tokens with the collected PCM', async (t) => {
  const modelId = 'cosyvoice3-batch-tokens'
  register(modelId, 'cosyvoice3', BATCH)
  try {
    const { frames, result } = await collect(
      textToSpeech({
        type: 'textToSpeech',
        modelId,
        inputType: 'text',
        text: 'Hello.',
        stream: false,
        sentenceStream: false
      })
    )
    t.is(frames.length, 1)
    t.alike(frames[0], {
      buffer: [10, 20, 30, 40],
      sampleRate: 24000,
      speechTokenIds: [12, 480, 3]
    })
    t.alike(result.stats, { totalSamples: 4 })
  } finally {
    unregisterModel(modelId)
  }
})

test('a batch collect over a native stream concatenates the chunks and keeps the tokens', async (t) => {
  // `stream: false` on a model loaded with streamChunkTokens: the addon still
  // emits chunks, and the tokens ride the final empty one.
  const modelId = 'cosyvoice3-batch-over-stream'
  register(modelId, 'cosyvoice3', NATIVE_STREAM)
  try {
    const { frames } = await collect(
      textToSpeech({
        type: 'textToSpeech',
        modelId,
        inputType: 'text',
        text: 'Hello.',
        stream: false,
        sentenceStream: false
      })
    )
    t.is(frames.length, 1)
    t.alike(frames[0], {
      buffer: [10, 20, 30, 40],
      sampleRate: 24000,
      speechTokenIds: [12, 480, 3]
    })
  } finally {
    unregisterModel(modelId)
  }
})

for (const mode of ['stream', 'sentence', 'duplex'] as const) {
  test(`${mode}: the final empty chunk that carries the tokens reaches the caller`, async (t) => {
    const modelId = `cosyvoice3-${mode}-tokens`
    register(modelId, 'cosyvoice3', NATIVE_STREAM)
    try {
      const op =
        mode === 'duplex'
          ? textToSpeechStream(
              { type: 'textToSpeechStream', modelId, inputType: 'text' },
              (async function* () {
                yield Buffer.from('Hello.')
              })()
            )
          : textToSpeech({
              type: 'textToSpeech',
              modelId,
              inputType: 'text',
              text: 'Hello.',
              stream: true,
              sentenceStream: mode === 'sentence'
            })
      const { frames } = await collect(op)
      t.is(frames.length, 3, 'two audio frames and the token frame')
      t.alike(frames[0], { buffer: [10, 20], sampleRate: 24000, chunkIndex: 0 })
      t.alike(frames[1], { buffer: [30, 40], sampleRate: 24000, chunkIndex: 1 })
      t.alike(frames[2], { buffer: [], isLast: true, speechTokenIds: [12, 480, 3] })
    } finally {
      unregisterModel(modelId)
    }
  })

  test(`${mode}: an empty end marker without tokens is still skipped`, async (t) => {
    // Audio8's native end markers are empty chunks carrying nothing; they
    // must not surface as empty frames now that token frames pass.
    const modelId = `audio8-${mode}-end-marker`
    register(modelId, 'audio8', [
      { outputArray: new Int16Array([10, 20]), sampleRate: 44100, chunkIndex: 0 },
      { outputArray: new Int16Array(0), isLast: true }
    ])
    try {
      const op =
        mode === 'duplex'
          ? textToSpeechStream(
              { type: 'textToSpeechStream', modelId, inputType: 'text' },
              (async function* () {
                yield Buffer.from('Hello.')
              })()
            )
          : textToSpeech({
              type: 'textToSpeech',
              modelId,
              inputType: 'text',
              text: 'Hello.',
              stream: true,
              sentenceStream: mode === 'sentence'
            })
      const { frames } = await collect(op)
      // The plain stream path never filtered empty chunks; the chunked paths do.
      const expected = mode === 'stream' ? 2 : 1
      t.is(frames.length, expected)
      t.alike(frames[0], { buffer: [10, 20], sampleRate: 44100, chunkIndex: 0 })
      for (const frame of frames) t.is('speechTokenIds' in frame, false)
    } finally {
      unregisterModel(modelId)
    }
  })
}
