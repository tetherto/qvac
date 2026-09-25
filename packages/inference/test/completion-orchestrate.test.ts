import test from 'brittle'
import { orchestrateCompletion, ToolResultReader } from '@/handlers/completion-orchestrate'
import type {
  CompletionOrchestrateRequest,
  CompletionOrchestrateResponse,
  CompletionStreamRequest,
  CompletionStreamResponse
} from '@/schemas/index'

function baseRequest(overrides: Partial<CompletionOrchestrateRequest> = {}) {
  return {
    type: 'completionOrchestrate',
    modelId: 'm-1',
    history: [{ role: 'user', content: 'weather in Tokyo?' }],
    stream: true,
    ...overrides
  } as CompletionOrchestrateRequest
}

function doneChunk(events: CompletionStreamResponse['events']): CompletionStreamResponse {
  return { type: 'completionStream', events, done: true }
}

function contentTurn(text: string): CompletionStreamResponse {
  return doneChunk([
    { type: 'contentDelta', seq: 0, text },
    { type: 'completionDone', seq: 1, stopReason: 'eos', raw: { fullText: text } }
  ])
}

function toolTurn(callId: string, name: string, args: Record<string, unknown>) {
  return doneChunk([
    { type: 'toolCall', seq: 0, call: { id: callId, name, arguments: args } },
    { type: 'completionDone', seq: 1, stopReason: 'eos', raw: { fullText: `<call ${name}>` } }
  ])
}

/** In-memory reader: results are pre-seeded per callId. */
function stubReader(results: Record<string, unknown>) {
  return {
    async waitFor(callId: string) {
      if (!(callId in results)) throw new Error(`unexpected callback ${callId}`)
      return { callId, result: results[callId] }
    }
  }
}

async function collect(
  generator: AsyncGenerator<CompletionOrchestrateResponse>
): Promise<CompletionOrchestrateResponse[]> {
  const frames: CompletionOrchestrateResponse[] = []
  for await (const frame of generator) frames.push(frame)
  return frames
}

test('orchestrateCompletion: tool-free turn forwards events and ends', async (t) => {
  const seenHistories: CompletionStreamRequest['history'][] = []
  async function* runTurn(request: CompletionStreamRequest) {
    seenHistories.push(request.history)
    yield contentTurn('Sunny, 22C.')
  }

  const frames = await collect(orchestrateCompletion(baseRequest(), runTurn, stubReader({})))

  t.is(seenHistories.length, 1, 'exactly one generation turn')
  t.is(frames.at(-1)?.done, true, 'terminal done frame')
  const events = frames.flatMap((frame) => frame.events ?? [])
  t.ok(
    events.some((event) => event.type === 'contentDelta' && event.text === 'Sunny, 22C.'),
    'inner events pass through'
  )
})

test('orchestrateCompletion: runs the tool loop and threads results into history', async (t) => {
  let turn = 0
  const seenHistories: CompletionStreamRequest['history'][] = []
  async function* runTurn(request: CompletionStreamRequest) {
    seenHistories.push(request.history)
    turn++
    yield turn === 1 ? toolTurn('call-1', 'get_weather', { city: 'Tokyo' }) : contentTurn('22C.')
  }

  const frames = await collect(
    orchestrateCompletion(baseRequest(), runTurn, stubReader({ 'call-1': { temp: 22 } }))
  )

  t.is(turn, 2, 'a second generation turn ran after the tool result')
  const callback = frames.find((frame) => frame.toolCallback)
  t.is(callback?.toolCallback?.callId, 'call-1')
  t.is(callback?.toolCallback?.name, 'get_weather')

  const secondHistory = seenHistories[1]!
  t.is(secondHistory.length, 3, 'user + assistant tool turn + tool result')
  t.is(secondHistory[1]?.role, 'assistant')
  t.is(secondHistory[1]?.content, '<call get_weather>', 'assistant turn keeps raw call syntax')
  t.is(secondHistory[2]?.role, 'tool')
  t.is(secondHistory[2]?.content, JSON.stringify({ temp: 22 }))
  t.is(frames.at(-1)?.done, true)
})

test('orchestrateCompletion: handler error is forwarded as the tool result', async (t) => {
  let turn = 0
  const seenHistories: CompletionStreamRequest['history'][] = []
  async function* runTurn(request: CompletionStreamRequest) {
    seenHistories.push(request.history)
    turn++
    yield turn === 1 ? toolTurn('call-1', 'boom', {}) : contentTurn('recovered')
  }
  const reader = {
    async waitFor(callId: string) {
      return { callId, error: 'tool exploded' }
    }
  }

  await collect(orchestrateCompletion(baseRequest(), runTurn, reader))

  t.is(seenHistories[1]?.[2]?.content, JSON.stringify({ error: 'tool exploded' }))
})

test('orchestrateCompletion: maxToolTurns caps a tool-calling loop', async (t) => {
  let turn = 0
  async function* runTurn() {
    turn++
    yield toolTurn(`call-${turn}`, 'always_more', {})
  }
  const reader = {
    async waitFor(callId: string) {
      return { callId, result: 'again' }
    }
  }

  const frames = await collect(
    orchestrateCompletion(baseRequest({ maxToolTurns: 3 }), runTurn, reader)
  )

  t.is(turn, 3, 'stops at the cap')
  t.is(frames.at(-1)?.done, true, 'still ends with a terminal frame')
  t.is(
    frames.at(-1)?.stopReason,
    'maxToolTurns',
    'truncation frame is marked so the client can tell it from a natural finish'
  )
})

