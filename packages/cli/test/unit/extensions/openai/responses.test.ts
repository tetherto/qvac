import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { ServerResponse } from 'node:http'
import { buildResponseObject } from '@/serve/extensions/openai/adapters/responses-shape'
import { writeBlockingResponse } from '@/serve/extensions/openai/adapters/response-writers'
import { historyPrefixFromStoredResponse } from '@/serve/extensions/openai/schemas/responses'
import type {
  ResponsesHandlerParams,
  ResponseWriterContext
} from '@/serve/extensions/openai/adapters/response-writers'
import type { CompletionRun, ToolCall, CompletionStats } from '@qvac/sdk'

const uuidSuffix = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

describe('buildResponseObject', () => {
  it('builds text response', () => {
    const o = buildResponseObject({
      id: 'resp_test',
      modelAlias: 'my-model',
      text: 'hello world',
      toolCalls: [],
      createdAtSec: 42,
      metadata: undefined,
      temperature: 0.1,
      topP: undefined,
      maxOutputTokens: 16,
      parallelToolCalls: true,
      previousResponseId: null,
      store: true
    })
    assert.equal(o['id'], 'resp_test')
    assert.equal(o['object'], 'response')
    assert.equal(o['status'], 'completed')
    assert.equal(o['model'], 'my-model')
    assert.equal(o['output_text'], 'hello world')
    assert.equal((o['usage'] as { output_tokens: number }).output_tokens, 2)
    const out = o['output'] as Array<{ type: string }>
    assert.equal(out.length, 1)
    assert.equal(out[0]!.type, 'message')
  })

  it('requires_action when tool calls present; message first then function_call (approach b)', () => {
    const o = buildResponseObject({
      id: 'resp_t',
      modelAlias: 'm',
      text: 'hi',
      toolCalls: [{ id: 'call_1', name: 'fn', arguments: {} }],
      createdAtSec: 1,
      metadata: undefined,
      temperature: undefined,
      topP: undefined,
      maxOutputTokens: undefined,
      parallelToolCalls: true,
      previousResponseId: null,
      store: false
    })
    assert.equal(o['status'], 'requires_action')
    assert.equal(o['output_text'], 'hi')
    const out = o['output'] as Array<{ type: string; id?: string }>
    assert.ok(Array.isArray(out))
    assert.equal(out.length, 2)
    assert.equal(out[0]!.type, 'message')
    assert.equal(out[1]!.type, 'function_call')
    const ra = o['required_action'] as {
      type: string
      submit_tool_outputs: {
        tool_calls: Array<{ id: string; function: { name: string; arguments: string } }>
      }
    }
    assert.equal(ra.type, 'submit_tool_outputs')
    assert.equal(ra.submit_tool_outputs.tool_calls.length, 1)
    assert.equal(ra.submit_tool_outputs.tool_calls[0]!.id, 'call_1')
    assert.equal(ra.submit_tool_outputs.tool_calls[0]!.function.name, 'fn')
  })

  it('reuses messageItemId and functionCallItemIds when provided', () => {
    const msgId = 'msg_fixed_1'
    const fcIds = ['fc_fixed_a', 'fc_fixed_b']
    const o = buildResponseObject({
      id: 'resp_x',
      modelAlias: 'm',
      text: '',
      toolCalls: [
        { id: 'c1', name: 'a', arguments: {} },
        { id: 'c2', name: 'b', arguments: {} }
      ],
      createdAtSec: 1,
      metadata: undefined,
      temperature: undefined,
      topP: undefined,
      maxOutputTokens: undefined,
      parallelToolCalls: true,
      previousResponseId: null,
      store: false,
      messageItemId: msgId,
      functionCallItemIds: fcIds
    })
    const out = o['output'] as Array<{ type: string; id: string }>
    assert.equal(out[0]!.id, msgId)
    assert.equal(out[1]!.id, fcIds[0])
    assert.equal(out[2]!.id, fcIds[1])
  })

  it('uses stats.generatedTokens for usage.output_tokens when present', () => {
    const o = buildResponseObject({
      id: 'resp_u',
      modelAlias: 'm',
      text: 'one two three',
      toolCalls: [],
      createdAtSec: 1,
      metadata: undefined,
      temperature: undefined,
      topP: undefined,
      maxOutputTokens: undefined,
      parallelToolCalls: true,
      previousResponseId: null,
      store: true,
      stats: { generatedTokens: 99 }
    })
    const u = o['usage'] as { output_tokens: number; input_tokens: number; total_tokens: number }
    assert.equal(u.output_tokens, 99)
    assert.equal(u.total_tokens, 99)
  })

  it('reports prompt tokens as input_tokens and sums total_tokens', () => {
    const o = buildResponseObject({
      id: 'resp_in',
      modelAlias: 'm',
      text: 'hi',
      toolCalls: [],
      createdAtSec: 1,
      metadata: undefined,
      temperature: undefined,
      topP: undefined,
      maxOutputTokens: undefined,
      parallelToolCalls: true,
      previousResponseId: null,
      store: true,
      stats: { promptTokens: 120, cacheTokens: 80, emittedTokens: 7 }
    })
    // cacheTokens is cache occupancy, not this request's reuse, so it is not reported.
    assert.deepEqual(o['usage'], { input_tokens: 120, output_tokens: 7, total_tokens: 127 })
  })

  it('puts reasoning in its own output item ahead of the message', () => {
    const o = buildResponseObject({
      id: 'resp_r',
      modelAlias: 'm',
      text: 'The answer is 4.',
      items: [
        { type: 'reasoning', id: 'rs_1', text: '2 + 2 is 4.' },
        { type: 'message', id: 'msg_1', text: 'The answer is 4.' }
      ],
      toolCalls: [],
      createdAtSec: 1,
      metadata: undefined,
      temperature: undefined,
      topP: undefined,
      maxOutputTokens: undefined,
      parallelToolCalls: true,
      previousResponseId: null,
      store: true
    })
    const out = o['output'] as Array<Record<string, unknown>>
    assert.equal(out.length, 2)
    assert.equal(out[0]!['type'], 'reasoning')
    assert.match(out[0]!['id'] as string, /^rs_/)
    assert.deepEqual(out[0]!['content'], [{ type: 'reasoning_text', text: '2 + 2 is 4.' }])
    assert.equal(out[1]!['type'], 'message')
    assert.equal(o['output_text'], 'The answer is 4.')
  })

  it('reports the full input whether or not the KV cache was reused', () => {
    const usage = (stats: CompletionStats) =>
      buildResponseObject({
        id: 'resp_cache',
        modelAlias: 'm',
        text: 'hi',
        toolCalls: [],
        createdAtSec: 1,
        metadata: undefined,
        temperature: undefined,
        topP: undefined,
        maxOutputTokens: undefined,
        parallelToolCalls: true,
        previousResponseId: null,
        store: true,
        stats
      })['usage']
    // The same 262-token prompt: cold prefills all of it, warm only the tail.
    const cold = usage({
      promptTokens: 262,
      cacheTokens: 268,
      generatedTokens: 6,
      emittedTokens: 6
    })
    const warm = usage({ promptTokens: 14, cacheTokens: 268, generatedTokens: 6, emittedTokens: 6 })
    assert.deepEqual(cold, { input_tokens: 262, output_tokens: 6, total_tokens: 268 })
    assert.deepEqual(warm, cold)
    // Overlapping requests inflate the scheduler-wide cacheTokens; the request's
    // own promptTokens is used then.
    const overlapped = usage({
      promptTokens: 262,
      cacheTokens: 900,
      generatedTokens: 6,
      emittedTokens: 6,
      avgConcurrentSeq: 2
    })
    assert.deepEqual(overlapped, cold)
  })

  it('marks status incomplete with max_output_tokens reason when truncated by length', () => {
    const o = buildResponseObject({
      id: 'resp_len',
      modelAlias: 'm',
      text: 'truncated output',
      toolCalls: [],
      createdAtSec: 1,
      metadata: undefined,
      temperature: undefined,
      topP: undefined,
      maxOutputTokens: 4,
      parallelToolCalls: true,
      previousResponseId: null,
      store: false,
      stopReason: 'length'
    })
    assert.equal(o['status'], 'incomplete')
    assert.deepEqual(o['incomplete_details'], { reason: 'max_output_tokens' })
  })

  it('tool calls take precedence over length truncation (requires_action, no incomplete_details)', () => {
    const o = buildResponseObject({
      id: 'resp_len_tc',
      modelAlias: 'm',
      text: '',
      toolCalls: [{ id: 'c1', name: 'fn', arguments: {} }],
      createdAtSec: 1,
      metadata: undefined,
      temperature: undefined,
      topP: undefined,
      maxOutputTokens: undefined,
      parallelToolCalls: true,
      previousResponseId: null,
      store: false,
      stopReason: 'length'
    })
    assert.equal(o['status'], 'requires_action')
    assert.equal(o['incomplete_details'], undefined)
  })

  it('returns a namespaced tool call as name + namespace', () => {
    const o = buildResponseObject({
      id: 'resp_ns',
      modelAlias: 'm',
      text: '',
      toolCalls: [{ id: 'call_1', name: 'mcp__node_repl__js', arguments: { code: '1+1' } }],
      createdAtSec: 1,
      metadata: undefined,
      temperature: undefined,
      topP: undefined,
      maxOutputTokens: undefined,
      parallelToolCalls: true,
      previousResponseId: null,
      store: true,
      toolNamespaces: new Map([['mcp__node_repl__js', { namespace: 'mcp__node_repl', name: 'js' }]])
    })
    const call = (o['output'] as Array<Record<string, unknown>>).find(
      (item) => item['type'] === 'function_call'
    )!
    assert.equal(call['name'], 'js')
    assert.equal(call['namespace'], 'mcp__node_repl')
  })

  it('ids use uuid suffix after prefix', () => {
    const o = buildResponseObject({
      id: 'resp_test',
      modelAlias: 'm',
      text: 'x',
      toolCalls: [{ id: 'c1', name: 'f', arguments: {} }],
      createdAtSec: 1,
      metadata: undefined,
      temperature: undefined,
      topP: undefined,
      maxOutputTokens: undefined,
      parallelToolCalls: true,
      previousResponseId: null,
      store: false
    })
    const out = o['output'] as Array<{ id: string }>
    const msgRest = out[0]!.id.replace(/^msg_/, '')
    const fcRest = out[1]!.id.replace(/^fc_/, '')
    assert.match(msgRest, uuidSuffix)
    assert.match(fcRest, uuidSuffix)
  })
})

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

