import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { ServerResponse } from 'node:http'
import { writeStreamingResponse } from '@/serve/extensions/openai/adapters/response-writers'
import type {
  ResponsesHandlerParams,
  ResponseWriterContext
} from '@/serve/extensions/openai/adapters/response-writers'
import type { CompletionRun, CompletionStats, ToolCall } from '@qvac/sdk'

function minimalRouteContext(): ResponseWriterContext {
  return {
    logger: { info: (): void => {} },
    responsesStore: {
      put: (): void => {},
      get: (): undefined => undefined,
      delete: (): boolean => false,
      listInputItems: (): null => null,
      size: (): number => 0,
      bannerLine: (): string => ''
    } as ResponseWriterContext['responsesStore']
  }
}

function baseHandlerParams(rid: string): ResponsesHandlerParams {
  return {
    ctx: minimalRouteContext(),
    sdkModelId: 'mid',
    history: [],
    modelAlias: 'alias',
    rid,
    createdAtSec: 100,
    storeEnabled: false,
    inputItems: [],
    metadata: undefined,
    temperature: undefined,
    topP: undefined,
    maxOutputTokens: undefined,
    parallelToolCalls: true,
    previousResponseId: null
  }
}

function fakeStreamCompletion(opts: {
  thinkingTokens?: string[]
  /** Interleaved reasoning and text, emitted in order after `thinkingTokens` and `tokens`. */
  steps?: Array<{ think: string } | { text: string }>
  tokens: string[]
  toolCalls: ToolCall[]
  text: string
  stats?: CompletionStats
  stopReason?: string
}): CompletionRun {
  // Writers consume `result.events`; drive content deltas, tool calls, stats
  // and the terminal `stopReason` the way the SDK does.
  async function* events(): AsyncGenerator<unknown> {
    let seq = 0
    for (const t of opts.thinkingTokens ?? []) yield { type: 'thinkingDelta', seq: seq++, text: t }
    for (const t of opts.tokens) yield { type: 'contentDelta', seq: seq++, text: t }
    for (const step of opts.steps ?? []) {
      yield 'think' in step
        ? { type: 'thinkingDelta', seq: seq++, text: step.think }
        : { type: 'contentDelta', seq: seq++, text: step.text }
    }
    for (const call of opts.toolCalls) yield { type: 'toolCall', seq: seq++, call }
    if (opts.stats !== undefined) yield { type: 'completionStats', seq: seq++, stats: opts.stats }
    yield { type: 'completionDone', seq: seq++, stopReason: opts.stopReason ?? 'eos' }
  }
  async function* gen(): AsyncGenerator<string> {
    for (const t of opts.tokens) yield t
  }
  return {
    requestId: 'test',
    events: events() as unknown as CompletionRun['events'],
    final: Promise.resolve(undefined) as unknown as CompletionRun['final'],
    text: Promise.resolve(opts.text),
    toolCalls: Promise.resolve(opts.toolCalls) as unknown as CompletionRun['toolCalls'],
    stats: Promise.resolve(opts.stats),
    tokenStream: gen(),
    toolCallStream: (async function* (): AsyncGenerator<never> {})()
  }
}

function parseSseJsonEvents(raw: string): unknown[] {
  const out: unknown[] = []
  for (const block of raw.split('\n\n')) {
    for (const line of block.split('\n')) {
      if (!line.startsWith('data: ')) continue
      const payload = line.slice(6)
      if (payload === '[DONE]') continue
      try {
        out.push(JSON.parse(payload) as unknown)
      } catch {
        /* ignore */
      }
    }
  }
  return out
}

function createStreamResponse(): { res: ServerResponse; raw: string } {
  const parts: string[] = []
  let sent = false
  const res = {
    setHeader: (): void => {},
    writeHead: (): void => {
      sent = true
    },
    write(chunk: string): boolean {
      parts.push(chunk)
      return true
    },
    end(chunk?: string | Buffer): void {
      if (chunk !== undefined && chunk !== null) parts.push(String(chunk))
    },
    get headersSent(): boolean {
      return sent
    }
  } as unknown as ServerResponse
  return {
    res,
    get raw(): string {
      return parts.join('')
    }
  }
}

