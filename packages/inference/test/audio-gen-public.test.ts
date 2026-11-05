import test from 'brittle'
import { AudioGen } from '@qvac/audiogen-ggml'
import type { AudiogenOutputChunk, AudiogenStats } from '@qvac/audiogen-ggml'
import { audioGen } from '@/api/audio-gen'
import { audioGenPlugin } from '@/plugins/builtin/audiogen-ggml/plugin'
import { hasPlugin, registerPlugin, unregisterPlugin } from '@/plugins/registry'
import { registerModel, unregisterModel, type AnyModel } from '@/runtime/model-registry'
import { ModelType } from '@/schemas/index'
import { ERROR_CODES } from '@/schemas/errors'
import { AudioEncodeFailedError, InferenceCancelledError } from '@/errors/index'

// Public-entry coverage: `audioGen()` through dispatch, the plugin handler and
// the op, against an engine whose run is replaced, so `chunkStream` and
// `encoded` are exercised where callers reach them.
type AudioGenResponse = Awaited<ReturnType<AudioGen['run']>>

const STATS: AudiogenStats = {
  audioDurationMs: 10,
  totalTimeMs: 5,
  realTimeFactor: 0.5,
  backendDevice: 0,
  backendId: 0
}

function pcmChunk(samples: number[]): AudiogenOutputChunk {
  return { outputArray: Int16Array.from(samples), sampleRate: 48000, channels: 2 }
}

function fakeModel(opts: { chunks: AudiogenOutputChunk[]; fail?: Error; gate?: Promise<void> }) {
  const calls: string[] = []
  const model = new AudioGen({
    files: {
      textEncModel: 'text-encoder.gguf',
      lmModel: 'lm.gguf',
      ditModel: 'dit.gguf',
      vaeModel: 'vae.gguf'
    }
  })
  model.run = async function () {
    calls.push('run')
    return {
      async *iterate() {
        for (const chunk of opts.chunks) {
          yield chunk
          if (opts.gate) await opts.gate
          if (opts.fail) throw opts.fail
        }
      },
      async await() {
        return STATS
      }
    } as unknown as AudioGenResponse
  }
  model.cancel = async function () {
    calls.push('cancel')
  }
  return { model, calls }
}

// The plugin registry is process-wide state shared with every other test file
// in the whole-suite run, and some of them assert it is empty: register when a
// test starts and leave the registry as found when it ends.
function withModel(modelId: string, model: AudioGen) {
  const registeredHere = !hasPlugin(audioGenPlugin.modelType)
  if (registeredHere) registerPlugin(audioGenPlugin)
  registerModel(modelId, {
    model: model as unknown as AnyModel,
    path: '',
    config: {},
    modelType: ModelType.audiogenGgml
  })
  return () => {
    unregisterModel(modelId)
    if (registeredHere) unregisterPlugin(audioGenPlugin.modelType)
  }
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  return undefined
}

async function collect<T>(source: AsyncIterable<T>) {
  const items: T[] = []
  for await (const item of source) items.push(item)
  return items
}

test('audioGen chunkStream yields one Int16Array per engine chunk beside the PCM promise', async (t) => {
  const modelId = 'audio-gen-public-chunks'
  const { model } = fakeModel({ chunks: [pcmChunk([100, -200, 300, -400]), pcmChunk([5, -6])] })
  const cleanup = withModel(modelId, model)
  try {
    const run = audioGen({ modelId, caption: 'ambient electronic music' })
    const chunks = await collect(run.chunkStream)
    t.is(chunks.length, 2)
    t.ok(chunks.every((chunk) => chunk instanceof Int16Array))
    t.alike(Array.from(chunks[0]!), [100, -200, 300, -400])
    t.alike(Array.from(chunks[1]!), [5, -6])

    // A caller may process a chunk in place without changing `audio`.
    chunks[0]!.fill(0)
    const audio = await run.audio
    t.is(audio.sampleRate, 48000)
    t.is(audio.channels, 2)
    t.is(audio.bitsPerSample, 16)
    t.alike(
      Array.from(new Int16Array(audio.pcm.buffer, audio.pcm.byteOffset, audio.pcm.byteLength / 2)),
      [100, -200, 300, -400, 5, -6]
    )
    t.is(await run.encoded, undefined, 'no outputFormat, no file')
    t.is((await run.stats)?.audioDurationMs, 10)
  } finally {
    cleanup()
  }
})

