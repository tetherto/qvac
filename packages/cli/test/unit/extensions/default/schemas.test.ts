import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { FastifySchemaValidationError } from 'fastify/types/schema.js'
import { validatorCompiler } from 'fastify-type-provider-zod'
import {
  MAX_BATCH_INPUTS,
  TRANSLATE_FIELD_CODES,
  translateBody
} from '@/serve/extensions/default/schemas/translate'

function issuePaths(input: unknown): string[] {
  const result = translateBody.safeParse(input)
  assert.equal(result.success, false, `expected ${JSON.stringify(input)} to fail validation`)
  return result.error!.issues.map((i) => i.path.join('/'))
}

describe('translateBody', () => {
  it('accepts a single input', () => {
    const result = translateBody.safeParse({ model: 'ta-en', text: 'வணக்கம்' })
    assert.equal(result.success, true)
  })

  it('accepts a batch and an explicit stream flag', () => {
    assert.equal(translateBody.safeParse({ model: 'ta-en', text: ['a', 'b'] }).success, true)
    assert.equal(translateBody.safeParse({ model: 'ta-en', text: 'a', stream: true }).success, true)
  })

  it('requires model and text', () => {
    assert.deepEqual(issuePaths({ text: 'a' }), ['model'])
    assert.deepEqual(issuePaths({ model: 'ta-en' }), ['text'])
  })

  it('accepts a batch at the cap and rejects one over it', () => {
    const atCap = Array.from({ length: MAX_BATCH_INPUTS }, () => 'a')
    assert.equal(translateBody.safeParse({ model: 'ta-en', text: atCap }).success, true)
    assert.deepEqual(issuePaths({ model: 'ta-en', text: [...atCap, 'a'] }), ['text'])
  })

  it('rejects empty text and an empty batch', () => {
    assert.deepEqual(issuePaths({ model: 'ta-en', text: '' }), ['text'])
    assert.deepEqual(issuePaths({ model: 'ta-en', text: [] }), ['text'])
  })

  // The error handler keys off the first path segment, so an indexed issue
  // still reports the field's own code.
  it('rejects an empty batch entry, reporting its index', () => {
    assert.deepEqual(issuePaths({ model: 'ta-en', text: ['a', ''] }), ['text/1'])
  })

  it('rejects unknown fields', () => {
    const result = translateBody.safeParse({ model: 'ta-en', text: 'a', nope: true })
    assert.equal(result.success, false)
    assert.match(result.error!.issues[0]!.message, /unrecognized key/i)
  })

  it('maps text to its own code, and an over-cap batch to a separate one', () => {
    assert.equal(TRANSLATE_FIELD_CODES['text'], 'missing_text')
    assert.equal(TRANSLATE_FIELD_CODES['text:too_big'], 'too_many_inputs')
  })

  it('reports an over-cap batch as the too_big issue the code keys off', () => {
    const result = translateBody.safeParse({
      model: 'ta-en',
      text: Array.from({ length: MAX_BATCH_INPUTS + 1 }, () => 'a')
    })
    assert.equal(result.success, false)
    assert.equal(result.error!.issues[0]?.code, 'too_big')
  })

  // The error handler builds its `text:too_big` lookup key from these two fields.
  it('surfaces the over-cap issue on err.validation as keyword and instancePath', () => {
    const validate = validatorCompiler({
      schema: translateBody,
      method: 'POST',
      url: '/qvac/v1/translate',
      httpPart: 'body'
    })
    const result = validate({
      model: 'ta-en',
      text: Array.from({ length: MAX_BATCH_INPUTS + 1 }, () => 'a')
    }) as { error?: FastifySchemaValidationError[] }

    assert.equal(result.error?.[0]?.keyword, 'too_big')
    assert.equal(result.error?.[0]?.instancePath, '/text')
  })
})
