import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildResponseObject } from '../src/serve/adapters/openai/responses-shape.js'

describe('buildResponseObject', () => {
  it('builds text response', () => {
    const o = buildResponseObject({
      id: 'resp_test',
      modelAlias: 'my-model',
      text: 'hello world',
      toolCalls: null,
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
  })

  it('requires_action when tool calls present', () => {
    const o = buildResponseObject({
      id: 'resp_t',
      modelAlias: 'm',
      text: '',
      toolCalls: [{ id: 'call_1', name: 'fn', arguments: '{}' }],
      createdAtSec: 1,
      metadata: undefined,
      temperature: undefined,
      topP: undefined,
      maxOutputTokens: undefined,
      parallelToolCalls: undefined,
      previousResponseId: null,
      store: false
    })
    assert.equal(o['status'], 'requires_action')
    const out = o['output'] as unknown[]
    assert.ok(Array.isArray(out))
    assert.equal((out[0] as { type: string }).type, 'function_call')
  })
})