test('orchestrateCompletion: threads the orchestrate requestId into each turn', async (t) => {
  const seenIds: (string | undefined)[] = []
  let turn = 0
  async function* runTurn(request: CompletionStreamRequest) {
    seenIds.push(request.requestId)
    turn++
    yield turn === 1 ? toolTurn('call-1', 'noop', {}) : contentTurn('done')
  }

  await collect(
    orchestrateCompletion(
      baseRequest({ requestId: 'orch-1' }),
      runTurn,
      stubReader({ 'call-1': null })
    )
  )

  // Every inner turn must run under the orchestrate requestId so
  // cancel({ requestId }) reaches whichever turn is currently generating.
  t.is(turn, 2, 'two turns ran')
  t.alike(seenIds, ['orch-1', 'orch-1'], 'both turns carry the orchestrate requestId')
})

test('orchestrateCompletion: natural finish leaves stopReason unset', async (t) => {
  async function* runTurn() {
    yield contentTurn('all done')
  }
  const frames = await collect(orchestrateCompletion(baseRequest(), runTurn, stubReader({})))
  t.is(frames.at(-1)?.done, true, 'terminal frame')
  t.absent(frames.at(-1)?.stopReason, 'no stopReason on a natural finish')
})

test('ToolResultReader: reassembles JSON lines across chunk boundaries', async (t) => {
  const line = JSON.stringify({ callId: 'call-9', result: { ok: true } }) + '\n'
  const halves = [line.slice(0, 7), line.slice(7)]
  async function* input() {
    for (const half of halves) yield Buffer.from(half)
  }

  const reader = new ToolResultReader(input())
  const result = await reader.waitFor('call-9')
  t.alike(result.result, { ok: true })
})

test('ToolResultReader: times out when no result arrives', async (t) => {
  async function* input(): AsyncGenerator<Buffer> {
    await new Promise<void>((resolve) => setTimeout(resolve, 50))
  }
  const reader = new ToolResultReader(input())
  await t.exception(reader.waitFor('never', 20), /timed out/)
})

test('ToolResultReader: close() returns the upstream and fails a pending waiter', async (t) => {
  let returned = false
  let unblock: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    unblock = resolve
  })
  const iterable: AsyncIterable<Buffer> = {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          await gate
          return { done: true, value: undefined }
        },
        async return() {
          returned = true
          unblock()
          return { done: true, value: undefined }
        }
      } as AsyncIterator<Buffer>
    }
  }

  const reader = new ToolResultReader(iterable)
  const pending = reader.waitFor('call-x')
  reader.close()
  const result = await pending
  t.ok(result.error && /closed/.test(result.error), 'pending waiter fails on close')
  t.ok(returned, 'close() returned the upstream iterator')
  reader.close() // idempotent -- second call is a no-op
})

test('orchestrateCompletion: runs tool_search itself and never asks the client', async (t) => {
  const deferredTool = {
    type: 'function' as const,
    name: 'create_issue',
    description: 'Open a new issue on a repository',
    deferLoading: true,
    parameters: {
      type: 'object' as const,
      properties: { title: { type: 'string' as const } },
      required: ['title']
    }
  }

  let turn = 0
  const seenHistories: CompletionStreamRequest['history'][] = []
  async function* runTurn(request: CompletionStreamRequest) {
    seenHistories.push(request.history)
    turn++
    if (turn === 1) yield toolTurn('call-1', 'tool_search', { query: 'create_issue' })
    else if (turn === 2) yield toolTurn('call-2', 'create_issue', { title: 'bug' })
    else yield contentTurn('Opened it.')
  }

  const frames = await collect(
    orchestrateCompletion(
      baseRequest({ tools: [deferredTool] }),
      runTurn,
      stubReader({ 'call-2': { url: 'https://example.invalid/1' } })
    )
  )

  const callbacks = frames.filter((frame) => frame.toolCallback)
  t.is(callbacks.length, 1, 'only the client-runnable tool is delegated')
  t.is(callbacks[0]?.toolCallback?.name, 'create_issue')

  const searchResult = seenHistories[1]?.at(-1)
  t.is(searchResult?.role, 'tool', 'the search result was appended as a tool message')
  t.ok(
    searchResult?.content.includes('"create_issue"'),
    'the definition reached the next turn through the history'
  )
  t.ok(
    frames
      .flatMap((frame) => frame.events ?? [])
      .some((event) => event.type === 'toolCall' && event.call.name === 'tool_search'),
    'the client still sees that a search happened'
  )
})

test('orchestrateCompletion: a caller-declared tool_search goes to the client when nothing defers', async (t) => {
  const ownSearch = {
    type: 'function' as const,
    name: 'tool_search',
    description: 'Search my own index',
    parameters: { type: 'object' as const, properties: { query: { type: 'string' as const } } }
  }

  let turn = 0
  async function* runTurn() {
    turn++
    if (turn === 1) yield toolTurn('call-1', 'tool_search', { query: 'docs' })
    else yield contentTurn('Found it.')
  }

  const frames = await collect(
    orchestrateCompletion(
      baseRequest({ tools: [ownSearch] }),
      runTurn,
      stubReader({ 'call-1': { hits: 1 } })
    )
  )

  const callbacks = frames.filter((frame) => frame.toolCallback)
  t.is(callbacks.length, 1, 'the call is delegated to the caller')
  t.is(callbacks[0]?.toolCallback?.name, 'tool_search')
})
