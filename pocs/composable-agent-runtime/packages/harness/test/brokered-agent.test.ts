import test from 'brittle'
import AbortController from 'bare-abort-controller'
import type { HarnessAgentRegistration } from '../lib/agent-registration.ts'
import {
  createHarnessService,
  type CreateHarnessServiceOptions
} from '../lib/harness.ts'
import { fixtureSkills } from './skill-fixtures.ts'
import { createInMemoryHarnessRunStore } from '../lib/in-memory-harness-run-store.ts'
import type { HarnessRunStore } from '../lib/run-store.ts'
import type { HarnessStateAdapter } from '../lib/types.ts'
import type { SdkRuntimePort } from '../lib/sdk-runtime-port.ts'
import {
  memoizeToolApproval,
  type HarnessTool,
  type HarnessToolApprovalPort,
  type HarnessToolBrokerPort
} from '../lib/tool-broker.ts'
import type { HarnessEvent } from '../lib/types.ts'
import { createRunRegistry } from '../lib/run-registry.ts'

// Skills are application-supplied, so every harness under test declares its
// own catalog. Individual tests may override `skills` to assert catalog rules.
function createHarness(options: CreateHarnessServiceOptions) {
  return createHarnessService({ skills: fixtureSkills(), ...options })
}

const HTTP_TOOL: HarnessTool = {
  schema: {
    type: 'function',
    name: 'http_request',
    description: 'Request an HTTP resource',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to request' }
      },
      required: ['url']
    }
  }
}

const IMAGE_TOOL: HarnessTool = {
  schema: {
    type: 'function',
    name: 'generate_image',
    description: 'Generate an image',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Image prompt' }
      },
      required: ['prompt']
    }
  }
}

const WEATHER_AGENT: HarnessAgentRegistration = {
  id: 'weather-agent',
  model: 'small',
  instructions: 'Use tools when needed.',
  workflow: [{ id: 'answer', prompt: 'Answer: {{input}}' }],
  skills: ['weather'],
  toolPolicy: {
    allow: ['http_request'],
    requireApproval: []
  }
}

function createSdk(
  completion: SdkRuntimePort['completion'],
  cancelled: string[] = []
): SdkRuntimePort {
  return {
    loadModel: async ({ model }) => ({ modelId: `loaded:${model}` }),
    completion,
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

function createBroker(
  execute: HarnessToolBrokerPort['execute'] = async () => ({ ok: true })
): HarnessToolBrokerPort & { calls: string[]; cancellations: string[] } {
  const calls: string[] = []
  const cancellations: string[] = []
  return {
    calls,
    cancellations,
    async execute(input) {
      calls.push(input.call.name)
      return execute(input)
    },
    async cancel(input) {
      cancellations.push(`${input.agentId}/${input.runId}`)
    },
    async close() {}
  }
}

async function collect(events: AsyncIterable<HarnessEvent>) {
  const collected: HarnessEvent[] = []
  for await (const event of events) collected.push(event)
  return collected
}

async function collectError(events: AsyncIterable<HarnessEvent>) {
  try {
    await collect(events)
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error))
  }
  return new Error('expected iteration to fail')
}

async function registerWeatherAgent(
  sdk: SdkRuntimePort,
  broker = createBroker(),
  approval?: HarnessToolApprovalPort
) {
  const harness = createHarness({
    sdk,
    tools: [HTTP_TOOL, IMAGE_TOOL],
    toolBroker: broker,
    ...(approval ? { toolApproval: approval } : {})
  })
  await harness.registerAgent(WEATHER_AGENT)
  return { harness, broker }
}

test('selected skills expose exactly their granted tool schemas', async (t) => {
  const exposedTools: string[][] = []
  const sdk = createSdk(({ requestId, tools }) => ({
    requestId,
    events: (async function* () {
      exposedTools.push(tools?.map((tool) => tool.name) ?? [])
      yield { type: 'content-delta' as const, text: 'sunny' }
    })()
  }))
  const { harness } = await registerWeatherAgent(sdk)

  await collect(harness.runAgent({
    agentId: WEATHER_AGENT.id,
    runId: 'selected-tools',
    input: 'Weather?'
  }))

  t.alike(exposedTools, [['http_request']])
  await harness.close()
})

