import test from 'brittle'
import Buffer from 'bare-buffer'
import { registerModel, unregisterModel, type AnyModel } from '@/runtime/model-registry'
import { parakeetPlugin } from '@/plugins/builtin/parakeet-transcription/plugin'
import { ModelType, type TranscribeResponse, type TranscribeStreamResponse } from '@/schemas/index'

// What the parakeet output serializer (`transcriptToJsObject`) sends for every
// segment. Timings are seconds; the SDK reports milliseconds.
const NATIVE_SEGMENT = {
  text: 'end of the turn',
  start: 1.5,
  end: 2.25,
  id: 7,
  toAppend: false,
  isEndOfTurn: true,
  startsWord: true
}

function createParakeetModel(outputs: unknown[]) {
  const response = () => ({
    stats: {},
    async *iterate() {
      for (const output of outputs) yield output
    },
    async await() {}
  })
  return {
    addon: { async cancel() {} },
    async run() {
      return response()
    },
    async runStreaming() {
      return response()
    }
  } as unknown as AnyModel
}

function register(t: { teardown(fn: () => void): void }, modelId: string, outputs: unknown[]) {
  registerModel(modelId, {
    model: createParakeetModel(outputs),
    path: '',
    config: {},
    modelType: ModelType.parakeetTranscription
  })
  t.teardown(() => unregisterModel(modelId))
}

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const frames: T[] = []
  for await (const frame of stream) frames.push(frame)
  return frames
}

function emptyInput(): AsyncIterable<Buffer> {
  return (async function* () {})()
}

// A tiny valid raw PCM payload; the fake model ignores its content.
const AUDIO = { type: 'base64' as const, value: Buffer.alloc(32).toString('base64') }

test('parakeet unary handler returns segment frames for metadata: true', async (t) => {
  const modelId = 'parakeet-metadata-unary'
  register(t, modelId, [NATIVE_SEGMENT])

  const frames = await collect(
    parakeetPlugin.handlers.transcribe.handler({
      type: 'transcribe',
      modelId,
      audioChunk: AUDIO,
      metadata: true
    }) as unknown as AsyncIterable<TranscribeResponse>
  )

  const segment = frames.find((frame) => frame.segment)?.segment
  t.ok(segment, 'a segment frame is emitted instead of a rejection')
  t.is(segment?.startMs, 1500, 'start seconds become ms')
  t.is(segment?.endMs, 2250, 'end seconds become ms')
  t.is(segment?.id, 7, 'id survives')
  t.is(segment?.isEndOfTurn, true, 'isEndOfTurn survives')
  t.is(segment?.startsWord, true, 'startsWord survives')
  t.is(frames.filter((frame) => frame.text).length, 0, 'no plain-text frames in metadata mode')
  t.is(frames.at(-1)?.done, true, 'the run still terminates normally')
})

test('parakeet duplex handler returns segment frames for metadata: true', async (t) => {
  const modelId = 'parakeet-metadata-duplex'
  register(t, modelId, [NATIVE_SEGMENT])

  const frames = await collect(
    parakeetPlugin.handlers.transcribeStream.handler(
      { type: 'transcribeStream', modelId, metadata: true },
      emptyInput()
    ) as unknown as AsyncIterable<TranscribeStreamResponse>
  )

  const segment = frames.find((frame) => frame.segment)?.segment
  t.ok(segment, 'a segment frame is emitted instead of a rejection')
  t.is(segment?.startMs, 1500, 'start seconds become ms')
  t.is(segment?.isEndOfTurn, true, 'isEndOfTurn survives')
  t.is(frames.at(-1)?.done, true, 'the session still terminates normally')
})

test('parakeet duplex metadata mode still forwards endOfTurn events', async (t) => {
  // Segments carry no `type`, so the event branch must keep catching only the
  // typed events and let the segment through as a segment frame.
  const modelId = 'parakeet-metadata-duplex-eot'
  register(t, modelId, [NATIVE_SEGMENT, { type: 'endOfTurn', source: 'model-eou' }])

  const frames = await collect(
    parakeetPlugin.handlers.transcribeStream.handler(
      { type: 'transcribeStream', modelId, metadata: true },
      emptyInput()
    ) as unknown as AsyncIterable<TranscribeStreamResponse>
  )

  t.ok(
    frames.some((frame) => frame.segment),
    'the segment arrives as a segment frame'
  )
  t.ok(
    frames.some((frame) => frame.endOfTurn?.source === 'parakeet'),
    'the endOfTurn event is still forwarded'
  )
})

test('parakeet handlers keep plain text when metadata is not requested', async (t) => {
  const modelId = 'parakeet-metadata-off'
  register(t, modelId, [NATIVE_SEGMENT])

  const frames = await collect(
    parakeetPlugin.handlers.transcribeStream.handler(
      { type: 'transcribeStream', modelId },
      emptyInput()
    ) as unknown as AsyncIterable<TranscribeStreamResponse>
  )

  t.ok(
    frames.some((frame) => frame.text === 'end of the turn'),
    'text frames are unchanged'
  )
  t.is(frames.filter((frame) => frame.segment).length, 0, 'no segment frames without metadata')
})

