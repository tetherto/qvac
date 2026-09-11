import test from 'brittle'
import { createTtsSideChannel } from '@/api/text-to-speech'

// The side channel carries sampleRate / stats / stopReason off the response
// frames to the promises on TextToSpeechStreamResult. Two properties matter:
// sampleRate resolves on the FIRST frame that carries one (a caller opening an
// audio device must not have to drain the audio first), and every promise
// settles — never rejects — once the stream ends, however it ends.

function frame(extra: Record<string, unknown>) {
  return { type: 'textToSpeech' as const, buffer: [], done: false, ...extra }
}

async function isPending(promise: Promise<unknown>) {
  const marker = Symbol('pending')
  const result = await Promise.race([promise, Promise.resolve(marker)])
  return result === marker
}

test('sampleRate resolves on the first frame that carries one, before the stream ends', async (t) => {
  const side = createTtsSideChannel()
  t.is(await isPending(side.sampleRate), true)

  side.observe(frame({ buffer: [1] }))
  t.is(await isPending(side.sampleRate), true, 'a frame without a rate does not resolve it')

  side.observe(frame({ buffer: [1], sampleRate: 48000 }))
  t.is(await side.sampleRate, 48000)

  side.observe(frame({ buffer: [1], sampleRate: 16000 }))
  t.is(await side.sampleRate, 48000, 'the first reported rate wins')
})

test('stats and stopReason resolve from the terminal frame at settle()', async (t) => {
  const side = createTtsSideChannel()
  side.observe(frame({ stats: { audioDuration: 1 } }))
  side.observe(frame({ done: true, stats: { audioDuration: 2 }, stopReason: 'cancelled' }))
  t.is(await isPending(side.stats), true, 'stats wait for settle()')

  side.settle()
  t.alike(await side.stats, { audioDuration: 2 }, 'the latest stats win')
  t.is(await side.stopReason, 'cancelled')
})

test('settle() with nothing observed resolves every promise to undefined', async (t) => {
  const side = createTtsSideChannel()
  side.settle()
  t.is(await side.sampleRate, undefined)
  t.is(await side.stats, undefined)
  t.is(await side.stopReason, undefined)
})

test('settle() is idempotent and a late observe() cannot change a settled value', async (t) => {
  const side = createTtsSideChannel()
  side.observe(frame({ sampleRate: 24000 }))
  side.settle()
  side.settle()
  side.observe(frame({ sampleRate: 48000, stats: { audioDuration: 9 } }))
  t.is(await side.sampleRate, 24000)
  t.is(await side.stats, undefined)
})