describe('writeStreamingResponse', () => {
  it('keeps same message item_id in deltas and in response.completed output', async () => {
    const holder = createStreamResponse()
    const p = baseHandlerParams('resp_stream_msg')
    const result = fakeStreamCompletion({
      tokens: ['x', 'y'],
      toolCalls: [],
      text: 'xy',
      stats: { generatedTokens: 5, emittedTokens: 2 }
    })

    const completed = await writeStreamingResponse(holder.res, p, () => result)
    const events = parseSseJsonEvents(holder.raw) as Array<Record<string, unknown>>

    const deltas = events.filter((e) => e['type'] === 'response.output_text.delta')
    assert.ok(deltas.length >= 1)
    const msgIdFromDelta = deltas[0]!['item_id'] as string
    const out = (completed['output'] as Array<{ type: string; id: string }>)[0]!
    assert.equal(out.type, 'message')
    assert.equal(out.id, msgIdFromDelta)

    const completedEvent = events.find((e) => e['type'] === 'response.completed') as {
      response: { output: Array<{ id: string }>; usage: { output_tokens: number } }
    }
    assert.ok(completedEvent)
    assert.equal(completedEvent.response.output[0]!.id, msgIdFromDelta)
    assert.equal(completedEvent.response.usage.output_tokens, 2)
  })

  it('uses fc item ids and distinct output_index per tool call in SSE and final output', async () => {
    const holder = createStreamResponse()
    const p = baseHandlerParams('resp_stream_tools')
    const result = fakeStreamCompletion({
      tokens: [],
      toolCalls: [
        { id: 'call_a', name: 'fn1', arguments: {} },
        { id: 'call_b', name: 'fn2', arguments: { k: 1 } }
      ],
      text: '',
      stats: { generatedTokens: 3 }
    })

    const completed = await writeStreamingResponse(holder.res, p, () => result)
    const events = parseSseJsonEvents(holder.raw) as Array<Record<string, unknown>>

    const argDeltas = events.filter((e) => e['type'] === 'response.function_call_arguments.delta')
    assert.equal(argDeltas.length, 2)
    assert.notEqual((argDeltas[0] as { item_id: string }).item_id, 'call_a')
    assert.notEqual((argDeltas[1] as { item_id: string }).item_id, 'call_b')
    assert.equal((argDeltas[0] as { output_index: number }).output_index, 0)
    assert.equal((argDeltas[1] as { output_index: number }).output_index, 1)

    // A turn that only calls tools returns only its calls, as OpenAI does.
    const out = completed['output'] as Array<{ type: string; id: string; call_id?: string }>
    assert.equal(out.length, 2)
    assert.equal(out[0]!.type, 'function_call')
    assert.equal(out[1]!.type, 'function_call')
    assert.equal(out[0]!.id, (argDeltas[0] as { item_id: string }).item_id)
    assert.equal(out[1]!.id, (argDeltas[1] as { item_id: string }).item_id)
    assert.equal(out[0]!.call_id, 'call_a')
    assert.equal(out[1]!.call_id, 'call_b')

    const completedEvent = events.find((e) => e['type'] === 'response.completed') as {
      response: { usage: { output_tokens: number } }
    }
    assert.equal(completedEvent.response.usage.output_tokens, 3)
  })

  it('emits response.incomplete with max_output_tokens reason when truncated by length', async () => {
    const holder = createStreamResponse()
    const p = baseHandlerParams('resp_stream_len')
    const result = fakeStreamCompletion({
      tokens: ['a', 'b'],
      toolCalls: [],
      text: 'ab',
      stats: { generatedTokens: 2 },
      stopReason: 'length'
    })

    const completed = await writeStreamingResponse(holder.res, p, () => result)
    const events = parseSseJsonEvents(holder.raw) as Array<Record<string, unknown>>

    assert.equal(completed['status'], 'incomplete')
    assert.deepEqual(completed['incomplete_details'], { reason: 'max_output_tokens' })
    assert.ok(!events.some((e) => e['type'] === 'response.completed'))
    const terminal = events.find((e) => e['type'] === 'response.incomplete') as {
      response: { status: string; incomplete_details: { reason: string } }
    }
    assert.ok(terminal)
    assert.equal(terminal.response.status, 'incomplete')
    assert.equal(terminal.response.incomplete_details.reason, 'max_output_tokens')
  })
})

