import test from 'brittle'
import { getRequestRegistry } from '@/runtime/index'
import { registerModel, unregisterModel } from '@/runtime/model-registry'
import { embed } from '@/plugins/ops/embed'
import { InferenceCancelledError } from '@/errors/index'

const MODEL_ID = 'embed-cancel-model'

// The real addon rejects a cancelled job with its own `Job cancelled` error.
// `cancel()` here does not settle the pending job on its own; the test does,
// so the op's error mapping is what decides the outcome.
function fakeEmbedModel(jobError: Error) {
  let fail!: () => void
  const job = new Promise<never>((_resolve, reject) => {
    fail = () => reject(jobError)
  })
  const model = {
    cancelCalls: 0,
    failJob: () => fail(),
    addon: {
      async cancel() {
        model.cancelCalls++
      }
    },
    async run() {
      return { await: () => job }
    }
  }
  return model
}

function register(model: unknown) {
  registerModel(MODEL_ID, {
    model: model as never,
    path: '/tmp/embed.bin',
    config: {},
    modelType: 'llamacpp-embedding'
  })
}

test('embed maps the addon error after a cancel to InferenceCancelledError', async (t) => {
  const model = fakeEmbedModel(new Error('Job cancelled'))
  register(model)
  try {
    const pending = embed({ modelId: MODEL_ID, text: 'hello' }, 'embed-cancel-1')
    pending.catch(() => {})
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    await getRequestRegistry().cancel({ requestId: 'embed-cancel-1' })
    t.is(model.cancelCalls, 1, 'the abort reached the addon')
    model.failJob()
    await t.exception(pending, InferenceCancelledError as unknown as new () => Error)
    t.is(getRequestRegistry().list().length, 0, 'the request left the registry')
  } finally {
    unregisterModel(MODEL_ID)
  }
})

test('embed passes an addon error through when nothing cancelled the request', async (t) => {
  const model = fakeEmbedModel(new Error('predict: llama_decode failed'))
  register(model)
  try {
    const pending = embed({ modelId: MODEL_ID, text: 'hello' }, 'embed-cancel-2')
    pending.catch(() => {})
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    model.failJob()
    await t.exception(pending, /llama_decode failed/)
    t.is(model.cancelCalls, 0)
  } finally {
    unregisterModel(MODEL_ID)
  }
})
