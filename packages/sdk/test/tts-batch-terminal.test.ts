import { mock, test } from 'node:test'
import assert from 'node:assert/strict'

let returned = false
mock.module('@/client/rpc/rpc-client', {
  namedExports: {
    stream: async function* () {
      try {
        yield {
          type: 'textToSpeech',
          buffer: [1, 2],
          done: false,
          text: 'Four.',
          sampleRate: 24000
        }
        yield { type: 'textToSpeech', buffer: [], done: true, stopReason: 'completed' }
        await new Promise(() => {})
      } finally {
        returned = true
      }
    },
    duplex: async () => {
      throw new Error('unused')
    }
  }
})

const { textToSpeech } = await import('@/client/api/text-to-speech')
test('batch TTS settles PCM and reply text at its terminal frame without waiting for transport EOF', async () => {
  const run = textToSpeech({ modelId: 'moss-speech', text: 'What is two plus two?', stream: false })
  const result = await Promise.race([
    run.buffer,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('batch TTS did not settle')), 1000)
    )
  ])
  assert.deepEqual(result, [1, 2])
  assert.equal(await run.text, 'Four.')
  assert.equal(await run.done, true)
  assert.equal(await run.sampleRate, 24000)
  assert.equal(returned, true)
})