describe('writeStreamingResponse: reasoning', () => {
  it('streams reasoning as its own item before the message and keeps it out of the text', async () => {
    const holder = createStreamResponse()
    const result = fakeStreamCompletion({
      thinkingTokens: ['Check ', 'the file.'],
      tokens: ['Done', '.'],
      toolCalls: [],
      text: 'Done.',
      stats: { promptTokens: 50, emittedTokens: 6 }
    })

    const completed = await writeStreamingResponse(
      holder.res,
      baseHandlerParams('resp_reason'),
      () => result
    )
    const events = parseSseJsonEvents(holder.raw) as Array<Record<string, unknown>>
    const types = events.map((e) => e['type'])

    const reasoningDeltas = events.filter((e) => e['type'] === 'response.reasoning_text.delta')
    assert.deepEqual(
      reasoningDeltas.map((e) => e['delta']),
      ['Check ', 'the file.']
    )
    assert.equal(reasoningDeltas[0]!['output_index'], 0)
    const rsId = reasoningDeltas[0]!['item_id'] as string
    assert.match(rsId, /^rs_/)

    const textDeltas = events.filter((e) => e['type'] === 'response.output_text.delta')
    assert.deepEqual(
      textDeltas.map((e) => e['delta']),
      ['Done', '.']
    )
    assert.equal(textDeltas[0]!['output_index'], 1)

    // The reasoning item closes before the message item opens.
    const reasoningDone = events.findIndex(
      (e) =>
        e['type'] === 'response.output_item.done' &&
        (e['item'] as { type: string }).type === 'reasoning'
    )
    const messageAdded = events.findIndex(
      (e) =>
        e['type'] === 'response.output_item.added' &&
        (e['item'] as { type: string }).type === 'message'
    )
    assert.ok(reasoningDone !== -1 && reasoningDone < messageAdded)
    assert.ok(types.includes('response.reasoning_text.done'))

    const output = completed['output'] as Array<Record<string, unknown>>
    assert.deepEqual(
      output.map((o) => o['type']),
      ['reasoning', 'message']
    )
    assert.equal(output[0]!['id'], rsId)
    assert.deepEqual(output[0]!['content'], [{ type: 'reasoning_text', text: 'Check the file.' }])
    assert.equal(completed['output_text'], 'Done.')
    assert.deepEqual(completed['usage'], {
      input_tokens: 50,
      output_tokens: 6,
      total_tokens: 56
    })
  })

  it('indexes tool calls after the reasoning and message items', async () => {
    const holder = createStreamResponse()
    const result = fakeStreamCompletion({
      thinkingTokens: ['Need to list files.'],
      tokens: [],
      toolCalls: [{ id: 'call_ls', name: 'shell', arguments: { cmd: 'ls' } }],
      text: ''
    })

    const completed = await writeStreamingResponse(
      holder.res,
      baseHandlerParams('resp_reason_tool'),
      () => result
    )
    const events = parseSseJsonEvents(holder.raw) as Array<Record<string, unknown>>
    const argDelta = events.find((e) => e['type'] === 'response.function_call_arguments.delta')!
    assert.equal(argDelta['output_index'], 1)
    assert.deepEqual(
      (completed['output'] as Array<{ type: string }>).map((o) => o.type),
      ['reasoning', 'function_call']
    )
    assert.equal(completed['status'], 'requires_action')
  })
})

