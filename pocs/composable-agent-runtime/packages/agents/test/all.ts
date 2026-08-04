import test from 'brittle'
import * as agents from '../index.ts'
import {
  TURN_BUDGET_FALLBACK,
  defineAgent,
  type AgentCheckpoint,
  type AgentEvent,
  type AgentRunResult,
  type AgentTool,
  type ModelAdapter,
  type ModelEvent,
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

test('agents exposes the per-run framework and tool contract value API', (t) => {
  t.alike(Object.keys(agents).sort(), [
    'CHECKPOINT_VERSION',
    'DEFAULT_TURN_BUDGET',
    'TURN_BUDGET_FALLBACK',
    'createToolGate',
    'defineAgent',
    'memoizeToolApproval'
  ])
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
      version: 2,
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
      version: 2,
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
      version: 2,
      agentId: 'cancelable',
      runId: 'run-10',
      nextOperationIndex: 0,
      outputs: [],
      // Mid-operation state, so a resume does not replay the interrupted turn
      // from the beginning.
      operation: {
        operationId: 'run-10/respond',
        round: 0,
        messages: [{ role: 'user', content: 'Wait' }]
      }
    }
  })
})

function toolAdapter(rounds: readonly (readonly ModelEvent[])[]): ModelAdapter & {
  readonly requests: ModelRequest[]
} {
  const requests: ModelRequest[] = []
  return {
    requests,
    async *stream(request) {
      requests.push(request)
      for (const event of rounds[request.round] ?? []) yield event
    }
  }
}

function echoTool(name: string): AgentTool {
  return {
    schema: {
      type: 'function',
      name,
      description: `Fixture tool ${name}`,
      parameters: { type: 'object', properties: {} }
    }
  }
}

function grantsOf(...names: string[]) {
  return new Map(names.map((name) => [name, [{ name, scope: null }]]))
}

test('the tool loop runs rounds, feeds results back, and answers', async function (t) {
  const executed: string[] = []
  const adapter = toolAdapter([
    [{ type: 'tool-call', call: { id: 'c1', name: 'lookup', arguments: { q: 'x' } } }],
    [{ type: 'content', text: 'the answer' }]
  ])
  const agent = defineAgent({
    id: 'looper',
    model: 'small',
    toolPolicy: { allow: ['lookup'], requireApproval: [] }
  })
  const run = agent.run({
    runId: 'run-tools',
    input: 'Ask',
    adapter,
    tooling: {
      tools: [echoTool('lookup')],
      grants: grantsOf('lookup'),
      broker: {
        async execute(input) {
          executed.push(input.call.name)
          return { ok: true }
        },
        async cancel() {},
        async close() {}
      }
    }
  })
  const events = await collect(run.events)
  const result = await run.result

  t.alike(executed, ['lookup'])
  t.alike(
    events.map((event) => event.type),
    [
      'run-started',
      'operation-started',
      'tool-call',
      'tool-result',
      'content',
      'operation-completed',
      'checkpoint',
      'run-completed'
    ]
  )
  // The tool result is fed back as a tool message before the second round.
  t.alike(
    adapter.requests[1]?.messages.map((message) => message.role),
    ['user', 'assistant', 'tool']
  )
  // Schemas reach the model only for granted and allowed tools.
  t.alike(adapter.requests[0]?.tools?.map((tool) => tool.name), ['lookup'])
  t.is(result.status === 'completed' ? result.output : '', 'the answer')
})

test('a tool that is granted but denied by policy never reaches the broker', async function (t) {
  let executed = 0
  const adapter = toolAdapter([
    [{ type: 'tool-call', call: { id: 'c1', name: 'lookup', arguments: {} } }]
  ])
  const agent = defineAgent({
    id: 'denier',
    model: 'small',
    toolPolicy: { allow: [], requireApproval: [] }
  })
  const run = agent.run({
    runId: 'run-denied',
    input: 'Ask',
    adapter,
    tooling: {
      tools: [echoTool('lookup')],
      grants: grantsOf('lookup'),
      broker: {
        async execute() {
          executed++
          return null
        },
        async cancel() {},
        async close() {}
      }
    }
  })

  await t.exception(collect(run.events), /denied by policy: lookup/)
  t.is(executed, 0)
})