test('selected skill instructions reach the model as system prompt blocks', async (t) => {
  const systemMessages: string[][] = []
  const sdk = createSdk(({ requestId, messages }) => ({
    requestId,
    events: (async function* () {
      systemMessages.push(
        messages
          .filter((message) => message.role === 'system')
          .map((message) => message.content)
      )
      yield { type: 'content-delta' as const, text: 'sunny' }
    })()
  }))
  const { harness } = await registerWeatherAgent(sdk)

  await collect(harness.runAgent({
    agentId: WEATHER_AGENT.id,
    runId: 'skill-prompt',
    input: 'Weather?'
  }))

  const system = systemMessages[0] ?? []
  t.is(system[0], WEATHER_AGENT.instructions, 'agent instructions come first')
  // Every skill is listed so the model can say when it lacks one.
  t.ok(system[1]?.includes('Available skills:') === true)
  t.ok(system[1]?.includes('image-generation') === true)
  // Only the selected skill contributes its body.
  t.ok(system.some((text) => text.includes('Fixture instructions for the weather skill')))
  t.is(
    system.some((text) => text.includes('Fixture instructions for the notes skill')),
    false,
    'an unselected skill contributes no instructions'
  )
  await harness.close()
})

test('an allowed granted tool without a registered schema fails closed', async (t) => {
  let completions = 0
  const sdk = createSdk(({ requestId }) => {
    completions++
    return {
      requestId,
      events: (async function* () {})()
    }
  })
  const harness = createHarness({
    sdk,
    tools: [],
    toolBroker: createBroker()
  })
  await harness.registerAgent(WEATHER_AGENT)

  const error = await collectError(harness.runAgent({
    agentId: WEATHER_AGENT.id,
    runId: 'missing-schema',
    input: 'Weather?'
  }))

  t.ok(/registered schema.*http_request/i.test(error.message))
  t.is(completions, 0)
  await harness.close()
})

test('approval is memoized for independent checks of one invocation', async (t) => {
  let prompts = 0
  const approval = memoizeToolApproval({
    async approve() {
      prompts++
      return true
    }
  })
  const invocation = {
    agentId: 'agent',
    runId: 'run',
    operationId: 'operation',
    call: {
      id: 'call',
      name: 'http_request',
      arguments: {}
    },
    grants: [{ name: 'http_request', scope: null }],
    signal: new AbortController().signal
  }

  t.is(await approval.approve(invocation), true)
  t.is(await approval.approve(invocation), true)
  t.is(prompts, 1)
})

test('unknown tool calls never reach the broker', async (t) => {
  const sdk = createSdk(({ requestId }) => ({
    requestId,
    events: (async function* () {
      yield {
        type: 'tool-call' as const,
        id: 'missing-1',
        name: 'missing_tool',
        arguments: {}
      }
    })()
  }))
  const { harness, broker } = await registerWeatherAgent(sdk)

  const events = await collect(harness.runAgent({
    agentId: WEATHER_AGENT.id,
    runId: 'unknown-tool',
    input: 'Try a missing tool'
  }))

  t.alike(broker.calls, [])
  t.is(events.at(-1)?.type, 'error')
  await harness.close()
})

test('unselected skill tools never reach the broker', async (t) => {
  const sdk = createSdk(({ requestId }) => ({
    requestId,
    events: (async function* () {
      yield {
        type: 'tool-call' as const,
        id: 'weather-1',
        name: 'http_request',
        arguments: { url: 'https://wttr.in/London?format=3' }
      }
    })()
  }))
  const broker = createBroker()
  const harness = createHarness({
    sdk,
    tools: [HTTP_TOOL, IMAGE_TOOL],
    toolBroker: broker
  })
  await harness.registerAgent({
    ...WEATHER_AGENT,
    id: 'image-agent',
    skills: ['image-generation'],
    toolPolicy: {
      allow: ['http_request', 'generate_image'],
      requireApproval: []
    }
  })

  const events = await collect(harness.runAgent({
    agentId: 'image-agent',
    runId: 'unselected-tool',
    input: 'Try weather'
  }))

  t.alike(broker.calls, [])
  t.is(events.at(-1)?.type, 'error')
  await harness.close()
})