describe('writeStreamingResponse: reasoning after answer text', () => {
  it('finishes each item before the next, so text after reasoning opens a new message', async () => {
    const holder = createStreamResponse()
    const result = fakeStreamCompletion({
      tokens: [],
      steps: [{ think: 'First.' }, { text: 'Partial ' }, { think: 'Second.' }, { text: 'answer.' }],
      toolCalls: [],
      text: 'Partial answer.'
    })

    const completed = await writeStreamingResponse(
      holder.res,
      baseHandlerParams('resp_reason_late'),
      () => result
    )
    const events = parseSseJsonEvents(holder.raw) as Array<Record<string, unknown>>
    const reasoningDeltas = events.filter((e) => e['type'] === 'response.reasoning_text.delta')
    assert.deepEqual(
      reasoningDeltas.map((e) => [e['delta'], e['output_index']]),
      [
        ['First.', 0],
        ['Second.', 2]
      ]
    )
    assert.deepEqual(
      events
        .filter((e) => e['type'] === 'response.output_text.delta')
        .map((e) => [e['delta'], e['output_index']]),
      [
        ['Partial ', 1],
        ['answer.', 3]
      ]
    )

    // An item is done before the next is added: added/done alternate by index.
    const lifecycle = events
      .filter(
        (e) =>
          e['type'] === 'response.output_item.added' || e['type'] === 'response.output_item.done'
      )
      .map((e) => `${e['type'] === 'response.output_item.added' ? '+' : '-'}${e['output_index']}`)
    assert.deepEqual(lifecycle, ['+0', '-0', '+1', '-1', '+2', '-2', '+3', '-3'])

    const output = completed['output'] as Array<Record<string, unknown>>
    assert.deepEqual(
      output.map((o) => o['type']),
      ['reasoning', 'message', 'reasoning', 'message']
    )
    assert.equal(output[0]!['id'], reasoningDeltas[0]!['item_id'])
    assert.equal(output[2]!['id'], reasoningDeltas[1]!['item_id'])
    assert.deepEqual(output[2]!['content'], [{ type: 'reasoning_text', text: 'Second.' }])
    assert.equal(completed['output_text'], 'Partial answer.')
  })
})

describe('writeStreamingResponse: reasoning without answer text', () => {
  it('finishes the reasoning item before the tool call', async () => {
    const holder = createStreamResponse()
    const result = fakeStreamCompletion({
      thinkingTokens: ['Need to list files.'],
      tokens: [],
      toolCalls: [{ id: 'call_ls', name: 'shell', arguments: { cmd: 'ls' } }],
      text: ''
    })

    await writeStreamingResponse(holder.res, baseHandlerParams('resp_reason_only'), () => result)
    const events = parseSseJsonEvents(holder.raw) as Array<Record<string, unknown>>
    const lifecycle = events
      .filter(
        (e) =>
          e['type'] === 'response.output_item.added' || e['type'] === 'response.output_item.done'
      )
      .map((e) => `${e['type'] === 'response.output_item.added' ? '+' : '-'}${e['output_index']}`)
    assert.deepEqual(lifecycle, ['+0', '-0', '+1', '-1'])
    assert.ok(events.some((e) => e['type'] === 'response.reasoning_text.done'))
  })
})

