import Buffer from 'bare-buffer'
import test from 'brittle'
import { withTtsRequest } from '@/plugins/builtin/tts-ggml/ops/request-lifecycle'
import { getRequestRegistry } from '@/runtime/request-context'
import { registerModel, unregisterModel, type AnyModel } from '@/runtime/model-registry'
import { ModelType } from '@/schemas'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}
function register(id: string, model: unknown) {
  registerModel(id, {
    model: model as AnyModel,
    path: id,
    config: {},
    modelType: ModelType.ttsGgml
  })
}

test('TTS cancellation before admission never runs or cancels the shared model', async (t) => {
  const modelId = 'tts-before'
  let touched = false
  register(modelId, {
    cancel: async () => {
      touched = true
    }
  })
  getRequestRegistry().cancel({ requestId: 'tts-before-request' })
  const source = withTtsRequest({ modelId, requestId: 'tts-before-request' }, async function* () {
    touched = true
    yield 1
  })
  try {
    await t.exception(source.next(), /cancel/i)
    t.is(touched, false)
  } finally {
    unregisterModel(modelId)
  }
})

test('TTS holds admission through native cancellation and does not cancel its successor', async (t) => {
  t.timeout(5000)
  const modelId = 'tts-drain'
  const releaseCancel = deferred()
  let cancels = 0
  let successorStarted = false
  register(modelId, {
    cancel: async () => {
      cancels++
      await releaseCancel.promise
    }
  })
  const first = withTtsRequest({ modelId, requestId: 'tts-drain-first' }, async function* () {
    yield 1
    yield 2
  })
  const second = withTtsRequest({ modelId, requestId: 'tts-drain-second' }, async function* () {
    successorStarted = true
    yield 3
  })
  try {
    t.is((await first.next()).value, 1)
    const nextSecond = second.next()
    t.is(getRequestRegistry().cancel({ requestId: 'tts-drain-first' }), 1)
    const cancelled = t.exception(first.next(), /cancel/i)
    await new Promise((resolve) => setTimeout(resolve, 20))
    t.is(successorStarted, false, 'successor waits for cancellation barrier')
    releaseCancel.resolve()
    await cancelled
    t.is((await nextSecond).value, 3)
    const atStart = cancels
    t.is((await second.next()).done, true)
    t.is(cancels, atStart, 'completed successor was not cancelled')
  } finally {
    releaseCancel.resolve()
    await first.return(undefined)
    await second.return(undefined)
    unregisterModel(modelId)
  }
})

test('TTS queued cancellation leaves the active model untouched', async (t) => {
  t.timeout(5000)
  const modelId = 'tts-queued'
  let cancels = 0
  let queuedRan = false
  register(modelId, {
    cancel: async () => {
      cancels++
    }
  })
  const active = withTtsRequest({ modelId, requestId: 'tts-queued-active' }, async function* () {
    yield 1
  })
  const queued = withTtsRequest({ modelId, requestId: 'tts-queued-waiter' }, async function* () {
    queuedRan = true
    yield 2
  })
  try {
    await active.next()
    const waiting = queued.next()
    getRequestRegistry().cancel({ requestId: 'tts-queued-waiter' })
    await t.exception(waiting, /cancel/i)
    t.is(queuedRan, false)
    t.is(cancels, 0)
    t.is((await active.next()).done, true)
  } finally {
    await active.return(undefined)
    await queued.return(undefined)
    unregisterModel(modelId)
  }
})

test('TTS consumer abandonment cancels and closes the source, using addon fallback', async (t) => {
  const modelId = 'tts-abandoned'
  let cancelled = false
  let closed = false
  register(modelId, {
    addon: {
      cancel: async () => {
        cancelled = true
      }
    }
  })
  const source = withTtsRequest({ modelId }, async function* () {
    try {
      yield 1
      yield 2
    } finally {
      closed = true
    }
  })
  try {
    await source.next()
    await source.return(undefined)
    t.is(cancelled, true)
    t.is(closed, true)
    t.is(getRequestRegistry().cancel({ modelId, kind: 'tts' }), 0)
  } finally {
    unregisterModel(modelId)
  }
})

