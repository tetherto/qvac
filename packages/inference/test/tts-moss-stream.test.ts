import test from 'brittle'
import Buffer from 'bare-buffer'
import { registerModel, unregisterModel } from '@/runtime/model-registry'
import { textToSpeech } from '@/plugins/builtin/tts-ggml/ops/text-to-speech'
import { textToSpeechStream } from '@/plugins/builtin/tts-ggml/ops/text-to-speech-stream'

// MOSS streams natively: `stream: true` runs the whole text as one addon job
// and forwards each `streamChunkTokens` chunk as it arrives. The sentence
// chunker behind `run({ streamOutput: true })` is not an option there — the
// addon rejects it for a MOSS-TTSD dialogue, and it would apply
// `durationTokens` to every sentence — so these tests pin which addon call
// each engine gets.

type RunJob = Record<string, unknown>

type FakeTtsModel = {
  runCalls: RunJob[]
  runStreamCalls: unknown[]
  getEngineType: () => string
  cancel: () => Promise<void>
  run: (job: RunJob) => Promise<unknown>
  runStream: (text: string, options?: unknown) => Promise<unknown>
  runStreaming?: (source: AsyncIterable<string>, options?: unknown) => Promise<unknown>
}

function fakeTtsModel(engine: string): FakeTtsModel {
  // Three native chunks, the way MOSS reports `streamChunkTokens` output.
  const iterate = async function* () {
    yield { outputArray: [1, 2], sampleRate: 24000, chunkIndex: 0 }
    yield { outputArray: [3, 4], sampleRate: 24000, chunkIndex: 1 }
    yield { outputArray: [5], sampleRate: 24000, chunkIndex: 2, isLast: true }
  }

  const model: FakeTtsModel = {
    runCalls: [],
    runStreamCalls: [],
    getEngineType: () => engine,
    async cancel() {},
    async run(job) {
      model.runCalls.push(job)
      return { stats: { audioDurationMs: 208, generatedFrames: 3 }, iterate }
    },
    async runStream(text, options) {
      model.runStreamCalls.push({ text, options })
      return { stats: { audioDurationMs: 208 }, iterate }
    }
  }
  return model
}

function register(modelId: string, model: FakeTtsModel) {
  registerModel(modelId, {
    model: model as never,
    path: '/tmp/tts.gguf',
    config: { ttsEngine: model.getEngineType() },
    modelType: 'tts-ggml'
  })
}

async function drain(stream: AsyncGenerator<unknown, unknown>) {
  const frames: unknown[] = []
  let result = await stream.next()
  while (!result.done) {
    frames.push(result.value)
    result = await stream.next()
  }
  return { frames, result: result.value }
}

function run(modelId: string, extra: Record<string, unknown>) {
  return textToSpeech({
    type: 'textToSpeech',
    modelId,
    inputType: 'text',
    text: '[S1] Reference one. [S2] Reference two. [S1] Did the build finish?',
    stream: true,
    sentenceStream: false,
    ...extra
  })
}

test('MOSS stream: true runs the whole text natively and forwards every chunk', async (t) => {
  const modelId = 'tts-moss-native-stream'
  const model = fakeTtsModel('moss')
  register(modelId, model)

  try {
    const { frames, result } = await drain(
      run(modelId, { sentenceStreamLocale: 'en', sentenceStreamMaxChunkScalars: 80 })
    )

    t.is(model.runCalls.length, 1, 'one addon job for the whole text')
    t.alike(
      model.runCalls[0],
      {
        input: '[S1] Reference one. [S2] Reference two. [S1] Did the build finish?',
        type: 'text'
      },
      'no streamOutput and no chunker knobs reach the addon'
    )
    t.is(model.runStreamCalls.length, 0)
    t.alike(frames, [
      { buffer: [1, 2], sampleRate: 24000, chunkIndex: 0 },
      { buffer: [3, 4], sampleRate: 24000, chunkIndex: 1 },
      { buffer: [5], sampleRate: 24000, chunkIndex: 2, isLast: true }
    ])
    t.alike((result as { stats?: unknown }).stats, { audioDuration: 208, generatedFrames: 3 })
  } finally {
    unregisterModel(modelId)
  }
})

test('MOSS stream: false collects the native chunks into one buffer', async (t) => {
  const modelId = 'tts-moss-collect'
  const model = fakeTtsModel('moss')
  register(modelId, model)

  try {
    const { frames } = await drain(run(modelId, { stream: false }))
    t.alike(model.runCalls[0], {
      input: '[S1] Reference one. [S2] Reference two. [S1] Did the build finish?',
      type: 'text'
    })
    t.alike(frames, [{ buffer: [1, 2, 3, 4, 5], sampleRate: 24000 }])
  } finally {
    unregisterModel(modelId)
  }
})

test('MOSS sentenceStream: true still asks the addon for sentence chunking', async (t) => {
  const modelId = 'tts-moss-sentence-stream'
  const model = fakeTtsModel('moss')
  register(modelId, model)

  try {
    await drain(run(modelId, { sentenceStream: true }))
    t.is(model.runCalls.length, 0)
    t.is(model.runStreamCalls.length, 1, 'an explicit sentenceStream is the caller’s choice')
  } finally {
    unregisterModel(modelId)
  }
})

test('other engines keep the sentence chunker for stream: true', async (t) => {
  const modelId = 'tts-chatterbox-stream-output'
  const model = fakeTtsModel('chatterbox')
  register(modelId, model)

  try {
    await drain(run(modelId, { sentenceStreamLocale: 'en', sentenceStreamMaxChunkScalars: 80 }))
    t.alike(model.runCalls[0], {
      input: '[S1] Reference one. [S2] Reference two. [S1] Did the build finish?',
      type: 'text',
      streamOutput: true,
      locale: 'en',
      maxChunkScalars: 80
    })
  } finally {
    unregisterModel(modelId)
  }
})

// The addon rejects both sentence-based paths on a MOSS-TTSD dialogue (every
// job has to open with the reference transcripts); the rejection has to reach
// the caller as an error rather than an empty, "completed" run.
const DIALOGUE_REJECTION =
  'tts-ggml: runStreaming: MOSS dialogue cannot be split into sentences, because every job ' +
  'must open with the reference transcripts; use run() or native streaming (streamChunkTokens)'

function fakeMossDialogueModel(): FakeTtsModel {
  const model = fakeTtsModel('moss')
  model.runStream = async () => {
    throw new Error(DIALOGUE_REJECTION.replace('runStreaming', 'run with streamOutput'))
  }
  model.runStreaming = async () => {
    throw new Error(DIALOGUE_REJECTION)
  }
  return model
}

test('MOSS dialogue: the addon rejecting sentenceStream surfaces as an error', async (t) => {
  const modelId = 'tts-moss-dialogue-sentence-stream'
  register(modelId, fakeMossDialogueModel())

  try {
    await t.exception(
      drain(run(modelId, { sentenceStream: true })),
      /MOSS dialogue cannot be split into sentences/
    )
  } finally {
    unregisterModel(modelId)
  }
})

test('MOSS dialogue: the addon rejecting textToSpeechStream surfaces as an error', async (t) => {
  const modelId = 'tts-moss-dialogue-duplex'
  register(modelId, fakeMossDialogueModel())

  const input = (async function* () {
    yield Buffer.from('[S1] Reference one. [S2] Reference two. [S1] Hello.')
  })()

  try {
    await t.exception(
      drain(textToSpeechStream({ type: 'textToSpeechStream', modelId, inputType: 'text' }, input)),
      /MOSS dialogue cannot be split into sentences/
    )
  } finally {
    unregisterModel(modelId)
  }
})