test('policy-denied tool calls never reach the broker', async (t) => {
  const sdk = createSdk(({ requestId }) => ({
    requestId,
    events: (async function* () {
      yield {
        type: 'tool-call' as const,
        id: 'weather-policy',
        name: 'http_request',
        arguments: { url: 'https://wttr.in/London?format=3' }
      }
    })()
  }))
  const broker = createBroker()
  const harness = createHarness({
    sdk,
    tools: [HTTP_TOOL],
    toolBroker: broker
  })
  await harness.registerAgent({
    ...WEATHER_AGENT,
    toolPolicy: {
      allow: [],
      requireApproval: []
    }
  })

  const events = await collect(harness.runAgent({
    agentId: WEATHER_AGENT.id,
    runId: 'policy-denied',
    input: 'Weather?'
  }))

  t.alike(broker.calls, [])
  t.is(events.at(-1)?.type, 'error')
  await harness.close()
})

test('unknown skill names are rejected during registration', async (t) => {
  const sdk = createSdk(({ requestId }) => ({
    requestId,
    events: (async function* () {})()
  }))
  const harness = createHarness({ sdk })

  let message = ''
  try {
    await harness.registerAgent({
      ...WEATHER_AGENT,
      skills: ['missing-skill']
    })
  } catch (error) {
    message = error instanceof Error ? error.message : String(error)
  }

  t.ok(/unknown skill/.test(message))
  await harness.close()
})

test('approval denial prevents broker execution', async (t) => {
  const sdk = createSdk(({ requestId }) => ({
    requestId,
    events: (async function* () {
      yield {
        type: 'tool-call' as const,
        id: 'weather-2',
        name: 'http_request',
        arguments: { url: 'https://wttr.in/London?format=3' }
      }
    })()
  }))
  const approval: HarnessToolApprovalPort = {
    approve: async () => false
  }
  const broker = createBroker()
  const harness = createHarness({
    sdk,
    tools: [HTTP_TOOL],
    toolBroker: broker,
    toolApproval: approval
  })
  await harness.registerAgent({
    ...WEATHER_AGENT,
    toolPolicy: {
      allow: ['http_request'],
      requireApproval: ['http_request']
    }
  })

  const events = await collect(harness.runAgent({
    agentId: WEATHER_AGENT.id,
    runId: 'approval-denied',
    input: 'Weather?'
  }))

  t.alike(broker.calls, [])
  t.is(events.at(-1)?.type, 'error')
  await harness.close()
})

// Regression: the desktop configuration never supplied a toolApproval port, so
// the gate denied every approval-required call and a granted exec could not run
// in production. Only the mocked app tests covered that path.
test('an approval-required tool runs when the configured port approves it', async (t) => {
  let round = 0
  const sdk = createSdk(({ requestId }) => ({
    requestId,
    events: (async function* () {
      round++
      if (round > 1) {
        yield { type: 'content-delta' as const, text: 'London: 22 C' }
        return
      }
      yield {
        type: 'tool-call' as const,
        id: 'weather-approved',
        name: 'http_request',
        arguments: { url: 'https://wttr.in/London?format=3' }
      }
    })()
  }))
  const broker = createBroker()
  const harness = createHarness({
    sdk,
    tools: [HTTP_TOOL],
    toolBroker: broker,
    toolApproval: { approve: async () => true }
  })
  await harness.registerAgent({
    ...WEATHER_AGENT,
    toolPolicy: { allow: ['http_request'], requireApproval: ['http_request'] }
  })

  const events = await collect(harness.runAgent({
    agentId: WEATHER_AGENT.id,
    runId: 'approval-granted',
    input: 'Weather?'
  }))

  t.alike(broker.calls, ['http_request'])
  t.is(events.some((event) => event.type === 'error'), false)
  await harness.close()
})