function baseHandlerParams(): ResponsesHandlerParams {
  return {
    ctx: minimalRouteContext(),
    sdkModelId: 'mid',
    history: [],
    modelAlias: 'alias',
    rid: 'resp_block_test',
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

function fakeCompletion(opts: {
  text: string
  thinking?: string
  /** Interleaved reasoning and text, emitted after `thinking` and `text`. */
  steps?: Array<{ think: string } | { text: string }>
  toolCalls: ToolCall[]
  stats?: CompletionStats
  stopReason?: string
}): CompletionRun {
  // Writers consume `result.events`; drive it the way the SDK does (content
  // delta, tool calls, stats, terminal done) rather than the legacy promises.
  async function* events(): AsyncGenerator<unknown> {
    let seq = 0
    if (opts.thinking) yield { type: 'thinkingDelta', seq: seq++, text: opts.thinking }
    if (opts.text) yield { type: 'contentDelta', seq: seq++, text: opts.text }
    for (const step of opts.steps ?? []) {
      yield 'think' in step
        ? { type: 'thinkingDelta', seq: seq++, text: step.think }
        : { type: 'contentDelta', seq: seq++, text: step.text }
    }
    for (const call of opts.toolCalls) yield { type: 'toolCall', seq: seq++, call }
    if (opts.stats !== undefined) yield { type: 'completionStats', seq: seq++, stats: opts.stats }
    yield { type: 'completionDone', seq: seq++, stopReason: opts.stopReason ?? 'eos' }
  }
  return {
    requestId: 'test',
    events: events() as unknown as CompletionRun['events'],
    final: Promise.resolve(undefined) as unknown as CompletionRun['final'],
    text: Promise.resolve(opts.text),
    toolCalls: Promise.resolve(opts.toolCalls) as unknown as CompletionRun['toolCalls'],
    stats: Promise.resolve(opts.stats),
    tokenStream: (async function* (): AsyncGenerator<string> {})(),
    toolCallStream: (async function* (): AsyncGenerator<never> {})()
  }
}

describe('writeBlockingResponse', () => {
  it('returns JSON with usage from emittedTokens over inflated generatedTokens', async () => {
    let status = 0
    let bodyStr = ''
    let sent = false
    const res = {
      setHeader: (): void => {},
      writeHead(s: number): void {
        status = s
        sent = true
      },
      end(payload?: string | Buffer): void {
        if (typeof payload === 'string') bodyStr = payload
      },
      get headersSent(): boolean {
        return sent
      }
    } as unknown as ServerResponse

    const p = baseHandlerParams()
    const result = fakeCompletion({
      text: 'hello',
      toolCalls: [],
      stats: { generatedTokens: 42, emittedTokens: 1 }
    })

    const obj = await writeBlockingResponse(res, p, () => result)
    assert.equal(status, 200)
    assert.equal((obj['usage'] as { output_tokens: number }).output_tokens, 1)
    const parsed = JSON.parse(bodyStr) as { usage: { output_tokens: number } }
    assert.equal(parsed.usage.output_tokens, 1)
  })

  it('includes required_action when tool calls present', async () => {
    let bodyStr = ''
    let sent = false
    const res = {
      setHeader: (): void => {},
      writeHead: (): void => {
        sent = true
      },
      end(payload?: string | Buffer): void {
        if (typeof payload === 'string') bodyStr = payload
      },
      get headersSent(): boolean {
        return sent
      }
    } as unknown as ServerResponse

    const p = baseHandlerParams()
    const result = fakeCompletion({
      text: '',
      toolCalls: [{ id: 'call_x', name: 'fn', arguments: {} }],
      stats: { generatedTokens: 1 }
    })

    const obj = await writeBlockingResponse(res, p, () => result)
    assert.equal(obj['status'], 'requires_action')
    assert.ok((obj['required_action'] as { submit_tool_outputs: unknown }).submit_tool_outputs)
    const parsed = JSON.parse(bodyStr) as {
      required_action: { submit_tool_outputs: { tool_calls: unknown[] } }
    }
    assert.equal(parsed.required_action.submit_tool_outputs.tool_calls.length, 1)
  })

  it('returns reasoning separately from the answer and reports input tokens', async () => {
    let bodyStr = ''
    let sent = false
    const res = {
      setHeader: (): void => {},
      writeHead: (): void => {
        sent = true
      },
      end(payload?: string | Buffer): void {
        if (typeof payload === 'string') bodyStr = payload
      },
      get headersSent(): boolean {
        return sent
      }
    } as unknown as ServerResponse

    const result = fakeCompletion({
      thinking: 'The user wants a greeting.',
      text: 'Hello!',
      toolCalls: [],
      stats: { promptTokens: 31, emittedTokens: 9 }
    })

    await writeBlockingResponse(res, baseHandlerParams(), () => result)
    const parsed = JSON.parse(bodyStr) as {
      output: Array<Record<string, unknown>>
      output_text: string
      usage: { input_tokens: number; output_tokens: number; total_tokens: number }
    }
    assert.equal(parsed.output_text, 'Hello!')
    assert.deepEqual(
      parsed.output.map((o) => o['type']),
      ['reasoning', 'message']
    )
    assert.deepEqual(parsed.output[0]!['content'], [
      { type: 'reasoning_text', text: 'The user wants a greeting.' }
    ])
    assert.equal(JSON.stringify(parsed.output[1]).includes('greeting'), false)
    assert.deepEqual(parsed.usage, { input_tokens: 31, output_tokens: 9, total_tokens: 40 })
  })
})

describe('writeBlockingResponse: item order matches streaming', () => {
  function captureRes(): { res: ServerResponse; body: () => any } {
    let bodyStr = ''
    let sent = false
    const res = {
      setHeader: (): void => {},
      writeHead: (): void => {
        sent = true
      },
      end(payload?: string | Buffer): void {
        if (typeof payload === 'string') bodyStr = payload
      },
      get headersSent(): boolean {
        return sent
      }
    } as unknown as ServerResponse
    return { res, body: () => JSON.parse(bodyStr) }
  }

  it('keeps items in the order the model produced them', async () => {
    const { res, body } = captureRes()
    const result = fakeCompletion({
      text: '',
      steps: [{ think: 'First.' }, { text: 'Partial ' }, { think: 'Second.' }, { text: 'answer.' }],
      toolCalls: []
    })
    await writeBlockingResponse(res, baseHandlerParams(), () => result)
    const parsed = body()
    assert.deepEqual(
      parsed.output.map((o: { type: string }) => o.type),
      ['reasoning', 'message', 'reasoning', 'message']
    )
    assert.equal(parsed.output_text, 'Partial answer.')
  })

  it('keeps the search preamble, as streaming does', async () => {
    const { res, body } = captureRes()
    const deferredTool = {
      type: 'function' as const,
      name: 'create_issue',
      description: 'Open a new issue on a repository',
      deferLoading: true,
      parameters: { type: 'object' as const, properties: { title: { type: 'string' as const } } }
    }
    const turns = [
      fakeCompletion({
        text: 'Looking that up. ',
        toolCalls: [{ id: 'c1', name: 'tool_search', arguments: { query: 'create_issue' } }]
      }),
      fakeCompletion({ thinking: 'The tool is loaded now.', text: 'Opened it.', toolCalls: [] })
    ]
    let turn = 0
    await writeBlockingResponse(
      res,
      { ...baseHandlerParams(), tools: [deferredTool] },
      () => turns[turn++]!
    )
    const parsed = body()
    assert.equal(turn, 2)
    assert.deepEqual(
      parsed.output.map((o: { type: string }) => o.type),
      ['message', 'reasoning', 'message']
    )
    assert.equal(parsed.output_text, 'Looking that up. Opened it.')
  })
})

describe('historyPrefixFromStoredResponse', () => {
  it('replays the answer without the reasoning item', () => {
    const responseObject = buildResponseObject({
      id: 'resp_prev',
      modelAlias: 'm',
      text: 'Hello!',
      items: [
        { type: 'reasoning', id: 'rs_1', text: 'The user wants a greeting.' },
        { type: 'message', id: 'msg_1', text: 'Hello!' }
      ],
      toolCalls: [],
      createdAtSec: 1,
      metadata: undefined,
      temperature: undefined,
      topP: undefined,
      maxOutputTokens: undefined,
      parallelToolCalls: true,
      previousResponseId: null,
      store: true
    })
    const prefix = historyPrefixFromStoredResponse({
      responseObject,
      inputItems: [{ type: 'message', role: 'user', content: 'Hi' }]
    })
    assert.deepEqual(prefix, [
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Hello!' }
    ])
  })

  it('replays a tool call with the text generated before it', async () => {
    async function* events(): AsyncGenerator<unknown> {
      yield { type: 'contentDelta', seq: 0, text: 'Reading it.' }
      yield { type: 'toolCall', seq: 1, call: { id: 'call_1', name: 'read', arguments: {} } }
      yield { type: 'contentDelta', seq: 2, text: 'Done.' }
      yield { type: 'completionDone', seq: 3, stopReason: 'eos' }
    }
    const run = {
      ...fakeCompletion({ text: '', toolCalls: [] }),
      events: events() as unknown as CompletionRun['events']
    }
    let sent = false
    const res = {
      setHeader: (): void => {},
      writeHead: (): void => {
        sent = true
      },
      end: (): void => {},
      get headersSent(): boolean {
        return sent
      }
    } as unknown as ServerResponse
    const responseObject = await writeBlockingResponse(res, baseHandlerParams(), () => run)
    assert.deepEqual(
      (responseObject['output'] as Array<{ type: string }>).map((o) => o.type),
      ['message', 'function_call', 'message']
    )
    const prefix = historyPrefixFromStoredResponse({ responseObject, inputItems: [] })
    assert.deepEqual(
      prefix.map((turn) => [turn.content, turn.toolCalls?.map((call) => call.name)]),
      [
        ['Reading it.', ['read']],
        ['Done.', undefined]
      ]
    )
  })
})
