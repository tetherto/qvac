import { mock, test } from 'node:test'
import assert from 'node:assert/strict'

// Public-entry coverage for `textToSpeech()`: the plain-stream path has its
// own lazy generator (`plainTtsChunkStream`), the sentence path goes through
// the multicast, and `stream: false` exposes empty audio views. Each test
// scripts the frames the mocked RPC stream yields for the next call.
type Frame = Record<string, unknown>
type Script = { frames: Frame[]; throwAfter?: Error; holdOpen?: boolean }

const scripts: Script[] = []
const transport = { opened: 0, closed: 0 }

mock.module('@/client/rpc/rpc-client', {
  namedExports: {
    stream: async function* () {
      const script = scripts.shift()
      if (!script) throw new Error('test bug: no scripted frames for this call')
      transport.opened++
      try {
        for (const frame of script.frames) yield frame
        if (script.throwAfter) throw script.throwAfter
        if (script.holdOpen) await new Promise(() => {})
      } finally {
        transport.closed++
      }
    },
    duplex: async () => {
      throw new Error('unused')
    }
  }
})

const { textToSpeech } = await import('@/client/api/text-to-speech')

const audio = (buffer: number[], extra: Frame = {}): Frame => ({
  type: 'textToSpeech',
  buffer,
  done: false,
  ...extra
})
const terminal = (extra: Frame = {}): Frame => ({
  type: 'textToSpeech',
  buffer: [],
  done: true,
  stopReason: 'completed',
  stats: { totalTimeMs: 3 },
  ...extra
})

function snapshot() {
  return { ...transport }
}

test('plain stream: chunkStream starts the run lazily and yields one Float32Array per audio frame', async () => {
  scripts.push({
    frames: [audio([0.1, -0.2], { sampleRate: 24000 }), audio([]), audio([0.5]), terminal()]
  })
  const before = snapshot()
  const run = textToSpeech({ modelId: 'tts', text: 'Hi.' })
  assert.equal(transport.opened, before.opened, 'nothing is sent until a view is iterated')

  const chunks: Float32Array[] = []
  for await (const chunk of run.chunkStream) chunks.push(chunk)

  assert.equal(chunks.length, 2, 'empty frames are skipped')
  assert.ok(chunks.every((c) => c instanceof Float32Array))
  assert.deepEqual(Array.from(chunks[0]!), Array.from(Float32Array.from([0.1, -0.2])))
  assert.deepEqual(Array.from(chunks[1]!), [0.5])
  assert.equal(await run.done, true)
  assert.equal(await run.sampleRate, 24000)
  assert.equal(await run.stopReason, 'completed')
  assert.deepEqual(await run.stats, { totalTimeMs: 3 })
  assert.equal(transport.closed, before.closed + 1, 'the RPC stream was closed')
})

test('plain stream: bufferStream is the per-sample view of the same run', async () => {
  scripts.push({ frames: [audio([1, 2], { sampleRate: 16000 }), audio([3]), terminal()] })
  const run = textToSpeech({ modelId: 'tts', text: 'Hi.' })
  const samples: number[] = []
  for await (const s of run.bufferStream) samples.push(s)
  assert.deepEqual(samples, [1, 2, 3])
  assert.equal(await run.done, true)
  assert.equal((await run.chunkStream.next()).done, true, 'the chunk view is consumed with it')
})

test('plain stream: closing chunkStream early settles done=false and releases the transport', async () => {
  scripts.push({ frames: [audio([0.25, 0.5]), audio([0.75])], holdOpen: true })
  const before = snapshot()
  const run = textToSpeech({ modelId: 'tts', text: 'Hi.' })
  for await (const chunk of run.chunkStream) {
    assert.equal(chunk.length, 2)
    break
  }
  assert.equal(await run.done, false, 'an abandoned run does not report completion')
  assert.equal(transport.closed, before.closed + 1, 'breaking out closes the RPC stream')
})

test('plain stream: a transport error rejects chunkStream and done', async () => {
  const failure = new Error('worker went away')
  scripts.push({ frames: [audio([1])], throwAfter: failure })
  const run = textToSpeech({ modelId: 'tts', text: 'Hi.' })
  const chunks: Float32Array[] = []
  await assert.rejects(
    (async () => {
      for await (const chunk of run.chunkStream) chunks.push(chunk)
    })(),
    failure
  )
  assert.equal(chunks.length, 1, 'frames before the failure were delivered')
  await assert.rejects(run.done, failure)
})

test('stream: false exposes empty audio views and resolves buffer', async () => {
  scripts.push({ frames: [audio([1, 2], { sampleRate: 24000 }), audio([3]), terminal()] })
  const run = textToSpeech({ modelId: 'tts', text: 'Hi.', stream: false })
  assert.deepEqual(await run.buffer, [1, 2, 3])
  assert.equal((await run.chunkStream.next()).done, true, 'chunkStream is empty')
  assert.equal((await run.bufferStream.next()).done, true, 'bufferStream is empty')
  assert.equal(await run.done, true)
})

test('sentence stream: chunkStream yields per frame alongside chunkUpdates', async () => {
  scripts.push({
    frames: [
      audio([1, 2], { sampleRate: 24000, chunkIndex: 0, sentenceChunk: 'One.' }),
      audio([3], { chunkIndex: 1, sentenceChunk: 'Two.', isLast: true }),
      terminal()
    ]
  })
  const run = textToSpeech({ modelId: 'tts', text: 'One. Two.', sentenceStream: true })
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
  assert.deepEqual(chunks, [[1, 2], [3]])
  assert.equal(updates.length, 2)
  assert.equal(await run.done, true)
})