test('mandatory approval applies to a policy that does not require it', async (t) => {
  const sdk = createSdk(({ requestId }) => ({
    requestId,
    events: (async function* () {
      yield {
        type: 'tool-call' as const,
        id: 'weather-mandatory',
        name: 'http_request',
        arguments: { url: 'https://wttr.in/London?format=3' }
      }
    })()
  }))
  const broker = createBroker()
  let prompts = 0
  const harness = createHarness({
    sdk,
    tools: [HTTP_TOOL],
    toolBroker: broker,
    mandatoryApproval: ['http_request'],
    toolApproval: {
      approve: async () => {
        prompts++
        return false
      }
    }
  })
  // The agent's own policy asks for no approval; the host still requires it.
  await harness.registerAgent(WEATHER_AGENT)

  const events = await collect(harness.runAgent({
    agentId: WEATHER_AGENT.id,
    runId: 'mandatory-approval',
    input: 'Weather?'
  }))

  t.is(prompts, 1)
  t.alike(broker.calls, [])
  t.is(events.at(-1)?.type, 'error')
  await harness.close()
})

test('tool validation rejects before approval and broker execution', async (t) => {
  const sdk = createSdk(({ requestId }) => ({
    requestId,
    events: (async function* () {
      yield {
        type: 'tool-call' as const,
        id: 'weather-invalid',
        name: 'http_request',
        arguments: { url: 'https://wttr.in/blocked' }
      }
    })()
  }))
  let approvals = 0
  const approval: HarnessToolApprovalPort = {
    async approve() {
      approvals++
      return true
    }
  }
  const broker = createBroker()
  const validatingTool: HarnessTool = {
    ...HTTP_TOOL,
    validateCall() {
      throw new Error('runner read-only policy denied the call')
    }
  }
  const harness = createHarness({
    sdk,
    tools: [validatingTool],
    toolBroker: broker,
    toolApproval: approval
  })
  await harness.registerAgent({
    ...WEATHER_AGENT,
    toolPolicy: {
      allow: ['http_request'],
      requireApproval: ['http_request']
    }
  })

  const events = await collect(harness.runAgent({
    agentId: WEATHER_AGENT.id,
    runId: 'validation-before-approval',
    input: 'Weather?'
  }))

  t.is(approvals, 0)
  t.alike(broker.calls, [])
  t.is(events.at(-1)?.type, 'error')
  await harness.close()
})

test('one tool call emits call and result before final agent content', async (t) => {
  const histories: string[][] = []
  let round = 0
  const sdk = createSdk(({ requestId, messages }) => ({
    requestId,
    events: (async function* () {
      histories.push(messages.map((message) => message.role))
      round++
      if (round === 1) {
        yield {
          type: 'tool-call' as const,
          id: 'weather-3',
          name: 'http_request',
          arguments: { url: 'https://wttr.in/London?format=3' }
        }
        return
      }
      yield { type: 'content-delta' as const, text: 'London: 22 C' }
    })()
  }))
  const broker = createBroker(async () => ({ temperature: 22 }))
  const { harness } = await registerWeatherAgent(sdk, broker)

  const events = await collect(harness.runAgent({
    agentId: WEATHER_AGENT.id,
    runId: 'one-tool',
    input: 'Weather?'
  }))

  t.alike(events.map((event) => event.type), ['tool-call', 'tool-result', 'content'])
  // Three system messages: agent instructions, the skills index, and the
  // selected skill's own instructions.
  t.alike(histories, [
    ['system', 'system', 'system', 'user'],
    ['system', 'system', 'system', 'user', 'assistant', 'tool']
  ])
  await harness.close()
})

