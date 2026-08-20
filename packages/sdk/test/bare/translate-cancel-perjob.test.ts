import test from 'brittle'

// Bare-only: server/bare/ops/translate pulls native bare deps. Proves the LLM
// translate path cancels its own run job (response.cancel) and never the
// addon's global cancel — which would kill concurrent completions.

let idCounter = 0
function makeId(prefix: string): string {
  idCounter++
  return `${prefix}-${idCounter}-${Date.now()}`
}

test('translate (LLM): abort cancels the run response, not the addon global cancel', async (t) => {
  const [{ registerModel, unregisterModel }, { ModelType }, { translate }, { getRequestRegistry }] =
    await Promise.all([
      import('@/server/bare/registry/model-registry'),
      import('@/schemas'),
      import('@/server/bare/ops/translate'),
      import('@/server/bare/runtime')
    ])

  let responseCancelCalls = 0
  let addonCancelCalls = 0
  let cancelled = false

  const mockResponse = {
    ids: ['job-1'],
    stats: {},
    cancel: async () => {
      responseCancelCalls++
      cancelled = true
    },
    iterate: async function* () {
      yield 'hola'
      // Keep decoding until the run's own cancel() ends it.
      while (!cancelled) await new Promise<void>((resolve) => setTimeout(resolve, 5))
    }
  }

  const model = {
    run: async () => mockResponse,
    addon: {
      cancel: async () => {
        addonCancelCalls++
      }
    }
  }

  const modelId = makeId('llm-translate-cancel')
  registerModel(modelId, {
    model: model as never,
    path: '/tmp/llm.bin',
    config: { parallel: 2 },
    modelType: ModelType.llamacppCompletion
  } as never)

  const requestId = makeId('tr')
  try {
    const gen = translate(
      {
        modelId,
        modelType: ModelType.llamacppCompletion,
        text: 'the river is calm',
        from: 'English',
        to: 'Spanish',
        stream: true
      } as never,
      requestId
    )

    // Drive past begin() + model.run() (sets the active response) to the first token.
    const first = await gen.next()
    t.is(first.value, 'hola', 'first translated token streamed')

    // Cancel by request id — routes through the op's onAbort.
    getRequestRegistry().cancel({ requestId })

    // Drain the generator to completion.
    for (;;) {
      const next = await gen.next()
      if (next.done) break
    }

    t.is(responseCancelCalls, 1, 'the run response was cancelled (per-job)')
    t.is(addonCancelCalls, 0, 'the addon global cancel was NOT called')
  } finally {
    unregisterModel(modelId)
  }
})
