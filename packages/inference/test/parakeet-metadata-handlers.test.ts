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
