import test from 'brittle'
import * as agents from '../index.ts'
import {
  defineAgent,
  type AgentEvent,
  type AgentRunResult,
  type ModelAdapter,
  type ModelRequest
} from '../index.ts'

async function* content(...chunks: string[]) {
  for (const text of chunks) yield { type: 'content' as const, text }
}

async function collect(events: AsyncIterable<AgentEvent>) {
  const collected: AgentEvent[] = []
  for await (const event of events) collected.push(event)
  return collected
}

test('agents exposes only the per-run framework value API', (t) => {
  t.alike(Object.keys(agents), ['defineAgent'])
})

test('defineAgent streams one model turn with stable run and operation ids', async function (t) {
  const requests: ModelRequest[] = []
  const adapter: ModelAdapter = {
    stream(request) {
      requests.push(request)
      return content('hello', ' world')
    }
  }
  const agent = defineAgent({
    id: 'greeter',
    model: 'small',
    instructions: 'Be concise.'
  })

  const run = agent.run({ runId: 'run-7', input: 'Say hello', adapter })
  const events = await collect(run.events)
  const result = await run.result

  t.alike(
    events.map((event) => event.type),
    ['run-started', 'operation-started', 'content', 'content', 'operation-completed', 'checkpoint', 'run-completed']
  )
  t.alike(
    events.map((event) => [
      event.runId,
      'operationId' in event ? event.operationId : undefined
    ]),
    [
      ['run-7', undefined],
      ['run-7', 'run-7/respond'],
      ['run-7', 'run-7/respond'],
      ['run-7', 'run-7/respond'],
      ['run-7', 'run-7/respond'],
      ['run-7', 'run-7/respond'],
      ['run-7', undefined]
    ]
  )
  t.alike(requests[0]?.messages, [
    { role: 'system', content: 'Be concise.' },
    { role: 'user', content: 'Say hello' }
  ])
  t.alike(result, {
    status: 'completed',
    runId: 'run-7',
    output: 'hello world',
    checkpoint: {
      version: 1,
      agentId: 'greeter',
      runId: 'run-7',
      nextOperationIndex: 1,
      outputs: [{ operationId: 'run-7/respond', output: 'hello world' }]
    }
  })
})

test('workflow operations execute sequentially and pass completed outputs forward', async function (t) {
  const calls: string[] = []
  const adapter: ModelAdapter = {
    stream(request) {
      calls.push(request.messages.at(-1)?.content ?? '')
      return content(request.operationId.endsWith('/draft') ? 'draft text' : 'final text')
    }
  }
  const agent = defineAgent({
    id: 'writer',
    model: 'small',
    workflow: [
      {
        id: 'draft',
        prompt(context) {
          return `Draft: ${context.input}`
        }
      },
      {
        id: 'revise',
        prompt(context) {
          return `Revise: ${context.outputs[0]?.output}`
        }
      }
    ]
  })

  const run = agent.run({ runId: 'run-8', input: 'A title', adapter })
  const events = await collect(run.events)
  const result = await run.result

  t.alike(calls, ['Draft: A title', 'Revise: draft text'])
  t.alike(
    events.filter((event) => event.type === 'operation-started').map((event) => event.operationId),
    ['run-8/draft', 'run-8/revise']
  )
  t.is(result.status, 'completed')
  if (result.status === 'completed') t.is(result.output, 'final text')
})

test('checkpoint resumes at the next operation without replaying completed work', async function (t) {
  const calls: string[] = []
  const adapter: ModelAdapter = {
    stream(request) {
      calls.push(request.operationId)
      return content('resumed')
    }
  }
  const agent = defineAgent({
    id: 'writer',
    model: 'small',
    workflow: [
      { id: 'draft', prompt: 'Draft it' },
      {
        id: 'revise',
        prompt(context) {
          return `Revise ${context.outputs[0]?.output}`
        }
      }
    ]
  })

  const run = agent.run({
    runId: 'run-9',
    input: 'ignored after checkpoint',
    adapter,
    checkpoint: {
      version: 1,
      agentId: 'writer',
      runId: 'run-9',
      nextOperationIndex: 1,
      outputs: [{ operationId: 'run-9/draft', output: 'saved draft' }]
    }
  })
  await collect(run.events)
  const result = await run.result

  t.alike(calls, ['run-9/revise'])
  t.alike(result.checkpoint.outputs, [
    { operationId: 'run-9/draft', output: 'saved draft' },
    { operationId: 'run-9/revise', output: 'resumed' }
  ])
})

test('cancel aborts the active model operation and returns a resumable checkpoint', async function (t) {
  let release: (() => void) | undefined
  const canceled: string[] = []
  const adapter: ModelAdapter = {
    async *stream(request) {
      yield { type: 'content', text: 'partial' }
      await new Promise<void>((resolve) => {
        release = resolve
        request.signal.addEventListener('abort', resolve, { once: true })
      })
      yield { type: 'content', text: 'late' }
    },
    cancel(operationId) {
      canceled.push(operationId)
      release?.()
    }
  }
  const agent = defineAgent({ id: 'cancelable', model: 'small' })
  const run = agent.run({ runId: 'run-10', input: 'Wait', adapter })
  const events: AgentEvent[] = []
  const draining = (async function () {
    for await (const event of run.events) {
      events.push(event)
      if (event.type === 'content') run.cancel('user-request')
    }
  })()

  await draining
  const result: AgentRunResult = await run.result

  t.alike(canceled, ['run-10/respond'])
  t.alike(
    events.map((event) => event.type),
    ['run-started', 'operation-started', 'content', 'run-canceled']
  )
  t.alike(result, {
    status: 'canceled',
    runId: 'run-10',
    reason: 'user-request',
    checkpoint: {
      version: 1,
      agentId: 'cancelable',
      runId: 'run-10',
      nextOperationIndex: 0,
      outputs: []
    }
  })
})

test('invalid checkpoints fail before invoking the model', async function (t) {
  let called = false
  const adapter: ModelAdapter = {
    stream() {
      called = true
      return content('unexpected')
    }
  }
  const agent = defineAgent({ id: 'agent-a', model: 'small' })
  const run = agent.run({
    runId: 'run-a',
    input: 'hello',
    adapter,
    checkpoint: {
      version: 1,
      agentId: 'agent-b',
      runId: 'run-a',
      nextOperationIndex: 0,
      outputs: []
    }
  })

  await t.exception(collect(run.events), /checkpoint agent does not match/)
  await t.exception(run.result, /checkpoint agent does not match/)
  t.is(called, false)
})
