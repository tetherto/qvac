import test from 'brittle'
import { registerModel, unregisterModel } from '@/runtime/model-registry'
import { registerPlugin } from '@/plugins/registry'
import { ttsPlugin } from '@/plugins/builtin/tts-ggml/plugin'
import { textToSpeech } from '@/api/text-to-speech'

// Public-entry coverage: `textToSpeech()` through dispatch, the plugin handler
// and the op, against a fake engine, so the lazy start, early close and error
// paths of `chunkStream` are exercised where callers reach them.
type Chunk = { outputArray: Float32Array; sampleRate: number; chunkIndex: number; isLast?: boolean }

function fakeModel(opts: { chunks: Chunk[]; gate?: Promise<void>; fail?: Error }) {
  const calls: unknown[] = []
  const response = {
    stats: { totalSamples: opts.chunks.reduce((n, c) => n + c.outputArray.length, 0) },
    async *iterate() {
      let i = 0
      for (const chunk of opts.chunks) {
        if (i === 1 && opts.gate) await opts.gate
        if (i === 1 && opts.fail) throw opts.fail
        yield chunk
        i++
      }
    }
  }
  const model = {
    getEngineType: () => 'supertonic',
    async cancel() {
      calls.push('cancel')
    },
    async run(job: unknown) {
      calls.push(job)
      return response
    },
    async runStream(text: string) {
      calls.push(text)
      return response
    }
  }
  return { model, calls }
}

// Once per process: the registry rejects a second registration of the type.
registerPlugin(ttsPlugin)

function withModel(modelId: string, model: unknown) {
  registerModel(modelId, {
    model: model as never,
    path: '/tmp/supertonic.gguf',
    config: { ttsEngine: 'supertonic' },
    modelType: 'tts-ggml'
  })
  return () => unregisterModel(modelId)
}

const chunk = (samples: number[], chunkIndex: number, isLast = false): Chunk => ({
  outputArray: Float32Array.from(samples),
  sampleRate: 24000,
  chunkIndex,
  isLast
})

test('textToSpeech chunkStream yields one Float32Array per engine chunk and settles done', async (t) => {
  const modelId = 'tts-public-chunks'
  const { model, calls } = fakeModel({ chunks: [chunk([0.1, -0.2], 0), chunk([0.5], 1, true)] })
  const cleanup = withModel(modelId, model)
  try {
    const run = textToSpeech({ modelId, text: 'Hi.' })
    t.is(calls.length, 0, 'nothing runs until a view is iterated')
    const chunks: Float32Array[] = []
    for await (const c of run.chunkStream) chunks.push(c)
    t.is(chunks.length, 2)
    t.ok(chunks.every((c) => c instanceof Float32Array))
    t.alike(Array.from(chunks[0]!), Array.from(Float32Array.from([0.1, -0.2])))
    t.alike(Array.from(chunks[1]!), [0.5])
    t.is(await run.done, true)
    t.is(await run.sampleRate, 24000)
    t.is(await run.stopReason, 'completed')
    t.is(calls.length, 1, 'one engine job')
  } finally {
    cleanup()
  }
})

test('textToSpeech bufferStream is the per-sample view of the same run', async (t) => {
  const modelId = 'tts-public-samples'
  const { model } = fakeModel({ chunks: [chunk([1, 2], 0), chunk([3], 1, true)] })
  const cleanup = withModel(modelId, model)
  try {
    const run = textToSpeech({ modelId, text: 'Hi.' })
    const samples: number[] = []
    for await (const s of run.bufferStream) samples.push(s)
    t.alike(samples, [1, 2, 3])
    t.is(await run.done, true)
    t.is((await run.chunkStream.next()).done, true, 'the chunk view is consumed with it')
  } finally {
    cleanup()
  }
})

test('closing chunkStream early settles done=false', async (t) => {
  const modelId = 'tts-public-early'
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const { model } = fakeModel({ chunks: [chunk([1, 2], 0), chunk([3], 1, true)], gate })
  const cleanup = withModel(modelId, model)
  try {
    const run = textToSpeech({ modelId, text: 'Hi.' })
    for await (const c of run.chunkStream) {
      t.is(c.length, 2)
      break
    }
    t.is(await run.done, false, 'an abandoned run does not report completion')
  } finally {
    release()
    cleanup()
  }
})

test('an engine failure rejects chunkStream and done', async (t) => {
  const modelId = 'tts-public-fail'
  const failure = new Error('engine exploded')
  const { model } = fakeModel({ chunks: [chunk([1], 0), chunk([2], 1, true)], fail: failure })
  const cleanup = withModel(modelId, model)
  try {
    const run = textToSpeech({ modelId, text: 'Hi.' })
    const chunks: Float32Array[] = []
    let caught: unknown
    try {
      for await (const c of run.chunkStream) chunks.push(c)
    } catch (err) {
      caught = err
    }
    t.ok(caught instanceof Error, 'iteration rejects')
    t.ok(String((caught as Error).message).includes('engine exploded'))
    t.is(chunks.length, 1, 'frames before the failure were delivered')
    let doneErr: unknown
    await run.done.catch((err: unknown) => {
      doneErr = err
    })
    t.ok(doneErr instanceof Error, 'done rejects too')
  } finally {
    cleanup()
  }
})

test('stream: false exposes empty audio views and resolves buffer', async (t) => {
  const modelId = 'tts-public-batch'
  const { model } = fakeModel({ chunks: [chunk([1, 2], 0), chunk([3], 1, true)] })
  const cleanup = withModel(modelId, model)
  try {
    const run = textToSpeech({ modelId, text: 'Hi.', stream: false })
    t.alike(await run.buffer, [1, 2, 3])
    t.is((await run.chunkStream.next()).done, true, 'chunkStream is empty')
    t.is((await run.bufferStream.next()).done, true, 'bufferStream is empty')
    t.is(await run.done, true)
  } finally {
    cleanup()
  }
})

test('sentence stream: chunkStream yields per frame alongside chunkUpdates', async (t) => {
  const modelId = 'tts-public-sentence'
  const { model } = fakeModel({ chunks: [chunk([1, 2], 0), chunk([3], 1, true)] })
  const cleanup = withModel(modelId, model)
  try {
    const run = textToSpeech({ modelId, text: 'One. Two.', sentenceStream: true })
    const chunks: number[][] = []
    const updates: unknown[] = []
    await Promise.all([
      (async () => {
        for await (const c of run.chunkStream) chunks.push(Array.from(c))
      })(),
      (async () => {
        for await (const u of run.chunkUpdates!) updates.push(u)
      })()
    ])
    t.alike(chunks, [[1, 2], [3]])
    t.ok(updates.length >= 1)
    t.is(await run.done, true)
  } finally {
    cleanup()
  }
})