test('tool progress emits through Harness without entering model history', async (t) => {
  const histories: string[] = []
  let round = 0
  const sdk = createSdk(({ requestId, messages }) => ({
    requestId,
    events: (async function* () {
      round++
      if (round === 1) {
        yield {
          type: 'tool-call' as const,
          id: 'weather-progress',
          name: 'http_request',
          arguments: { url: 'https://wttr.in/London?format=3' }
        }
        return
      }
      histories.push(messages.map((message) => message.content).join('\n'))
      yield { type: 'content-delta' as const, text: 'done' }
    })()
  }))
  const broker = createBroker(async (input) => {
    const reportProgress = Reflect.get(input, 'reportProgress')
    t.is(typeof reportProgress, 'function')
    if (typeof reportProgress === 'function') {
      await reportProgress({
        step: 1,
        totalSteps: 2,
        elapsedMs: 5
      })
    }
    return { temperature: 22 }
  })
  const { harness } = await registerWeatherAgent(sdk, broker)

  const events = await collect(harness.runAgent({
    agentId: WEATHER_AGENT.id,
    runId: 'tool-progress',
    input: 'Weather?'
  }))

  t.alike(events.map((event) => event.type), [
    'tool-call',
    'tool-progress',
    'tool-result',
    'content'
  ])
  t.is(histories[0]?.includes('elapsedMs'), false)
  await harness.close()
})

test('tool history preserves the canonical raw assistant frame verbatim', async (t) => {
  const canonicalRaw = '<tool_call>{"name":"http_request","arguments":{"url":"x"}}</tool_call>'
  const assistantFrames: string[] = []
  let round = 0
  const sdk = createSdk(({ requestId, messages }) => ({
    requestId,
    events: (async function* () {
      round++
      if (round === 1) {
        yield { type: 'content-delta' as const, text: 'normalized text' }
        yield {
          type: 'tool-call' as const,
          id: 'canonical-raw',
          name: 'http_request',
          arguments: { url: 'x' },
          raw: 'partial call raw'
        }
        yield {
          type: 'completion-done' as const,
          raw: { fullText: canonicalRaw }
        }
        return
      }
      const assistant = messages.find((message) => message.role === 'assistant')
      if (assistant) assistantFrames.push(assistant.content)
      yield { type: 'content-delta' as const, text: 'done' }
    })()
  }))
  const { harness } = await registerWeatherAgent(sdk)

  await collect(harness.runAgent({
    agentId: WEATHER_AGENT.id,
    runId: 'canonical-history',
    input: 'Weather?'
  }))

  t.alike(assistantFrames, [canonicalRaw])
  await harness.close()
})

test('model tool loop stops after ten rounds', async (t) => {
  let completions = 0
  const sdk = createSdk(({ requestId }) => ({
    requestId,
    events: (async function* () {
      completions++
      yield {
        type: 'tool-call' as const,
        id: `weather-${completions}`,
        name: 'http_request',
        arguments: { url: 'https://wttr.in/London?format=3' }
      }
    })()
  }))
  const { harness } = await registerWeatherAgent(sdk)

  const events = await collect(harness.runAgent({
    agentId: WEATHER_AGENT.id,
    runId: 'bounded-tools',
    input: 'Keep checking'
  }))

  t.is(completions, 10)
  t.is(events.filter((event) => event.type === 'tool-call').length, 10)
  t.is(events.filter((event) => event.type === 'tool-result').length, 10)
  t.is(events.at(-1)?.type, 'content')
  await harness.close()
})