test('approval gates a tool call and reports both the request and the decision', async function (t) {
  const adapter = toolAdapter([
    [{ type: 'tool-call', call: { id: 'c1', name: 'danger', arguments: {} } }],
    [{ type: 'content', text: 'done' }]
  ])
  const agent = defineAgent({
    id: 'approver',
    model: 'small',
    toolPolicy: { allow: ['danger'], requireApproval: ['danger'] }
  })
  const run = agent.run({
    runId: 'run-approve',
    input: 'Ask',
    adapter,
    tooling: {
      tools: [echoTool('danger')],
      grants: grantsOf('danger'),
      approval: { async approve() { return true } },
      broker: {
        async execute() {
          return { ran: true }
        },
        async cancel() {},
        async close() {}
      }
    }
  })
  const events = await collect(run.events)

  t.alike(
    events
      .filter((event) => event.type.startsWith('approval-'))
      .map((event) => event.type),
    ['approval-requested', 'approval-resolved']
  )
  t.is(events.some((event) => event.type === 'tool-result'), true)
})

test('a run with no approval port denies an approval-required tool', async function (t) {
  let executed = 0
  const adapter = toolAdapter([
    [{ type: 'tool-call', call: { id: 'c1', name: 'danger', arguments: {} } }]
  ])
  const agent = defineAgent({
    id: 'no-approver',
    model: 'small',
    toolPolicy: { allow: ['danger'], requireApproval: ['danger'] }
  })
  const run = agent.run({
    runId: 'run-no-approval',
    input: 'Ask',
    adapter,
    tooling: {
      tools: [echoTool('danger')],
      grants: grantsOf('danger'),
      broker: {
        async execute() {
          executed++
          return null
        },
        async cancel() {},
        async close() {}
      }
    }
  })

  await t.exception(collect(run.events), /approval denied: danger/)
  t.is(executed, 0)
})

test('mandatory approval applies even when the agent policy omits it', async function (t) {
  let executed = 0
  const adapter = toolAdapter([
    [{ type: 'tool-call', call: { id: 'c1', name: 'danger', arguments: {} } }]
  ])
  const agent = defineAgent({
    id: 'mandatory',
    model: 'small',
    toolPolicy: { allow: ['danger'], requireApproval: [] }
  })
  const run = agent.run({
    runId: 'run-mandatory',
    input: 'Ask',
    adapter,
    tooling: {
      tools: [echoTool('danger')],
      grants: grantsOf('danger'),
      mandatoryApproval: new Set(['danger']),
      approval: { async approve() { return false } },
      broker: {
        async execute() {
          executed++
          return null
        },
        async cancel() {},
        async close() {}
      }
    }
  })

  await t.exception(collect(run.events), /approval denied: danger/)
  t.is(executed, 0)
})

test('the turn budget bounds tool rounds and is reported distinguishably', async function (t) {
  const rounds: ModelEvent[][] = []
  for (let index = 0; index < 10; index++) {
    rounds.push([{ type: 'tool-call', call: { id: `c${index}`, name: 'spin', arguments: {} } }])
  }
  const adapter = toolAdapter(rounds)
  const agent = defineAgent({
    id: 'spinner',
    model: 'small',
    turnBudget: 3,
    toolPolicy: { allow: ['spin'], requireApproval: [] }
  })
  const run = agent.run({
    runId: 'run-budget',
    input: 'Spin',
    adapter,
    tooling: {
      tools: [echoTool('spin')],
      grants: grantsOf('spin'),
      broker: {
        async execute() {
          return null
        },
        async cancel() {},
        async close() {}
      }
    }
  })
  const events = await collect(run.events)
  const result = await run.result

  t.is(adapter.requests.length, 3)
  const exhausted = events.find((event) => event.type === 'budget-exhausted')
  t.is(exhausted?.type === 'budget-exhausted' ? exhausted.rounds : 0, 3)
  t.is(result.status === 'completed' ? result.output : '', TURN_BUDGET_FALLBACK)
})

