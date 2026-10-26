import test from 'brittle'
import {
  TtsMulticast,
  pcmChunksOf,
  samplesOf,
  sentenceAudioViews
} from '@/client/api/text-to-speech'
import type { TtsResponse } from '@qvac/sdk'

// Push-controlled frame source (same shape as tts-multicast.test.ts) so the
// test decides exactly when each frame becomes available.
function createPushSource() {
  const queue: TtsResponse[] = []
  let waiter: (() => void) | undefined
  let ended = false
  const notify = () => {
    const w = waiter
    waiter = undefined
    if (w) w()
  }
  return {
    push(item: TtsResponse) {
      queue.push(item)
      notify()
    },
    end() {
      ended = true
      notify()
    },
    iterable: {
      async *[Symbol.asyncIterator]() {
        while (true) {
          if (queue.length > 0) {
            yield queue.shift() as TtsResponse
            continue
          }
          if (ended) return
          await new Promise<void>((r) => {
            waiter = r
          })
        }
      }
    }
  }
}

const frame = (buffer: number[], extra: Partial<TtsResponse> = {}): TtsResponse =>
  ({ type: 'textToSpeech', buffer, done: false, ...extra }) as TtsResponse

test('chunkStream yields one Float32Array per audio frame and matches the sample stream', async (t) => {
  const frames = [
    frame([0.1, -0.2, 0.3], { sampleRate: 44100 }),
    frame([]),
    frame([0.5, 0.25]),
    frame([-1, 1, 0], { done: true, stats: { totalTimeMs: 1 } as never })
  ]
  async function* fixed() {
    yield* frames
  }

  const chunks: Float32Array[] = []
  for await (const c of pcmChunksOf(fixed())) chunks.push(c)

  t.is(chunks.length, 3, 'empty frames are skipped')
  t.ok(chunks.every((c) => c instanceof Float32Array))
  t.alike(Array.from(chunks[0] as Float32Array), Array.from(Float32Array.from([0.1, -0.2, 0.3])))

  const concatenated = chunks.flatMap((c) => Array.from(c))
  const samples: number[] = []
  for await (const s of samplesOf(pcmChunksOf(fixed()))) samples.push(s)
  t.alike(samples, concatenated, 'flattened chunks equal the per-sample stream')

  const expected = Array.from(Float32Array.from(frames.flatMap((f) => f.buffer)))
  t.alike(concatenated, expected, 'chunks carry every sample of every frame, in order')
})

test('chunkStream stops at the terminal frame', async (t) => {
  async function* fixed() {
    yield frame([1, 2], { done: true })
    yield frame([3, 4])
  }
  const chunks: Float32Array[] = []
  for await (const c of pcmChunksOf(fixed())) chunks.push(c)
  t.is(chunks.length, 1)
})

test('the first chunk is delivered before later frames exist', async (t) => {
  const source = createPushSource()
  const chunks = pcmChunksOf(source.iterable)

  const first = chunks.next()
  source.push(frame([0.5, 0.5, 0.5], { sampleRate: 24000 }))
  const got = await first
  t.is(got.done, false)
  t.is((got.value as Float32Array).length, 3, 'first chunk arrives on the first frame alone')

  const second = chunks.next()
  source.push(frame([0.1], { done: true }))
  t.is(((await second).value as Float32Array).length, 1)
  t.is((await chunks.next()).done, true)
  source.end()
})

test('sample view and chunk view share one run', async (t) => {
  async function* fixed() {
    yield frame([1, 2, 3], { done: true })
  }
  const chunks = pcmChunksOf(fixed())
  const samples = samplesOf(chunks)
  const seen: number[] = []
  for await (const s of samples) seen.push(s)
  t.alike(seen, [1, 2, 3])
  t.is((await chunks.next()).done, true, 'the chunk iterator is consumed with the sample view')
})

function queueSize(mc: TtsMulticast): number {
  return (mc as unknown as { queue: TtsResponse[] }).queue.length
}

test('an un-iterated chunkStream does not pin the sentence-mode multicast queue', async (t) => {
  const source = createPushSource()
  const mc = new TtsMulticast(source.iterable)
  const audio = sentenceAudioViews(mc.subscribe())
  const updates = mc.subscribe()
  for (let i = 0; i < 100; i++) source.push(frame([i, i + 0.5], { done: i === 99 }))
  source.end()

  let samples = 0
  for await (const _ of audio.bufferStream) samples++
  for await (const m of updates) if (m.done) break
  await mc.done

  t.is(samples, 200)
  t.is(queueSize(mc), 0, 'every frame was released although chunkStream was never iterated')
  t.is((await audio.chunkStream.next()).done, true)
})

test('draining chunkStream instead of bufferStream releases the queue too', async (t) => {
  const source = createPushSource()
  const mc = new TtsMulticast(source.iterable)
  const audio = sentenceAudioViews(mc.subscribe())
  const updates = mc.subscribe()
  for (let i = 0; i < 100; i++) source.push(frame([i], { done: i === 99 }))
  source.end()

  let chunks = 0
  for await (const _ of audio.chunkStream) chunks++
  for await (const m of updates) if (m.done) break
  await mc.done

  t.is(chunks, 100)
  t.is(queueSize(mc), 0)
})