test('duplicate live run keys are reusable only after terminal state', async (t) => {
  let release: (() => void) | undefined
  let first = true
  const sdk = createSdk(({ requestId, signal }) => ({
    requestId,
    events: (async function* () {
      if (!first) {
        yield { type: 'content-delta' as const, text: 'reused' }
        return
      }
      first = false
      await new Promise<void>((resolve) => {
        release = resolve
        signal.addEventListener('abort', resolve, { once: true })
      })
      if (!signal.aborted) yield { type: 'content-delta' as const, text: 'late' }
    })()
  }), [])
  const { harness } = await registerWeatherAgent(sdk)
  const firstEvents = collect(harness.runAgent({
    agentId: WEATHER_AGENT.id,
    runId: 'same-run',
    input: 'Wait'
  }))
  await waitFor(() => release !== undefined)

  const duplicateError = await collectError(harness.runAgent({
    agentId: WEATHER_AGENT.id,
    runId: 'same-run',
    input: 'Duplicate'
  }))
  t.ok(/already live/.test(duplicateError.message))

  await harness.cancelAgentRun({
    agentId: WEATHER_AGENT.id,
    runId: 'same-run',
    reason: 'done'
  })
  release?.()
  await firstEvents

  const reused = await collect(harness.runAgent({
    agentId: WEATHER_AGENT.id,
    runId: 'same-run',
    input: 'Again'
  }))
  t.alike(reused, [{ type: 'content', text: 'reused' }])
  await harness.close()
})

test('run keys with slashes remain distinct and cancel independently', async (t) => {
  const cancellations: string[] = []
  const first = {
    async cancel(reason?: string) {
      cancellations.push(`first:${reason}`)
    }
  }
  const second = {
    async cancel(reason?: string) {
      cancellations.push(`second:${reason}`)
    }
  }
  const registry = createRunRegistry()
  const firstKey = { agentId: 'a/b', runId: 'c' }
  const secondKey = { agentId: 'a', runId: 'b/c' }
  registry.add(firstKey, first)
  registry.add(secondKey, second)

  await registry.cancel(firstKey, 'one')
  await registry.cancel(secondKey, 'two')

  t.alike(cancellations, ['first:one', 'second:two'])
  registry.remove(firstKey, first)
  registry.remove(secondKey, second)
  await registry.close()
})

test('run registry close surfaces a bounded drain timeout', async (t) => {
  const registry = createRunRegistry({ closeTimeoutMs: 20 })
  const run = {
    async cancel() {}
  }
  registry.add({ agentId: 'stuck-agent', runId: 'stuck-run' }, run)
  const startedAt = Date.now()

  let error: Error | undefined
  try {
    await registry.close()
  } catch (caught) {
    error = caught instanceof Error ? caught : new Error(String(caught))
  }

  t.ok(error instanceof Error)
  t.ok(/timed out.*drain/i.test(error?.message ?? ''))
  t.ok(Date.now() - startedAt < 1_000)
  registry.remove({ agentId: 'stuck-agent', runId: 'stuck-run' }, run)
})

test('Harness isolates persisted and SDK identities for slash-colliding run pairs', async (t) => {
  const completions: Array<{
    readonly requestId: string
    cancelled: boolean
    release: () => void
  }> = []
  const cancellations: string[] = []
  const sdk: SdkRuntimePort = {
    loadModel: async ({ model }) => ({ modelId: model }),
    completion: ({ requestId }) => {
      let release = () => {}
      const ready = new Promise<void>((resolve) => {
        release = resolve
      })
      completions.push({ requestId, cancelled: false, release })
      return {
        requestId,
        events: (async function* () {
          await ready
        })()
      }
    },
    generateImage: async () => {
      throw new Error('image generation is not configured in this test')
    },
    async cancel({ requestId }) {
      const completion = completions.find(
        (candidate) => candidate.requestId === requestId && !candidate.cancelled
      )
      if (!completion) throw new Error(`completion not found: ${requestId}`)
      completion.cancelled = true
      cancellations.push(requestId)
      completion.release()
    },
    heartbeat: async () => ({ ok: true }),
    close: async () => {}
  }
  const harness = createHarness({
    sdk,
    tools: [HTTP_TOOL],
    toolBroker: createBroker()
  })
  await harness.registerAgent({ ...WEATHER_AGENT, id: 'a/b' })
  await harness.registerAgent({ ...WEATHER_AGENT, id: 'a' })
  const firstEvents = collect(harness.runAgent({
    agentId: 'a/b',
    runId: 'c',
    input: 'First'
  }))
  const secondEvents = collect(harness.runAgent({
    agentId: 'a',
    runId: 'b/c',
    input: 'Second'
  }))
  await waitFor(() => completions.length === 2)

  await harness.cancelAgentRun({ agentId: 'a/b', runId: 'c', reason: 'first' })
  await harness.cancelAgentRun({ agentId: 'a', runId: 'b/c', reason: 'second' })
  await Promise.all([firstEvents, secondEvents])

  t.is(new Set(completions.map((completion) => completion.requestId)).size, 2)
  t.is(new Set(cancellations).size, 2)
  const records = await Promise.all([
    harness.readRun({ agentId: 'a/b', runId: 'c' }),
    harness.readRun({ agentId: 'a', runId: 'b/c' })
  ])
  t.is(records.filter(Boolean).length, 2)
  t.alike(records.map((record) => record?.outcome?.status), [
    'canceled',
    'canceled'
  ])
  await harness.close()
})