// Exercise the production op boundaries, not just the lifecycle helper.
import { textToSpeech } from '@/plugins/builtin/tts-ggml/ops/text-to-speech'
import { textToSpeechStream } from '@/plugins/builtin/tts-ggml/ops/text-to-speech-stream'

for (const mode of ['plain', 'sentence', 'duplex'] as const) {
  test(`TTS ${mode} cancellation during asynchronous startup stops the later job`, async (t) => {
    t.timeout(5000)
    const modelId = `tts-startup-${mode}`
    const entered = deferred()
    const start = deferred()
    let active = false
    let iterated = false
    let cancelledAfterStart = false
    const run = async () => {
      entered.resolve()
      await start.promise
      active = true
      return {
        iterate: async function* () {
          iterated = true
          // No text arrives in this fixture; without the startup abort check,
          // the duplex response would wait here indefinitely.
          await new Promise<void>(() => {})
          yield { outputArray: [1] }
        }
      }
    }
    register(modelId, {
      run,
      runStream: run,
      runStreaming: run,
      cancel: async () => {
        if (active) {
          active = false
          cancelledAfterStart = true
        }
      }
    })
    const requestId = `tts-startup-request-${mode}`
    const source = withTtsRequest({ modelId, requestId }, (ensureActive) =>
      mode === 'duplex'
        ? textToSpeechStream(
            {
              type: 'textToSpeechStream',
              modelId,
              inputType: 'text'
            },
            {
              async *[Symbol.asyncIterator]() {
                yield Buffer.from('hello')
              }
            },
            ensureActive
          )
        : textToSpeech(
            {
              type: 'textToSpeech',
              modelId,
              inputType: 'text',
              text: 'Hello',
              stream: true,
              sentenceStream: mode === 'sentence'
            },
            ensureActive
          )
    )
    try {
      const rejected = t.exception(source.next(), /cancel/i)
      await entered.promise
      t.is(getRequestRegistry().cancel({ requestId }), 1)
      start.resolve()
      await rejected
      t.is(active, false)
      t.is(cancelledAfterStart, true)
      t.is(iterated, false, 'does not wait for output after cancelled startup')
      t.is(getRequestRegistry().cancel({ modelId, kind: 'tts' }), 0)
    } finally {
      start.resolve()
      unregisterModel(modelId)
    }
  })
}

test('TTS cancellation failure still closes the source and releases admission', async (t) => {
  const modelId = 'tts-cancel-failure'
  let closed = false
  register(modelId, {
    cancel: async () => {
      throw new Error('cancel failed')
    }
  })
  const source = withTtsRequest({ modelId }, async function* () {
    try {
      yield 1
    } finally {
      closed = true
    }
  })
  try {
    await source.next()
    await t.exception(source.return(undefined), /cancel failed/)
    t.is(closed, true)
    t.is(getRequestRegistry().cancel({ modelId, kind: 'tts' }), 0)
    const successor = withTtsRequest({ modelId }, async function* () {
      return 9
    })
    t.is((await successor.next()).value, 9)
  } finally {
    unregisterModel(modelId)
  }
})

for (const failure of ['source', 'cleanup'] as const) {
  test(`TTS ${failure} errors report failed lifecycle state and release admission`, async (t) => {
    const modelId = `tts-error-${failure}`
    const requestId = `tts-error-request-${failure}`
    register(modelId, { cancel: async () => {} })
    const source = withTtsRequest({ modelId, requestId }, async function* () {
      try {
        yield 1
        if (failure === 'source') throw new Error('source failure')
      } finally {
        if (failure === 'cleanup') throw new Error('cleanup failure')
      }
    })
    try {
      await source.next()
      const context = getRequestRegistry().get(requestId)!
      await t.exception(failure === 'source' ? source.next() : source.return(undefined), /failure/)
      t.is(context.state, 'failed')
      t.is(getRequestRegistry().get(requestId), null)
      const successor = withTtsRequest({ modelId }, async function* () {
        return 7
      })
      t.is((await successor.next()).value, 7)
    } finally {
      unregisterModel(modelId)
    }
  })
}
