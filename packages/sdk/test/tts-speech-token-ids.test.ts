import { mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { encodeTtsPcm } from '@qvac/inference/surface'

// CosyVoice3 hands its speech-token trajectory back on the frames: with the PCM
// in batch synthesis, on a final empty `isLast` frame under native chunk
// streaming. The client exposes it as `speechTokenIds` on the result (the
// concatenation of every array the run carried) and on the per-sentence
// `chunkUpdates`, so a caller can replay it through `forceSpeechTokens`.

let scripted: Array<Record<string, unknown>> = []
mock.module('@/client/rpc/rpc-client', {
  namedExports: {
    stream: async function* () {
      yield* scripted
    },
    duplex: async () => {
      throw new Error('unused')
    }
  }
})

const { textToSpeech } = await import('@/client/api/text-to-speech')

test('batch synthesis resolves speechTokenIds beside the buffer', async () => {
  scripted = [
    {
      type: 'textToSpeech',
      buffer: [],
      pcm: encodeTtsPcm([10, 20, 30, 40]),
      done: false,
      sampleRate: 24000,
      speechTokenIds: [12, 480, 3]
    },
    { type: 'textToSpeech', buffer: [], done: true, stopReason: 'completed' }
  ]
  const run = textToSpeech({ modelId: 'cosyvoice3', text: 'Hello.', stream: false })
  assert.deepEqual(await run.buffer, [10, 20, 30, 40])
  assert.deepEqual(await run.speechTokenIds, [12, 480, 3])
})

test('plain streaming resolves the tokens from the final empty frame, which yields no chunk', async () => {
  scripted = [
    {
      type: 'textToSpeech',
      buffer: [],
      pcm: encodeTtsPcm([10, 20]),
      done: false,
      sampleRate: 24000
    },
    { type: 'textToSpeech', buffer: [], pcm: encodeTtsPcm([30, 40]), done: false },
    { type: 'textToSpeech', buffer: [], done: false, isLast: true, speechTokenIds: [12, 480, 3] },
    { type: 'textToSpeech', buffer: [], done: true, stopReason: 'completed' }
  ]
  const run = textToSpeech({ modelId: 'cosyvoice3', text: 'Hello.', stream: true })
  const chunks: number[][] = []
  for await (const chunk of run.chunkStream) chunks.push(Array.from(chunk))
  assert.deepEqual(chunks, [
    [10, 20],
    [30, 40]
  ])
  assert.deepEqual(await run.speechTokenIds, [12, 480, 3])
})

test('sentence streaming carries each sentence’s tokens on chunkUpdates and concatenates them', async () => {
  scripted = [
    {
      type: 'textToSpeech',
      buffer: [],
      pcm: encodeTtsPcm([1, 2]),
      done: false,
      chunkIndex: 0,
      sentenceChunk: 'One.',
      speechTokenIds: [12, 480]
    },
    {
      type: 'textToSpeech',
      buffer: [],
      pcm: encodeTtsPcm([3, 4]),
      done: false,
      chunkIndex: 1,
      sentenceChunk: 'Two.',
      isLast: true,
      speechTokenIds: [3]
    },
    { type: 'textToSpeech', buffer: [], done: true, stopReason: 'completed' }
  ]
  const run = textToSpeech({
    modelId: 'cosyvoice3',
    text: 'One. Two.',
    stream: true,
    sentenceStream: true
  })
  const updates = []
  for await (const update of run.chunkUpdates!) updates.push(update)
  assert.deepEqual(
    updates.map((u) => u.speechTokenIds),
    [[12, 480], [3]]
  )
  assert.deepEqual(await run.speechTokenIds, [12, 480, 3])
})

test('engines that emit no tokens resolve speechTokenIds to undefined', async () => {
  scripted = [
    { type: 'textToSpeech', buffer: [], pcm: encodeTtsPcm([1]), done: false, sampleRate: 44100 },
    { type: 'textToSpeech', buffer: [], done: true, stopReason: 'completed' }
  ]
  const run = textToSpeech({ modelId: 'supertonic', text: 'Hello.', stream: false })
  await run.buffer
  assert.equal(await run.speechTokenIds, undefined)
})
