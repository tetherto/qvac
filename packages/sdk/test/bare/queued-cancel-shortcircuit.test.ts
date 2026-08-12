import test from 'brittle'

// Bare-only: finetune/translate ops pull native bare deps. Proves that an op
// cancelled WHILE QUEUED (before it is admitted) does no native work: finetune
// never calls model.cancel()/model.finetune(), translate never calls model.run().
// Both would otherwise run against peers still holding the shared lane.

let idCounter = 0
function makeId(prefix: string): string {
  idCounter++
  return `${prefix}-${idCounter}-${Date.now()}`
}

test('finetune: cancelled while queued does not call model.cancel() or model.finetune()', async (t) => {
  const [{ registerModel, unregisterModel }, { startFinetune }, { getRequestRegistry }] =
    await Promise.all([
      import('@/server/bare/registry/model-registry'),
      import('@/server/bare/plugins/llamacpp-completion/ops/finetune'),
      import('@/server/bare/runtime')
    ])

  let cancelCalls = 0
  let finetuneCalls = 0
  const model = {
    cancel: async () => {
      cancelCalls++
    },
    finetune: async () => {
      finetuneCalls++
      return { on() {}, removeListener() {}, await: async () => ({ status: 'COMPLETED' }) }
    }
  }

  const modelId = makeId('ft-queued')
  registerModel(modelId, {
    model: model as never,
    path: '/tmp/llm.bin',
    config: { parallel: 2 }
  } as never)

  // A completion holds the shared lane so the exclusive finetune must queue.
  const holder = await getRequestRegistry().begin({
    requestId: makeId('c'),
    kind: 'completion',
    modelId,
    maxConcurrentPerModel: 2
  })

  const ftRequestId = makeId('ft')
  const ftPromise = startFinetune({ modelId, requestId: ftRequestId, options: {} } as never)

  // Let the finetune queue, then cancel it before it is ever admitted.
  await new Promise((r) => setTimeout(r, 20))
  getRequestRegistry().cancel({ requestId: ftRequestId })

  await holder[Symbol.asyncDispose]()
  const result = await ftPromise

  t.is(result.status, 'CANCELLED', 'queued finetune settles CANCELLED')
  t.is(cancelCalls, 0, 'model.cancel() (global) was NOT called')
  t.is(finetuneCalls, 0, 'model.finetune() was NOT called')

  unregisterModel(modelId)
})

test('translate (LLM): cancelled while queued does not call model.run()', async (t) => {
  const [
    { registerModel, unregisterModel },
    { ModelType },
    { translate },
    { getRequestRegistry },
    { InferenceCancelledError }
  ] = await Promise.all([
    import('@/server/bare/registry/model-registry'),
    import('@/schemas'),
    import('@/server/bare/ops/translate'),
    import('@/server/bare/runtime'),
    import('@/utils/errors-server')
  ])

  let runCalls = 0
  const model = {
    run: async () => {
      runCalls++
      return { ids: ['x'], stats: {}, cancel: async () => {}, iterate: async function* () {} }
    }
  }

  const modelId = makeId('tr-queued')
  registerModel(modelId, {
    model: model as never,
    path: '/tmp/llm.bin',
    config: { parallel: 2 },
    modelType: ModelType.llamacppCompletion
  } as never)

  // An exclusive finetune holds the lane so the LLM translate reader must queue.
  const ft = await getRequestRegistry().begin({
    requestId: makeId('ft'),
    kind: 'finetune',
    modelId
  })

  const trRequestId = makeId('tr')
  const gen = translate(
    {
      modelId,
      modelType: ModelType.llamacppCompletion,
      text: 'the river is calm',
      from: 'English',
      to: 'Spanish',
      stream: true
    } as never,
    trRequestId
  )

  // Start draining so begin() runs and the translate queues behind the finetune.
  const drained = (async () => {
    for (;;) {
      const next = await gen.next()
      if (next.done) break
    }
  })()

  await new Promise((r) => setTimeout(r, 20))
  getRequestRegistry().cancel({ requestId: trRequestId })

  let caught: unknown = null
  try {
    await drained
  } catch (err) {
    caught = err
  }

  await ft[Symbol.asyncDispose]()

  t.ok(
    caught instanceof InferenceCancelledError,
    'queued translate rejects with InferenceCancelledError'
  )
  t.is(runCalls, 0, 'model.run() was NOT called')

  unregisterModel(modelId)
})
