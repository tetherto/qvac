import test from 'brittle'
import AbortController from '#abort-controller'
import { connectHarness } from '../lib/connect.ts'
import { createHarnessService as createHarness } from '../lib/harness.ts'
import { serveHarness } from '../lib/serve.ts'
import type { SdkRuntimePort } from '../lib/sdk-runtime-port.ts'
import { duplexPair } from '../lib/transport.ts'
import { createRemoteToolApprovalPort } from '../lib/approval-port.ts'
import { fixtureSkills } from './skill-fixtures.ts'
import type { HarnessEvent } from '../lib/types.ts'

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
    generateImage: async () => {
      throw new Error('image generation is not configured in this test')
    },
    cancel: async () => {},
    heartbeat: async () => ({ ok: true }),
    close: async () => {}
  }
}

test('an approval crosses the wire and its decision reaches the tool gate', async (t) => {
  const [server, client] = duplexPair()
  let round = 0
  const sdk: SdkRuntimePort = {
    loadModel: async ({ model }) => ({ modelId: model }),
    completion: ({ requestId }) => ({
      requestId,
      events: (async function* () {
        round++
        if (round > 1) {
          yield { type: 'content-delta' as const, text: 'done' }
          return
        }
        yield {
          type: 'tool-call' as const,
          id: 'call-1',
          name: 'danger',
          arguments: { path: 'x' }
        }
      })()
    }),
    generateImage: async () => {
      throw new Error('image generation is not configured in this test')
    },
    cancel: async () => {},
    heartbeat: async () => ({ ok: true }),
    close: async () => {}
  }
  const executed: string[] = []
  const approvalPort = createRemoteToolApprovalPort()
  const harness = createHarness({
    sdk,
    skills: fixtureSkills(),
    tools: [
      {
        schema: {
          type: 'function',
          name: 'danger',
          description: 'A tool that needs approval',
          parameters: { type: 'object', properties: {} }
        }
      }
    ],
    toolBroker: {
      async execute(input) {
        executed.push(input.call.name)
        return { ok: true }
      },
      async cancel() {},
      async close() {}
    },
    toolApproval: approvalPort.port
  })
  serveHarness(server, harness, undefined, undefined, approvalPort.attach)
  const remote = connectHarness(() => client)

  await remote.registerAgent({
    id: 'approver',
    model: 'm',
    skills: ['danger'],
    toolPolicy: { allow: ['danger'], requireApproval: ['danger'] }
  })

  // registerAgent opened the session, so the approvals stream attaches here
  // before the run starts and no request can be missed.
  const pending = remote.watchApprovals()
  // Frames are ordered on the shared stream, so a completed round-trip proves
  // the child has processed the approvals stream open.
  await remote.describeRuntime()
  const seen: string[] = []
  const answering = (async () => {
    for await (const request of pending) {
      seen.push(request.name)
      await remote.resolveApproval({ approvalId: request.approvalId, approved: true })
      return
    }
  })()

  const events = await collect(
    remote.runAgent({ agentId: 'approver', runId: 'wire-approval', input: 'go' })
  )
  await answering

  t.alike(seen, ['danger'], 'the host observed the approval request')
  t.alike(executed, ['danger'], 'the approved tool ran')
  t.is(events.some((event) => event.type === 'error'), false)
  await harness.close()
})

test('a tool needing approval is denied when nothing is watching', async (t) => {
  const [server, client] = duplexPair()
  const sdk: SdkRuntimePort = {
    loadModel: async ({ model }) => ({ modelId: model }),
    completion: ({ requestId }) => ({
      requestId,
      events: (async function* () {
        yield {
          type: 'tool-call' as const,
          id: 'call-1',
          name: 'danger',
          arguments: {}
        }
      })()
    }),
    generateImage: async () => {
      throw new Error('image generation is not configured in this test')
    },
    cancel: async () => {},
    heartbeat: async () => ({ ok: true }),
    close: async () => {}
  }
  const executed: string[] = []
  const approvalPort = createRemoteToolApprovalPort()
  const harness = createHarness({
    sdk,
    skills: fixtureSkills(),
    tools: [
      {
        schema: {
          type: 'function',
          name: 'danger',
          description: 'A tool that needs approval',
          parameters: { type: 'object', properties: {} }
        }
      }
    ],
    toolBroker: {
      async execute(input) {
        executed.push(input.call.name)
        return { ok: true }
      },
      async cancel() {},
      async close() {}
    },
    toolApproval: approvalPort.port
  })
  serveHarness(server, harness, undefined, undefined, approvalPort.attach)
  const remote = connectHarness(() => client)

  await remote.registerAgent({
    id: 'unwatched',
    model: 'm',
    skills: ['danger'],
    toolPolicy: { allow: ['danger'], requireApproval: ['danger'] }
  })
  const events = await collect(
    remote.runAgent({ agentId: 'unwatched', runId: 'wire-denied', input: 'go' })
  )

  t.alike(executed, [], 'approval fails closed with no listener')
  t.is(events.at(-1)?.type, 'error')
  await harness.close()
})

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
    generateImage: async () => {
      throw new Error('image generation is not configured in this test')
    },
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
