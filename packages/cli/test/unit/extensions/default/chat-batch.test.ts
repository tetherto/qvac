import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { FastifySchemaValidationError } from 'fastify/types/schema.js'
import { validatorCompiler } from 'fastify-type-provider-zod'
import { SDK_SERVER_ERROR_CODES, type CompletionFinal } from '@qvac/sdk'
import { HttpError } from '@/serve/lib/http-error'
import {
  CHAT_BATCH_FIELD_CODES,
  MAX_BATCH_PROMPTS,
  chatBatchBody,
  chatBatchResult
} from '@/serve/extensions/default/schemas/chat-batch'
import { toHttpError, toResultItem } from '@/serve/extensions/default/routes/chat-batch'

const prompt = { messages: [{ role: 'user', content: 'hi' }] }

function issuePaths(input: unknown): string[] {
  const result = chatBatchBody.safeParse(input)
  assert.equal(result.success, false, `expected ${JSON.stringify(input)} to fail validation`)
  return result.error!.issues.map((i) => i.path.join('/'))
}

function final(overrides: Partial<CompletionFinal>): CompletionFinal {
  return { contentText: '', toolCalls: [], raw: { fullText: '' }, ...overrides }
}

describe('chatBatchBody', () => {
  it('accepts prompts with chat-completion fields and an optional id', () => {
    const result = chatBatchBody.safeParse({
      model: 'llm',
      prompts: [
        { ...prompt, id: 'a', max_tokens: 16, temperature: 0, seed: 42 },
        { ...prompt, response_format: { type: 'json_object' }, reasoning_budget: false }
      ]
    })
    assert.equal(result.success, true)
  })

  it('requires model and a non-empty prompts array', () => {
    assert.deepEqual(issuePaths({ prompts: [prompt] }), ['model'])
    assert.deepEqual(issuePaths({ model: 'llm' }), ['prompts'])
    assert.deepEqual(issuePaths({ model: 'llm', prompts: [] }), ['prompts'])
  })

  it('requires messages on each prompt', () => {
    assert.deepEqual(issuePaths({ model: 'llm', prompts: [prompt, {}] }), ['prompts/1/messages'])
    assert.deepEqual(issuePaths({ model: 'llm', prompts: [{ messages: [] }] }), [
      'prompts/0/messages'
    ])
  })

  it('accepts prompts at the cap and rejects one over it', () => {
    const atCap = Array.from({ length: MAX_BATCH_PROMPTS }, () => prompt)
    assert.equal(chatBatchBody.safeParse({ model: 'llm', prompts: atCap }).success, true)
    assert.deepEqual(issuePaths({ model: 'llm', prompts: [...atCap, prompt] }), ['prompts'])
  })

  it('rejects unknown fields at the top level and on a prompt', () => {
    assert.deepEqual(issuePaths({ model: 'llm', prompts: [prompt], stream: true }), [''])
    assert.deepEqual(issuePaths({ model: 'llm', prompts: [{ ...prompt, n: 2 }] }), ['prompts/0'])
  })

  it('maps prompt failures to invalid_prompts and an over-cap batch to its own code', () => {
    assert.equal(CHAT_BATCH_FIELD_CODES['prompts'], 'invalid_prompts')
    assert.equal(CHAT_BATCH_FIELD_CODES['prompts:too_big'], 'too_many_prompts')
  })

  // The error handler builds its `prompts:too_big` lookup key from these two fields.
  it('surfaces the over-cap issue on err.validation as keyword and instancePath', () => {
    const validate = validatorCompiler({
      schema: chatBatchBody,
      method: 'POST',
      url: '/qvac/v1/chat/batch',
      httpPart: 'body'
    })
    const result = validate({
      model: 'llm',
      prompts: Array.from({ length: MAX_BATCH_PROMPTS + 1 }, () => prompt)
    }) as { error?: FastifySchemaValidationError[] }

    assert.equal(result.error?.[0]?.keyword, 'too_big')
    assert.equal(result.error?.[0]?.instancePath, '/prompts')
  })
})

describe('toResultItem', () => {
  it('maps text, reasoning and a length stop', () => {
    const item = toResultItem(
      'a',
      0,
      final({ contentText: 'CHERRY', thinkingText: 'hmm', stopReason: 'length' })
    )
    assert.deepEqual(item, {
      id: 'a',
      index: 0,
      message: { role: 'assistant', content: 'CHERRY', reasoning_content: 'hmm' },
      finish_reason: 'length'
    })
  })

  it('maps tool calls to OpenAI shape with null content', () => {
    const item = toResultItem(
      'b',
      1,
      final({
        contentText: 'ignored',
        toolCalls: [
          { id: 'call_1', name: 'get_weather', arguments: { city: 'Paris' } }
        ] as CompletionFinal['toolCalls'],
        stopReason: 'eos'
      })
    )
    assert.equal(item.message.content, null)
    assert.equal(item.finish_reason, 'tool_calls')
    assert.deepEqual(item.message.tool_calls, [
      {
        id: 'call_1',
        type: 'function',
        function: { name: 'get_weather', arguments: '{"city":"Paris"}' }
      }
    ])
  })

  it('reports empty output as null content and stop', () => {
    const item = toResultItem('c', 2, final({ stopReason: 'eos' }))
    assert.equal(item.message.content, null)
    assert.equal(item.finish_reason, 'stop')
    assert.equal(chatBatchResult.shape.results.element.safeParse(item).success, true)
  })
})

describe('toHttpError', () => {
  function sdkError(code: number): Error {
    return Object.assign(new Error('boom'), { code })
  }

  it('maps a context overflow to 400 context_length_exceeded', () => {
    const err = toHttpError(sdkError(SDK_SERVER_ERROR_CODES.CONTEXT_OVERFLOW))
    assert.ok(err instanceof HttpError)
    assert.equal(err.status, 400)
    assert.equal(err.code, 'context_length_exceeded')
  })

  it('maps a failed completion to 502 inference_failed', () => {
    const err = toHttpError(sdkError(SDK_SERVER_ERROR_CODES.COMPLETION_FAILED))
    assert.ok(err instanceof HttpError)
    assert.equal(err.status, 502)
    assert.equal(err.code, 'inference_failed')
  })

  it('passes anything else through unchanged', () => {
    const original = new Error('other')
    assert.equal(toHttpError(original), original)
  })
})
