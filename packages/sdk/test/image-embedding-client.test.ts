import test from 'brittle'
import { createEmbedImageCall } from '@/client/api/embed-image'
import { InvalidResponseError, RequestValidationFailedError } from '@/utils/errors-client'
import { InferenceCancelledError } from '@/utils/errors-server'

const image = new Uint8Array([1, 2, 3])
const embedding = [1, ...new Array(8447).fill(0)]

test('embedImage client encodes bytes, exposes requestId and preserves stats', async (t) => {
  let sent: unknown
  const stats = { totalTime: 10, backendId: 0 }
  const send = async (input: unknown, options: unknown) => {
    sent = { input, options }
    return { type: 'embedImage', embedding, stats }
  }
  const call = createEmbedImageCall(
    { modelId: 'm', image, width: 1, height: 1, channels: 3 },
    { timeout: 1000 },
    send as never
  )
  t.ok(call.requestId)
  t.alike(await call, { embedding, stats })
  t.alike(sent, {
    input: {
      type: 'embedImage',
      modelId: 'm',
      image: 'AQID',
      width: 1,
      height: 1,
      channels: 3,
      requestId: call.requestId
    },
    options: { timeout: 1000 }
  })
})

test('embedImage client rejects invalid images before RPC and malformed replies', async (t) => {
  let sends = 0
  const send = async () => {
    sends++
    return { type: 'embedImage', embedding }
  }
  for (const params of [
    { image: new Uint8Array() },
    { width: 1 },
    { width: 1, height: 2, channels: 3 },
    { image: 'AQID' }
  ]) {
    await t.exception(
      createEmbedImageCall({ modelId: 'm', image, ...params } as never, undefined, send as never),
      RequestValidationFailedError as unknown as new () => Error
    )
  }
  t.is(sends, 0)
  for (const reply of [
    { type: 'embed' },
    { type: 'embedImage', embedding: [1] },
    { type: 'embedImage', embedding: [NaN, ...embedding.slice(1)] }
  ]) {
    await t.exception(
      createEmbedImageCall({ modelId: 'm', image }, undefined, (async () => reply) as never),
      InvalidResponseError as unknown as new () => Error
    )
  }
})

test('embedImage client preserves cancellation and worker errors', async (t) => {
  for (const failure of [
    new InferenceCancelledError('image-call'),
    new Error('MegaLoc load failed')
  ]) {
    try {
      await createEmbedImageCall({ modelId: 'm', image }, undefined, (async () => {
        throw failure
      }) as never)
      t.fail('Expected transport failure')
    } catch (error) {
      t.is(error, failure)
    }
  }
})