describe('writeStreamingResponse: tool calls and sequence numbers', () => {
  it('keeps a tool call ahead of text generated after it', async () => {
    const holder = createStreamResponse()
    async function* events(): AsyncGenerator<unknown> {
      yield { type: 'contentDelta', seq: 0, text: 'Reading it. ' }
      yield { type: 'toolCall', seq: 1, call: { id: 'call_1', name: 'read', arguments: {} } }
      yield { type: 'thinkingDelta', seq: 2, text: 'Waiting for the result.' }
      yield { type: 'contentDelta', seq: 3, text: 'Done.' }
      yield { type: 'completionDone', seq: 4, stopReason: 'eos' }
    }
    const run = {
      ...fakeStreamCompletion({ tokens: [], toolCalls: [], text: '' }),
      events: events() as unknown as CompletionRun['events']
    }

    const completed = await writeStreamingResponse(
      holder.res,
      baseHandlerParams('resp_call_order'),
      () => run
    )
    const output = completed['output'] as Array<Record<string, unknown>>
    assert.deepEqual(
      output.map((o) => o['type']),
      ['message', 'function_call', 'reasoning', 'message']
    )
    const streamed = parseSseJsonEvents(holder.raw) as Array<Record<string, unknown>>
    for (const e of streamed.filter((e) => e['type'] === 'response.output_item.done')) {
      assert.equal(output[e['output_index'] as number]!['id'], (e['item'] as { id: string }).id)
    }
  })

  it('numbers every event in one increasing sequence', async () => {
    const holder = createStreamResponse()
    const result = fakeStreamCompletion({
      thinkingTokens: ['Think.'],
      tokens: ['Answer.'],
      toolCalls: [{ id: 'call_1', name: 'read', arguments: {} }],
      text: 'Answer.'
    })
    await writeStreamingResponse(holder.res, baseHandlerParams('resp_seq'), () => result)
    const events = parseSseJsonEvents(holder.raw) as Array<Record<string, unknown>>
    assert.deepEqual(
      events.map((e) => e['sequence_number']),
      events.map((_, i) => i)
    )
  })
})

describe('writeStreamingResponse: namespaced tools', () => {
  it('streams a namespaced call as name + namespace', async () => {
    const holder = createStreamResponse()
    const p = {
      ...baseHandlerParams('resp_ns'),
      toolNamespaces: new Map([['mcp__node_repl__js', { namespace: 'mcp__node_repl', name: 'js' }]])
    }
    const result = fakeStreamCompletion({
      tokens: [],
      toolCalls: [{ id: 'call_1', name: 'mcp__node_repl__js', arguments: { code: '1+1' } }],
      text: ''
    })

    const completed = await writeStreamingResponse(holder.res, p, () => result)
    const events = parseSseJsonEvents(holder.raw) as Array<Record<string, unknown>>
    const items = events
      .filter((e) => e['type'] === 'response.output_item.done')
      .map((e) => e['item'] as Record<string, unknown>)
      .filter((item) => item['type'] === 'function_call')
    assert.equal(items[0]!['name'], 'js')
    assert.equal(items[0]!['namespace'], 'mcp__node_repl')
    const final = (completed['output'] as Array<Record<string, unknown>>).find(
      (item) => item['type'] === 'function_call'
    )!
    assert.equal(final['name'], 'js')
    assert.equal(final['namespace'], 'mcp__node_repl')
  })
})