test('audioGen resolves the PCM for a caller that never reads chunkStream', async (t) => {
  const modelId = 'audio-gen-public-unread'
  const { model } = fakeModel({ chunks: [pcmChunk([1, 2])] })
  const cleanup = withModel(modelId, model)
  try {
    const run = audioGen({ modelId, caption: 'ambient electronic music' })
    t.is((await run.audio).pcm.byteLength, 4)
    t.alike(
      (await collect(run.chunkStream)).map((chunk) => Array.from(chunk)),
      [[1, 2]],
      'the chunks are still there afterwards'
    )
  } finally {
    cleanup()
  }
})

test('audioGen outputFormat delivers the run as a WAV file next to the PCM', async (t) => {
  const modelId = 'audio-gen-public-wav'
  const { model } = fakeModel({ chunks: [pcmChunk([1, -1, 2, -2]), pcmChunk([3, -3])] })
  const cleanup = withModel(modelId, model)
  try {
    const run = audioGen({ modelId, caption: 'ambient electronic music', outputFormat: 'wav' })
    const file = await run.encoded
    const audio = await run.audio
    t.ok(file)
    if (!file) return
    t.is(file.format, 'wav')
    t.is(file.mimeType, 'audio/wav')
    t.is(file.extension, 'wav')
    t.is(file.data.byteLength, 44 + audio.pcm.byteLength)
    t.is(String.fromCharCode(...file.data.subarray(0, 4)), 'RIFF')
    const header = new DataView(file.data.buffer, file.data.byteOffset, 44)
    t.is(header.getUint16(22, true), 2, 'channels come from the engine chunk')
    t.is(header.getUint32(24, true), 48000, 'and so does the sample rate')
    t.alike(Array.from(file.data.subarray(44)), Array.from(audio.pcm))
  } finally {
    cleanup()
  }
})

test('audioGen refuses an outputFormat the host cannot encode before running the model', async (t) => {
  const modelId = 'audio-gen-public-no-encoder'
  const { model, calls } = fakeModel({ chunks: [pcmChunk([1, 2])] })
  const cleanup = withModel(modelId, model)
  const encode = AudioGen.encode
  AudioGen.encode = function () {
    throw new Error('Encoder not found')
  } as typeof AudioGen.encode
  try {
    const run = audioGen({ modelId, caption: 'ambient electronic music', outputFormat: 'flac' })
    t.ok((await rejection(run.encoded)) instanceof AudioEncodeFailedError)
    t.ok((await rejection(run.audio)) instanceof AudioEncodeFailedError)
    try {
      await run.stats
      t.fail('expected the run to fail')
    } catch (error) {
      t.is((error as AudioEncodeFailedError).code, ERROR_CODES.AUDIO_ENCODE_FAILED)
      t.ok((error as Error).message.includes('flac'))
      t.ok((error as Error).message.includes('Encoder not found'))
    }
    t.ok((await rejection(collect(run.chunkStream))) instanceof AudioEncodeFailedError)
    t.alike(calls, [], 'no generation was spent on it')
  } finally {
    AudioGen.encode = encode
    cleanup()
  }
})

test('audioGen chunkStream delivers what arrived, then throws the run error', async (t) => {
  const modelId = 'audio-gen-public-failure'
  const { model } = fakeModel({ chunks: [pcmChunk([7, 8])], fail: new Error('engine exploded') })
  const cleanup = withModel(modelId, model)
  try {
    const run = audioGen({ modelId, caption: 'ambient electronic music' })
    const seen: number[][] = []
    try {
      for await (const chunk of run.chunkStream) seen.push(Array.from(chunk))
      t.fail('expected the run error')
    } catch (error) {
      t.ok((error as Error).message.includes('engine exploded'))
    }
    t.alike(seen, [[7, 8]])
    await t.exception(run.audio)
  } finally {
    cleanup()
  }
})

test('audioGen chunkStream ends when the run is cancelled', async (t) => {
  const modelId = 'audio-gen-public-cancel'
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const { model, calls } = fakeModel({ chunks: [pcmChunk([1, 2]), pcmChunk([3, 4])], gate })
  const cleanup = withModel(modelId, model)
  try {
    const run = audioGen({ modelId, caption: 'ambient electronic music' })
    const first = await run.chunkStream.next()
    t.alike(Array.from(first.value as Int16Array), [1, 2])

    const { cancel } = await import('@/api/cancel')
    await cancel({ requestId: run.requestId })
    release()

    t.is((await run.chunkStream.next()).done, true, 'no error, no further chunk')
    t.ok((await rejection(run.audio)) instanceof InferenceCancelledError)
    t.ok(calls.includes('cancel'))
  } finally {
    release()
    cleanup()
  }
})