// A tool that completed is reported even though the run is cancelling. The
// alternative -- discarding its result -- makes a resume re-run a side effect.
test('cancel reaches SDK and broker and keeps a completed tool result', async (t) => {
  const sdkCancellations: string[] = []
  let releaseBroker: (() => void) | undefined
  const sdk = createSdk(({ requestId }) => ({
    requestId,
    events: (async function* () {
      yield {
        type: 'tool-call' as const,
        id: 'weather-cancel',
        name: 'http_request',
        arguments: { url: 'https://wttr.in/London?format=3' }
      }
    })()
  }), sdkCancellations)
  const broker = createBroker(async () => {
    await new Promise<void>((resolve) => {
      releaseBroker = resolve
    })
    return { late: true }
  })
  const { harness } = await registerWeatherAgent(sdk, broker)
  const events: HarnessEvent[] = []

  for await (const event of harness.runAgent({
    agentId: WEATHER_AGENT.id,
    runId: 'cancel-tool',
    input: 'Weather?'
  })) {
    events.push(event)
    if (event.type === 'tool-call') {
      await waitFor(() => releaseBroker !== undefined)
      await harness.cancelAgentRun({
        agentId: WEATHER_AGENT.id,
        runId: 'cancel-tool',
        reason: 'user canceled'
      })
      releaseBroker?.()
    }
  }

  t.is(sdkCancellations.length, 1)
  t.alike(broker.cancellations, ['weather-agent/cancel-tool'])
  t.alike(events.map((event) => event.type), ['tool-call', 'tool-result', 'aborted'])
  await harness.close()
})

test('close waits for live agent termination before closing state', async (t) => {
  let releaseCompletion: (() => void) | undefined
  let releaseAppend: (() => void) | undefined
  let appendingAbort = false
  let storeClosed = false
  const memoryStore = createInMemoryHarnessRunStore()
  const runStore: HarnessRunStore = {
    ...memoryStore,
    async appendEvents(input) {
      if (input.events.some(
        (entry) => entry.kind === 'agent' && entry.event.type === 'run-canceled'
      )) {
        appendingAbort = true
        await new Promise<void>((resolve) => {
          releaseAppend = resolve
        })
      }
      return memoryStore.appendEvents(input)
    },
    async close() {
      storeClosed = true
      await memoryStore.close()
    }
  }
  const sdk = createSdk(({ requestId, signal }) => ({
    requestId,
    events: (async function* () {
      await new Promise<void>((resolve) => {
        releaseCompletion = resolve
        signal.addEventListener('abort', resolve, { once: true })
      })
    })()
  }))
  const harness = createHarness({
    sdk,
    runStore,
    tools: [HTTP_TOOL],
    toolBroker: createBroker()
  })
  await harness.registerAgent(WEATHER_AGENT)
  const draining = collect(harness.runAgent({
    agentId: WEATHER_AGENT.id,
    runId: 'close-live',
    input: 'Wait'
  }))
  await waitFor(() => releaseCompletion !== undefined)

  const closing = harness.close()
  await waitFor(() => appendingAbort)
  t.is(storeClosed, false)
  releaseAppend?.()
  await closing
  await draining
  t.is(storeClosed, true)
})

async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 2_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for condition')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}