describe('writeStreamingResponse: deferred tools', () => {
  const deferredTool = {
    type: 'function' as const,
    name: 'create_issue',
    description: 'Open a new issue on a repository',
    deferLoading: true,
    parameters: { type: 'object' as const, properties: { title: { type: 'string' as const } } }
  }

  it('streams both turns live and keeps tool_search out of the response object', async () => {
    const holder = createStreamResponse()
    const p = { ...baseHandlerParams('resp_defer'), tools: [deferredTool] }

    const turns = [
      // Search turn: a preamble, then the search call the client never sees.
      fakeStreamCompletion({
        tokens: ['Looking ', 'that up. '],
        toolCalls: [{ id: 'c1', name: 'tool_search', arguments: { query: 'create_issue' } }],
        text: 'Looking that up. '
      }),
      // Answer turn.
      fakeStreamCompletion({
        tokens: ['Opened ', 'it.'],
        toolCalls: [],
        text: 'Opened it.'
      })
    ]
    const seenHistories: Array<Array<{ role: string; content: string }>> = []
    let turn = 0

    const completed = await writeStreamingResponse(holder.res, p, (history) => {
      seenHistories.push(history)
      return turns[turn++]!
    })

    assert.equal(turn, 2, 'the search turn was followed by a second generation')

    const events = parseSseJsonEvents(holder.raw) as Array<Record<string, unknown>>
    const deltas = events
      .filter((e) => e['type'] === 'response.output_text.delta')
      .map((e) => e['delta'])
    assert.deepEqual(
      deltas,
      ['Looking ', 'that up. ', 'Opened ', 'it.'],
      'both turns streamed live — nothing was buffered or dropped'
    )

    // The search result reached the second turn through the history.
    const second = seenHistories[1]!
    assert.equal(second.at(-1)!.role, 'tool')
    assert.ok(second.at(-1)!.content.includes('"create_issue"'))

    // The response carries no tool call the client would have to run.
    assert.equal(completed['status'], 'completed')
    assert.equal(
      JSON.stringify(completed['output']).includes('tool_search'),
      false,
      'tool_search never reaches the client'
    )
    assert.ok(JSON.stringify(completed['output']).includes('Opened it.'))
  })

  it('keeps every streamed item at its streamed position across a search round', async () => {
    const holder = createStreamResponse()
    const p = { ...baseHandlerParams('resp_defer_reason'), tools: [deferredTool] }
    const turns = [
      fakeStreamCompletion({
        tokens: ['Looking that up. '],
        toolCalls: [{ id: 'c1', name: 'tool_search', arguments: { query: 'create_issue' } }],
        text: 'Looking that up. '
      }),
      fakeStreamCompletion({
        thinkingTokens: ['The tool is loaded now.'],
        tokens: ['Opened it.'],
        toolCalls: [],
        text: 'Opened it.'
      })
    ]
    let turn = 0

    const completed = await writeStreamingResponse(holder.res, p, () => turns[turn++]!)
    const events = parseSseJsonEvents(holder.raw) as Array<Record<string, unknown>>
    assert.deepEqual(
      events.filter((e) => e['type'] === 'response.reasoning_text.delta').map((e) => e['delta']),
      ['The tool is loaded now.']
    )
    const output = completed['output'] as Array<Record<string, unknown>>
    assert.deepEqual(
      output.map((o) => o['type']),
      ['message', 'reasoning', 'message']
    )
    // Each finished item sits in `output` at the index it streamed under.
    for (const e of events.filter((e) => e['type'] === 'response.output_item.done')) {
      const item = e['item'] as Record<string, unknown>
      assert.equal(output[e['output_index'] as number]!['id'], item['id'])
    }
    assert.equal(completed['output_text'], 'Looking that up. Opened it.')
  })
})

describe('writeStreamingResponse: input tokens across search rounds', () => {
  it('counts input per round when an overlapping search round precedes a solo one', async () => {
    const holder = createStreamResponse()
    const turns = [
      fakeStreamCompletion({
        tokens: [],
        toolCalls: [{ id: 'c1', name: 'tool_search', arguments: { query: 'create_issue' } }],
        text: '',
        stats: {
          promptTokens: 100,
          cacheTokens: 900,
          generatedTokens: 5,
          emittedTokens: 5,
          avgConcurrentSeq: 2
        }
      }),
      fakeStreamCompletion({
        tokens: ['Done.'],
        toolCalls: [],
        text: 'Done.',
        stats: {
          promptTokens: 20,
          cacheTokens: 218,
          generatedTokens: 10,
          emittedTokens: 10,
          avgConcurrentSeq: 1
        }
      })
    ]
    let turn = 0
    const completed = await writeStreamingResponse(
      holder.res,
      {
        ...baseHandlerParams('resp_rounds'),
        tools: [
          {
            type: 'function' as const,
            name: 'create_issue',
            description: 'Open a new issue on a repository',
            deferLoading: true,
            parameters: {
              type: 'object' as const,
              properties: { title: { type: 'string' as const } }
            }
          }
        ]
      },
      () => turns[turn++]!
    )
    assert.equal((completed['usage'] as { input_tokens: number }).input_tokens, 308)
  })
})