test('turn budget must be a positive integer', async function (t) {
  await t.exception(
    (async () => defineAgent({ id: 'a', model: 'm', turnBudget: 0 }))(),
    /positive integer/
  )
  await t.exception(
    (async () => defineAgent({ id: 'a', model: 'm', turnBudget: 1.5 }))(),
    /positive integer/
  )
})

test('a mid-operation checkpoint resumes the conversation without replaying rounds', async function (t) {
  const adapter = toolAdapter([[], [{ type: 'content', text: 'resumed answer' }]])
  const agent = defineAgent({ id: 'resumer', model: 'small' })
  const run = agent.run({
    runId: 'run-resume',
    input: 'ignored after checkpoint',
    adapter,
    checkpoint: {
      version: 2,
      agentId: 'resumer',
      runId: 'run-resume',
      nextOperationIndex: 0,
      outputs: [],
      operation: {
        operationId: 'run-resume/respond',
        round: 1,
        messages: [
          { role: 'user', content: 'Original ask' },
          { role: 'assistant', content: 'calling a tool' },
          { role: 'tool', content: '{"ok":true}' }
        ]
      }
    }
  })
  await collect(run.events)
  const result = await run.result

  // Resumed at round 1 with the saved conversation, not a fresh prompt.
  t.is(adapter.requests.length, 1)
  t.is(adapter.requests[0]?.round, 1)
  t.alike(
    adapter.requests[0]?.messages.map((message) => message.role),
    ['user', 'assistant', 'tool']
  )
  t.is(result.status === 'completed' ? result.output : '', 'resumed answer')
})

// A saved history that announces a tool call with no result is rejected by
// providers, and "repaired" by lenient ones into calling the tool again.
test('cancelling while a tool runs keeps its result and balances the history', async function (t) {
  const executed: string[] = []
  const adapter = toolAdapter([
    [{ type: 'tool-call', call: { id: 'c1', name: 'act', arguments: {} } }],
    [{ type: 'content', text: 'unreachable' }]
  ])
  const agent = defineAgent({
    id: 'canceller',
    model: 'small',
    toolPolicy: { allow: ['act'], requireApproval: [] }
  })
  let cancel: (() => void) | undefined
  const run = agent.run({
    runId: 'run-cancel-tool',
    input: 'go',
    adapter,
    tooling: {
      tools: [echoTool('act')],
      grants: grantsOf('act'),
      broker: {
        async execute(input) {
          executed.push(input.call.name)
          // Cancel while this call is in flight: it completes, and its result
          // must not be thrown away.
          cancel?.()
          return { done: true }
        },
        async cancel() {},
        async close() {}
      }
    }
  })
  cancel = () => {
    void run.cancel('user-request')
  }

  await collect(run.events)
  const result = await run.result

  t.alike(executed, ['act'], 'the tool ran exactly once')
  t.is(result.status, 'canceled')
  const messages = result.checkpoint.operation?.messages ?? []
  t.alike(
    messages.map((message) => message.role),
    ['user', 'assistant', 'tool'],
    'the completed call keeps its result in the saved history'
  )
  t.is(result.checkpoint.operation?.round, 1, 'a resume continues past the round')
})