test('parakeet duplex handler forwards native end-of-turn and VAD chunk detail', async (t) => {
  // The native EOU boundary arrives with its timing and confidence; a VAD
  // transition arrives with its chunk index. Both must reach the wire frame,
  // and a boundary without detail must stay the bare parakeet variant.
  const modelId = 'parakeet-eou-detail'
  register(t, modelId, [
    { type: 'vad', speaking: true, score: 0.8, source: 'energy', timestamp: 0.5, chunkIndex: 1 },
    { ...NATIVE_SEGMENT, tokenIds: [12, 7], isFinal: true, chunkIndex: 6, eotConfidence: 0.93 },
    { type: 'endOfTurn', source: 'model-eou', timestamp: 4.125, chunkIndex: 6, confidence: 0.93 },
    { type: 'endOfTurn', source: 'model-eou' }
  ])

  const frames = await collect(
    parakeetPlugin.handlers.transcribeStream.handler(
      { type: 'transcribeStream', modelId, metadata: true },
      emptyInput()
    ) as unknown as AsyncIterable<TranscribeStreamResponse>
  )

  t.alike(
    frames.find((frame) => frame.vad)?.vad,
    { speaking: true, probability: 0.8, source: 'energy', timestamp: 0.5, chunkIndex: 1 },
    'the VAD frame carries the native chunk index'
  )
  const segment = frames.find((frame) => frame.segment)?.segment
  t.alike(segment?.tokenIds, [12, 7], 'token ids reach the segment frame')
  t.is(segment?.isFinal, true, 'isFinal reaches the segment frame')
  t.is(segment?.chunkIndex, 6, 'chunkIndex reaches the segment frame')
  t.is(segment?.eotConfidence, 0.93, 'eotConfidence reaches the segment frame')
  t.alike(
    frames.filter((frame) => frame.endOfTurn).map((frame) => frame.endOfTurn),
    [
      { source: 'parakeet', timestamp: 4.125, chunkIndex: 6, confidence: 0.93 },
      { source: 'parakeet' }
    ],
    'the boundary detail is forwarded only when the engine sent it'
  )
})

// The native streaming session closes a chunk with a text-less segment whose
// only payload is `isFinal: true`. It is the caller's finality signal, so it
// must survive the empty-text filter in metadata mode, on both handlers.
const EMPTY_FINAL_MARKER = {
  text: '',
  start: 2.25,
  end: 2.25,
  toAppend: true,
  isFinal: true,
  chunkIndex: 6
}
const EMPTY_PARTIAL = {
  text: '',
  start: 2.25,
  end: 2.25,
  toAppend: true,
  isFinal: false,
  chunkIndex: 7
}

test('parakeet duplex handler delivers an empty final marker in metadata mode', async (t) => {
  const modelId = 'parakeet-empty-final-duplex'
  register(t, modelId, [EMPTY_FINAL_MARKER, EMPTY_PARTIAL, { text: '' }])

  const frames = await collect(
    parakeetPlugin.handlers.transcribeStream.handler(
      { type: 'transcribeStream', modelId, metadata: true },
      emptyInput()
    ) as unknown as AsyncIterable<TranscribeStreamResponse>
  )

  const segments = frames.filter((frame) => frame.segment).map((frame) => frame.segment)
  t.is(segments.length, 1, 'only the final marker passes; other empty segments stay dropped')
  t.is(segments[0]?.text, '', 'the marker keeps its empty text')
  t.is(segments[0]?.isFinal, true, 'isFinal reaches the caller')
  t.is(segments[0]?.chunkIndex, 6, 'the marker names its chunk')
})

test('parakeet duplex handler emits no text for an empty final marker without metadata', async (t) => {
  const modelId = 'parakeet-empty-final-text'
  register(t, modelId, [EMPTY_FINAL_MARKER])

  const frames = await collect(
    parakeetPlugin.handlers.transcribeStream.handler(
      { type: 'transcribeStream', modelId },
      emptyInput()
    ) as unknown as AsyncIterable<TranscribeStreamResponse>
  )

  t.is(frames.filter((frame) => frame.segment).length, 0, 'no segment frames without metadata')
  t.is(
    frames.filter((frame) => frame.text !== undefined && frame.text !== '').length,
    0,
    'no text frames'
  )
})

test('parakeet unary handler delivers an empty final marker in metadata mode', async (t) => {
  const modelId = 'parakeet-empty-final-unary'
  register(t, modelId, [[EMPTY_FINAL_MARKER, EMPTY_PARTIAL]])

  const frames = await collect(
    parakeetPlugin.handlers.transcribe.handler({
      type: 'transcribe',
      modelId,
      audioChunk: AUDIO,
      metadata: true
    }) as unknown as AsyncIterable<TranscribeResponse>
  )

  const segments = frames.filter((frame) => frame.segment).map((frame) => frame.segment)
  t.is(segments.length, 1, 'only the final marker passes')
  t.is(segments[0]?.isFinal, true, 'isFinal reaches the caller')
})
