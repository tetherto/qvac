import { mock, test } from 'node:test'
import assert from 'node:assert/strict'

const block = { text: 'hello' }
const cancelled = new Error('inference cancelled')
const stream = mock.fn(async function* (_request: unknown, _options?: unknown) {
  yield { type: 'ocrStream', blocks: [block] }
  throw cancelled
})
mock.module('@/client/rpc/rpc-client', { namedExports: { stream } })
const { ocr } = await import('@/client/api/ocr')

for (const streaming of [false, true]) {
  // A pending `stats` hangs the test, so the timeout turns that into a failure.
  test(
    `ocr (stream=${streaming}): a failed run rejects stats instead of leaving it pending`,
    { timeout: 5000 },
    async () => {
      const run = ocr({ modelId: 'model', image: '/tmp/image.png', stream: streaming })

      if (streaming) {
        await assert.rejects(async () => {
          for await (const _ of run.blockStream) {
            // drain until the stream fails
          }
        }, cancelled)
      } else {
        await assert.rejects(run.blocks, cancelled)
      }
      await assert.rejects(run.stats, cancelled)
    }
  )
}
