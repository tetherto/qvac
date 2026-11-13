import test from 'brittle'
import { registerModel, unregisterModel } from '@/runtime/model-registry'
import { getRequestRegistry } from '@/runtime/request-context'
import Buffer from 'bare-buffer'
import { transcribe, transcribeStream } from '@/plugins/ops/transcribe'
import { bciTranscribe, bciTranscribeStream } from '@/plugins/ops/bci-transcribe'
import { InferenceCancelledError } from '@/errors/index'
import { ModelType } from '@/schemas'
import { openTestSessions } from './fixtures/sessions'

// Whisper and the BCI addon cancel model-wide, with no job id. Two sessions
// transcribing on one model must not reach each other's job through that cancel.

test('transcribe: cancelling a queued request leaves the running one alone', async (t) => {
  openTestSessions(t, 'A', 'B')
  const modelId = `transcribe-session-cancel-${Date.now()}`
  let addonCancelCalls = 0
  let runs = 0
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const model = {
    async run() {
      runs++
      return {
        async *iterate() {
          await gate
          yield [{ text: 'first' }]
        },
        stats: {}
      }
    },
    async reload() {},
    addon: {
      async cancel() {
        addonCancelCalls++
      }
    }
  }
  registerModel(modelId, {
    model: model as never,
    path: '/tmp/whisper.gguf',
    config: { audio_format: 's16le' } as never,
    modelType: ModelType.whispercppTranscription
  } as never)
  const request = { modelId, audioChunk: { type: 'base64', value: '' } } as never

  try {
    const running = transcribe(request, 'a-1', 'A')
    const firstChunk = running.next()
    const queued = transcribe(request, 'b-1', 'B')
    const queuedStep = queued.next()
    await new Promise<void>((resolve) => setTimeout(resolve, 5))
    t.is(runs, 1, 'the second request waits in the registry, not in the addon')

    t.is(getRequestRegistry().cancel({ requestId: 'b-1', sessionId: 'B' }), 1)
    await t.exception(queuedStep, InferenceCancelledError as unknown as new () => Error)
    t.is(addonCancelCalls, 0, 'the cancel never reached the addon')

    release()
    t.is((await firstChunk).value, 'first', 'the running request finishes')
    await running.return(undefined as never)
  } finally {
    unregisterModel(modelId)
  }
})

// A model-wide cancel of a running parakeet stream leaves its stream state to
// the next session, so an aborted stream ends its input instead and drains.
test('transcribe stream: an abort ends the input instead of cancelling the model', async (t) => {
  const modelId = `transcribe-stream-abort-${Date.now()}`
  let addonCancelCalls = 0
  let inputEnded = false
  const model = {
    async runStreaming(input: AsyncIterable<unknown>) {
      return {
        async *iterate() {
          for await (const _ of input) yield [{ text: 'chunk' }]
          inputEnded = true
        },
        async await() {},
        stats: {}
      }
    },
    async reload() {},
    addon: {
      async cancel() {
        addonCancelCalls++
      }
    }
  }
  registerModel(modelId, {
    model: model as never,
    path: '/tmp/whisper.gguf',
    config: { audio_format: 's16le' } as never,
    modelType: ModelType.whispercppTranscription
  } as never)
  // Live audio: the caller never ends it.
  const audio = (async function* () {
    yield Buffer.from('a')
    await new Promise(() => {})
  })()

  try {
    const stream = transcribeStream(modelId, audio as never, undefined, false, undefined, 's-1')
    t.is((await stream.next()).value, 'chunk')

    t.is(getRequestRegistry().cancel({ requestId: 's-1' }), 1)

    t.ok((await stream.next()).done, 'the stream ends')
    t.ok(inputEnded, 'the session saw its input end')
    t.is(addonCancelCalls, 0, 'the model was not cancelled')
  } finally {
    unregisterModel(modelId)
  }
})

function registerBciModel(modelId: string) {
  const state = { cancelCalls: 0, runs: 0, release: () => {} }
  const gate = new Promise<void>((resolve) => {
    state.release = resolve
  })
  const response = () => {
    state.runs++
    return {
      async *iterate() {
        await gate
        yield [{ text: 'first' }]
      }
    }
  }
  registerModel(modelId, {
    model: {
      transcribe: async () => response(),
      transcribeFile: async () => response(),
      transcribeStream: async () => response(),
      async cancel() {
        state.cancelCalls++
      }
    } as never,
    path: '/tmp/bci.gguf',
    config: {} as never,
    modelType: ModelType.bciWhispercppTranscription
  } as never)
  return state
}

test('bci transcribe: cancelling a queued request leaves the running one alone', async (t) => {
  openTestSessions(t, 'A', 'B')
  const modelId = `bci-session-cancel-${Date.now()}`
  const model = registerBciModel(modelId)
  const params = { modelId, neuralData: { type: 'base64', value: '' } } as never

  try {
    const running = bciTranscribe(params, 'a-1', 'A')
    const firstChunk = running.next()
    const queued = bciTranscribe(params, 'b-1', 'B')
    const queuedStep = queued.next()
    await new Promise<void>((resolve) => setTimeout(resolve, 5))
    t.is(model.runs, 1, 'the second request waits in the registry, not in the addon')

    t.is(getRequestRegistry().cancel({ requestId: 'b-1', sessionId: 'B' }), 1)
    await t.exception(queuedStep, InferenceCancelledError as unknown as new () => Error)
    t.is(model.cancelCalls, 0, 'the cancel never reached the addon')
    t.is(model.runs, 1, 'the cancelled request never started a native run')

    model.release()
    t.is((await firstChunk).value, 'first', 'the running request finishes')
    await running.return(undefined as never)
  } finally {
    unregisterModel(modelId)
  }
})

test('bci transcribe stream: cancelling a queued stream leaves the running one alone', async (t) => {
  openTestSessions(t, 'A', 'B')
  const modelId = `bci-stream-session-cancel-${Date.now()}`
  const model = registerBciModel(modelId)
  const input = (async function* () {})()

  try {
    const running = bciTranscribeStream(modelId, input, false, undefined, 'a-2', 'A')
    const firstChunk = running.next()
    const queued = bciTranscribeStream(modelId, input, false, undefined, 'b-2', 'B')
    const queuedStep = queued.next()
    await new Promise<void>((resolve) => setTimeout(resolve, 5))
    t.is(model.runs, 1, 'the second stream waits in the registry, not in the addon')

    t.is(getRequestRegistry().cancel({ requestId: 'b-2', sessionId: 'B' }), 1)
    await t.exception(queuedStep, InferenceCancelledError as unknown as new () => Error)
    t.is(model.cancelCalls, 0, 'the cancel never reached the addon')
    t.is(model.runs, 1, 'the cancelled stream never started a native run')

    model.release()
    t.is((await firstChunk).value, 'first', 'the running stream finishes')
    await running.return(undefined as never)
  } finally {
    unregisterModel(modelId)
  }
})
