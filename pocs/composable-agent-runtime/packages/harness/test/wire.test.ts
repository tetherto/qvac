import test from 'brittle'
import AbortController from '#abort-controller'
import {
  connectHarness,
  createHarness,
  duplexPair,
  serveHarness,
  type HarnessEvent,
  type SdkRuntimePort
} from '../index.ts'

function createTraceId() {
  return `harness-wire-test-${Math.random().toString(36).slice(2)}`
}

async function collect(events: AsyncIterable<HarnessEvent>) {
  const result: HarnessEvent[] = []
  for await (const event of events) result.push(event)
  return result
}

function createFakeSdk(onAbort: () => void): SdkRuntimePort {
  return {
    loadModel: async ({ model }) => ({ modelId: model }),
    completion: ({ requestId, signal }) => ({
      requestId,
      events: (async function* () {
        yield { type: 'content-delta' as const, text: 'one' }
        await new Promise<void>((resolve) => {
          if (signal.aborted) return resolve()
          signal.addEventListener('abort', () => resolve(), { once: true })
        })
        if (signal.aborted) onAbort()
      })()
    }),
    cancel: async () => {},
    heartbeat: async () => ({ ok: true }),
    close: async () => {}
  }
}

test('generated HRPC client/server streams completion and cancellation', async (t) => {
  let aborted = false
  const [server, client] = duplexPair()
  serveHarness(server, createHarness({ sdk: createFakeSdk(() => (aborted = true)) }))
  const remote = connectHarness(() => client)
  const controller = new AbortController()
  const traceId = createTraceId()
  const events: HarnessEvent[] = []

  for await (const event of remote.run({
    runId: 'wire-run',
    traceId,
    model: 'model',
    messages: [{ role: 'user', content: 'hello' }],
    signal: controller.signal
  })) {
    events.push(event)
    controller.abort('stop')
  }

  t.alike(events, [{ type: 'content', text: 'one' }, { type: 'aborted' }])
  t.ok(aborted, 'destroying the HRPC request stream aborts the server run')
  remote.close()
})

test('wire mapping never silently drops an unknown SDK event', async (t) => {
  const sdk: SdkRuntimePort = {
    loadModel: async () => ({ modelId: 'm' }),
    completion: ({ requestId }) => ({
      requestId,
      events: (async function* () {
        yield { type: 'future-event' as never }
      })()
    }),
    cancel: async () => {},
    heartbeat: async () => ({ ok: true }),
    close: async () => {}
  }
  const harness = createHarness({ sdk })
  const events = await collect(
    harness.run({ runId: 'unknown', model: 'm', messages: [], signal: new AbortController().signal })
  )
  t.is(events.length, 1)
  const event = events[0]
  t.is(event?.type, 'error')
  if (event?.type === 'error') {
    t.is(event.message, 'unmapped SDK event: future-event')
    t.is(event.error?.code, '59202')
  }
})