test('cancelling between calls in a round records an outcome for every call', async function (t) {
  const executed: string[] = []
  const adapter = toolAdapter([
    [
      { type: 'tool-call', call: { id: 'c1', name: 'act', arguments: {} } },
      { type: 'tool-call', call: { id: 'c2', name: 'act', arguments: {} } }
    ],
    [{ type: 'content', text: 'unreachable' }]
  ])
  const agent = defineAgent({
    id: 'multi',
    model: 'small',
    toolPolicy: { allow: ['act'], requireApproval: [] }
  })
  let cancel: (() => void) | undefined
  const run = agent.run({
    runId: 'run-cancel-between',
    input: 'go',
    adapter,
    tooling: {
      tools: [echoTool('act')],
      grants: grantsOf('act'),
      broker: {
        async execute(input) {
          executed.push(input.call.id)
          // Cancel once the first call has finished, so the second never runs.
          cancel?.()
          return { done: true }
        },
        async cancel() {},
        async close() {}
      }
    }
  })
  cancel = () => {
    void run.cancel('user-request')
  }

  const events = await collect(run.events)
  const result = await run.result

  t.alike(executed, ['c1'], 'the second call never ran')
  t.is(result.status, 'canceled', 'cancelling mid-round is not an error')
  t.is(
    events.some((event) => event.type === 'run-canceled'),
    true,
    'a resumable cancellation is still reported'
  )
  const messages = result.checkpoint.operation?.messages ?? []
  t.alike(
    messages.map((message) => message.role),
    ['user', 'assistant', 'tool', 'tool'],
    'both announced calls have a recorded outcome'
  )
  t.is(messages.at(-1)?.content, JSON.stringify({ status: 'canceled' }))
})

test('a denied approval surfaces its events before the failure', async function (t) {
  const adapter = toolAdapter([
    [{ type: 'tool-call', call: { id: 'c1', name: 'danger', arguments: {} } }]
  ])
  const agent = defineAgent({
    id: 'denied',
    model: 'small',
    toolPolicy: { allow: ['danger'], requireApproval: ['danger'] }
  })
  const run = agent.run({
    runId: 'run-denied-events',
    input: 'go',
    adapter,
    tooling: {
      tools: [echoTool('danger')],
      grants: grantsOf('danger'),
      approval: { async approve() { return false } },
      broker: {
        async execute() {
          return null
        },
        async cancel() {},
        async close() {}
      }
    }
  })

  const events: AgentEvent[] = []
  await t.exception(
    (async () => {
      for await (const event of run.events) events.push(event)
    })(),
    /approval denied/
  )
  t.alike(
    events.filter((event) => event.type.startsWith('approval-')).map((e) => e.type),
    ['approval-requested', 'approval-resolved'],
    'the caller can see why the run failed'
  )
})

test('a checkpoint from an older version is rejected rather than reinterpreted', async function (t) {
  const adapter = toolAdapter([[{ type: 'content', text: 'unexpected' }]])
  const agent = defineAgent({ id: 'versioned', model: 'small' })
  const run = agent.run({
    runId: 'run-v1',
    input: 'hello',
    adapter,
    checkpoint: {
      version: 1,
      agentId: 'versioned',
      runId: 'run-v1',
      nextOperationIndex: 0,
      outputs: []
    } as unknown as AgentCheckpoint
  })

  await t.exception(collect(run.events), /unsupported checkpoint version/)
  t.is(adapter.requests.length, 0)
})

test('system prompt blocks are appended after instructions', async function (t) {
  const adapter = toolAdapter([[{ type: 'content', text: 'ok' }]])
  const agent = defineAgent({
    id: 'prompted',
    model: 'small',
    instructions: 'Base instructions.',
    systemPrompt: [
      { id: 'skills-index', text: 'weather — forecasts' },
      { id: 'skill:weather', text: 'Use wttr.in.' }
    ]
  })
  await collect(agent.run({ runId: 'run-prompt', input: 'Ask', adapter }).events)

  t.alike(adapter.requests[0]?.messages, [
    { role: 'system', content: 'Base instructions.' },
    { role: 'system', content: 'weather — forecasts' },
    { role: 'system', content: 'Use wttr.in.' },
    { role: 'user', content: 'Ask' }
  ])
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
      version: 2,
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
