import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { ServerResponse } from 'node:http'
import { buildResponseObject } from '../src/serve/adapters/openai/responses-shape.js'
import { writeBlockingResponse } from '../src/serve/adapters/openai/routes/responses.js'
import type { ResponsesHandlerParams } from '../src/serve/adapters/openai/routes/responses.js'
import type { CompletionRun, ToolCall, CompletionStats } from '@qvac/sdk'
import type { RouteContext } from '../src/serve/adapters/types.js'

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
      submit_tool_outputs: { tool_calls: Array<{ id: string; function: { name: string; arguments: string } }> }
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

function minimalRouteContext (): RouteContext {
  return {
    registry: {} as RouteContext['registry'],
    serveConfig: {} as RouteContext['serveConfig'],
    logger: {
      info: (): void => {},
      warn: (): void => {},
      error: (): void => {},
      debug: (): void => {}
    },
    responsesStore: {
      put: (): void => {},
      get: (): undefined => undefined,
      delete: (): boolean => false,
      listInputItems: (): null => null,
      size: (): number => 0,
      bannerLine: (): string => ''
    }
  }
}

function baseHandlerParams (): ResponsesHandlerParams {
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

function fakeCompletion (opts: {
  text: string
  toolCalls: ToolCall[]
  stats?: CompletionStats
}): CompletionRun {
  return {
    requestId: 'test',
    events: (async function * empty (): AsyncGenerator<never> {})(),
    final: Promise.resolve(undefined) as unknown as CompletionRun['final'],
    text: Promise.resolve(opts.text),
    toolCalls: Promise.resolve(opts.toolCalls) as unknown as CompletionRun['toolCalls'],
    stats: Promise.resolve(opts.stats),
    tokenStream: (async function * empty (): AsyncGenerator<string> {})(),
    toolCallStream: (async function * empty (): AsyncGenerator<never> {})()
  }
}

describe('writeBlockingResponse', () => {
  it('returns JSON with usage from stats.generatedTokens', async () => {
    let status = 0
    let bodyStr = ''
    let sent = false
    const res = {
      setHeader: (): void => {},
      writeHead (s: number): void {
        status = s
        sent = true
      },
      end (payload?: string | Buffer): void {
        if (typeof payload === 'string') bodyStr = payload
      },
      get headersSent (): boolean {
        return sent
      }
    } as unknown as ServerResponse

    const p = baseHandlerParams()
    const result = fakeCompletion({
      text: 'hello',
      toolCalls: [],
      stats: { generatedTokens: 42 }
    })

    const obj = await writeBlockingResponse(res, p, result)
    assert.equal(status, 200)
    assert.equal((obj['usage'] as { output_tokens: number }).output_tokens, 42)
    const parsed = JSON.parse(bodyStr) as { usage: { output_tokens: number } }
    assert.equal(parsed.usage.output_tokens, 42)
  })

  it('includes required_action when tool calls present', async () => {
    let bodyStr = ''
    let sent = false
    const res = {
      setHeader: (): void => {},
      writeHead: (): void => {
        sent = true
      },
      end (payload?: string | Buffer): void {
        if (typeof payload === 'string') bodyStr = payload
      },
      get headersSent (): boolean {
        return sent
      }
    } as unknown as ServerResponse

    const p = baseHandlerParams()
    const result = fakeCompletion({
      text: '',
      toolCalls: [{ id: 'call_x', name: 'fn', arguments: {} }],
      stats: { generatedTokens: 1 }
    })

    const obj = await writeBlockingResponse(res, p, result)
    assert.equal(obj['status'], 'requires_action')
    assert.ok((obj['required_action'] as { submit_tool_outputs: unknown }).submit_tool_outputs)
    const parsed = JSON.parse(bodyStr) as { required_action: { submit_tool_outputs: { tool_calls: unknown[] } } }
    assert.equal(parsed.required_action.submit_tool_outputs.tool_calls.length, 1)
  })
})
