import test from 'brittle'
import { defineAgent } from '@qvac/agents'
import AbortController from '#abort-controller'
import {
  createChildEntry,
  createSdkModelAdapter,
  createSupervisedSdkPort,
  duplexPair,
  type HarnessRuntime,
  type SdkRuntimePort
} from '../index.ts'

test('child entry constructs SDK only after start', async (t) => {
  let constructions = 0
  let served = false
  let resolveHarness: (harness: HarnessRuntime) => void = () => {}
  const childHarness = new Promise<HarnessRuntime>((resolve) => {
    resolveHarness = resolve
  })
  const sdk: SdkRuntimePort = {
    loadModel: async () => ({ modelId: 'm' }),
    completion: ({ requestId }) => ({
      requestId,
      events: (async function* () {})()
    }),
    cancel: async () => {},
    heartbeat: async () => ({ ok: true }),
    close: async () => {}
  }
  const entry = createChildEntry({
    createSdk: async () => {
      constructions++
      return sdk
    },
    serve: (_stream, harness) => {
      served = true
      resolveHarness(harness)
    }
  })

  t.is(constructions, 0)
  const [stream] = duplexPair()
  await entry(stream)
  t.is(constructions, 0)
  t.ok(served)
  for await (const _event of (await childHarness).run({
    runId: 'lazy-sdk',
    model: 'm',
    messages: [],
    signal: new AbortController().signal
  }));
  t.is(constructions, 1)
  stream.destroy()
})

test('supervised SDK port starts lazily and closes its child', async (t) => {
  let constructions = 0
  let closes = 0
  const port = createSupervisedSdkPort(async () => {
    constructions++
    return {
      loadModel: async () => ({ modelId: 'm' }),
      completion: ({ requestId }) => ({
        requestId,
        events: (async function* () {})()
      }),
      cancel: async () => {},
      heartbeat: async () => ({ ok: true }),
      close: async () => {
        closes++
      }
    }
  })

  t.is(constructions, 0)
  t.alike(await port.heartbeat(), { ok: true })
  t.is(constructions, 1)
  await port.close()
  t.is(closes, 1)
})

test('supervised SDK port restarts after its real exit promise settles', async (t) => {
  let constructions = 0
  let closes = 0
  const exits: Array<
    (exit: { code: number | null; signal: string | null }) => void
  > = []
  const port = createSupervisedSdkPort(async () => {
    const life = ++constructions
    let resolveExit: (exit: {
      code: number | null
      signal: string | null
    }) => void = () => {}
    const exited = new Promise<{
      code: number | null
      signal: string | null
    }>((resolve) => {
      resolveExit = resolve
    })
    exits.push(resolveExit)
    return {
      exited,
      loadModel: async () => ({ modelId: 'm' }),
      completion: ({ requestId }) => ({
        requestId,
        events: (async function* () {})()
      }),
      cancel: async () => {},
      heartbeat: async () => ({ ok: true, life }),
      close: async () => {
        closes++
      }
    }
  })

  t.is(Reflect.get(await port.heartbeat(), 'life'), 1)
  exits[0]?.({ code: 17, signal: null })
  await waitFor(() => constructions === 2)
  t.is(Reflect.get(await port.heartbeat(), 'life'), 2)
  t.is(closes, 1)
  await port.close()
  t.is(closes, 2)
})

test('SDK model adapter executes through @qvac/agents', async (t) => {
  const sdk: SdkRuntimePort = {
    loadModel: async () => ({ modelId: 'm' }),
    completion: ({ requestId }) => ({
      requestId,
      events: (async function* () {
        yield { type: 'contentDelta' as const, text: 'agent output' }
      })()
    }),
    cancel: async () => {},
    heartbeat: async () => ({ ok: true }),
    close: async () => {}
  }
  const agent = defineAgent({ id: 'agent', model: 'm' })
  const run = agent.run({
    runId: 'agent-run',
    input: 'hello',
    adapter: createSdkModelAdapter(sdk)
  })
  const content: string[] = []
  for await (const event of run.events) {
    if (event.type === 'content') content.push(event.text)
  }

  t.alike(content, ['agent output'])
  t.is((await run.result).status, 'completed')
})

async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 2_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for restart')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
