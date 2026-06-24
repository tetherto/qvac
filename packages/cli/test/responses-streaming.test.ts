import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { ServerResponse } from 'node:http'
import { writeStreamingResponse } from '../src/serve/adapters/openai/response-writers.js'
import type { ResponsesHandlerParams, ResponseWriterContext } from '../src/serve/adapters/openai/response-writers.js'
import type { CompletionRun, CompletionStats, ToolCall } from '@qvac/sdk'

function minimalRouteContext (): ResponseWriterContext {
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

function baseHandlerParams (rid: string): ResponsesHandlerParams {
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

function fakeStreamCompletion (opts: {
  tokens: string[]
  toolCalls: ToolCall[]
  text: string
  stats?: CompletionStats
  stopReason?: string
}): CompletionRun {
  // Writers consume `result.events`; drive content deltas, tool calls, stats
  // and the terminal `stopReason` the way the SDK does.
  async function * events (): AsyncGenerator<unknown> {
    let seq = 0
    for (const t of opts.tokens) yield { type: 'contentDelta', seq: seq++, text: t }
    for (const call of opts.toolCalls) yield { type: 'toolCall', seq: seq++, call }
    if (opts.stats !== undefined) yield { type: 'completionStats', seq: seq++, stats: opts.stats }
    yield { type: 'completionDone', seq: seq++, stopReason: opts.stopReason ?? 'eos' }
  }
  async function * gen (): AsyncGenerator<string> {
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
    toolCallStream: (async function * empty (): AsyncGenerator<never> {})()
  }
}

function parseSseJsonEvents (raw: string): unknown[] {
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

function createStreamResponse (): { res: ServerResponse; raw: string } {
  const parts: string[] = []
  let sent = false
  const res = {
    setHeader: (): void => {},
    writeHead: (): void => {
      sent = true
    },
    write (chunk: string): boolean {
      parts.push(chunk)
      return true
    },
    end (chunk?: string | Buffer): void {
      if (chunk !== undefined && chunk !== null) parts.push(String(chunk))
    },
    get headersSent (): boolean {
      return sent
    }
  } as unknown as ServerResponse
  return {
    res,
    get raw (): string {
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
      stats: { generatedTokens: 5 }
    })

    const completed = await writeStreamingResponse(holder.res, p, result)
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
    assert.equal(completedEvent.response.usage.output_tokens, 5)
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

    const completed = await writeStreamingResponse(holder.res, p, result)
    const events = parseSseJsonEvents(holder.raw) as Array<Record<string, unknown>>

    const argDeltas = events.filter((e) => e['type'] === 'response.function_call_arguments.delta')
    assert.equal(argDeltas.length, 2)
    assert.notEqual((argDeltas[0] as { item_id: string }).item_id, 'call_a')
    assert.notEqual((argDeltas[1] as { item_id: string }).item_id, 'call_b')
    assert.equal((argDeltas[0] as { output_index: number }).output_index, 1)
    assert.equal((argDeltas[1] as { output_index: number }).output_index, 2)

    const out = completed['output'] as Array<{ type: string; id: string; call_id?: string }>
    assert.equal(out.length, 3)
    assert.equal(out[0]!.type, 'message')
    assert.equal(out[1]!.type, 'function_call')
    assert.equal(out[2]!.type, 'function_call')
    assert.equal(out[1]!.id, (argDeltas[0] as { item_id: string }).item_id)
    assert.equal(out[2]!.id, (argDeltas[1] as { item_id: string }).item_id)
    assert.equal(out[1]!.call_id, 'call_a')
    assert.equal(out[2]!.call_id, 'call_b')

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

    const completed = await writeStreamingResponse(holder.res, p, result)
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
