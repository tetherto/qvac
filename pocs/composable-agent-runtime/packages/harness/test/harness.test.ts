import test from 'brittle'
import AbortController from '#abort-controller'
import {
  createHarnessService as createHarness,
  mapSdkEvent
} from '../lib/harness.ts'
import { createMemoryStateAdapter } from '../lib/memory-state.ts'
import type { SdkRuntimePort } from '../lib/sdk-runtime-port.ts'
import type { HarnessEvent } from '../lib/types.ts'

function createTraceId() {
  return `harness-test-${Math.random().toString(36).slice(2)}`
}

async function collect(events: AsyncIterable<HarnessEvent>) {
  const result: HarnessEvent[] = []
  for await (const event of events) result.push(event)
  return result
}

function fakeSdk(): SdkRuntimePort & {
  cancelled: string[]
  traces: string[]
} {
  const cancelled: string[] = []
  const traces: string[] = []
  return {
    cancelled,
    traces,
    loadModel: async ({ model, traceId }) => {
      traces.push(traceId)
      return { modelId: `loaded:${model}` }
    },
    completion: ({ requestId, traceId, signal }) => ({
      requestId,
      events: (async function* () {
        traces.push(traceId)
        yield { type: 'thinking-delta' as const, text: 'plan' }
        yield { type: 'content-delta' as const, text: 'hello' }
        await new Promise<void>((resolve) => {
          if (signal.aborted) return resolve()
          signal.addEventListener('abort', () => resolve(), { once: true })
        })
        if (signal.aborted) yield { type: 'cancelled' as const }
      })()
    }),
    generateImage: async () => {
      throw new Error('image generation is not configured in this test')
    },
    cancel: async ({ requestId }) => {
      cancelled.push(requestId)
    },
    heartbeat: async () => ({ ok: true }),
    close: async () => {}
  }
}

test('streams stable events and persists them in memory', async (t) => {
  const sdk = fakeSdk()
  const state = createMemoryStateAdapter()
  const harness = createHarness({ sdk, state })
  const controller = new AbortController()
  const traceId = createTraceId()
  const events: HarnessEvent[] = []
  const draining = (async () => {
    for await (const event of harness.run({
      runId: 'run-1',
      traceId,
      model: '/model.gguf',
      messages: [{ role: 'user', content: 'hello' }],
      signal: controller.signal
    })) {
      events.push(event)
      if (event.type === 'content') controller.abort('stop')
    }
  })()

  await draining

  t.alike(events, [
    { type: 'thinking', text: 'plan' },
    { type: 'content', text: 'hello' },
    { type: 'aborted' }
  ])
  t.alike(sdk.cancelled, ['run-1'])
  t.alike(sdk.traces, [traceId, traceId])
  t.alike(await state.read('run-1'), events)
  await harness.close()
})

test('serializes SDK failures with the end-to-end trace ID', async (t) => {
  const sdk = fakeSdk()
  sdk.completion = ({ requestId }) => ({
    requestId,
    events: (async function* () {
      throw new Error('model failed')
    })()
  })
  const traceId = createTraceId()
  const harness = createHarness({ sdk })

  const events = await collect(
    harness.run({
      runId: 'failed-run',
      traceId,
      model: '/model.gguf',
      messages: [],
      signal: new AbortController().signal
    })
  )

  t.is(events.length, 1)
  const event = events[0]
  t.is(event?.type, 'error')
  if (event?.type === 'error') {
    t.is(event.message, 'model failed')
    t.is(event.error?.code, '59202')
    t.is(event.error?.traceId, traceId)
    t.is(event.error?.boundary, 'harness->sdk')
    t.is(event.error?.cause?.message, 'model failed')
  }
})

test('already aborted runs do not load a model', async (t) => {
  let loads = 0
  const sdk = fakeSdk()
  sdk.loadModel = async () => {
    loads++
    return { modelId: 'never' }
  }
  const controller = new AbortController()
  controller.abort('stop')
  const harness = createHarness({ sdk })

  t.alike(
    await collect(
      harness.run({
        runId: 'run-pre-aborted',
        model: '/model.gguf',
        messages: [],
        signal: controller.signal
      })
    ),
    [{ type: 'aborted' }]
  )
  t.is(loads, 0)
})

test('legacy run ignores canonical completion metadata', async (t) => {
  const sdk = fakeSdk()
  sdk.completion = ({ requestId }) => ({
    requestId,
    events: (async function* () {
      yield { type: 'content-delta' as const, text: 'legacy content' }
      yield {
        type: 'completion-done' as const,
        raw: { fullText: 'legacy content' }
      }
    })()
  })
  const harness = createHarness({ sdk })

  const events = await collect(harness.run({
    runId: 'legacy-completion-metadata',
    model: '/model.gguf',
    messages: [{ role: 'user', content: 'hello' }],
    signal: new AbortController().signal
  }))

  t.alike(events, [{ type: 'content', text: 'legacy content' }])
  await harness.close()
})

test('completion metadata maps to no user-facing Harness event', (t) => {
  t.is(
    mapSdkEvent({
      type: 'completion-done',
      raw: { fullText: 'canonical output' }
    }),
    null
  )
})
