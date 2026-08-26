import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  configSchemaForAddon,
  paramFields,
  coerceParam,
  validateParam
} from '../src/configure/param-schemas.js'

describe('configure: param-schemas', () => {
  it('resolves schemas only for addons the SDK exposes', () => {
    assert.ok(configSchemaForAddon('llm'))
    assert.ok(configSchemaForAddon('embeddings'))
    assert.equal(configSchemaForAddon('tts'), undefined)
    assert.equal(configSchemaForAddon('diffusion'), undefined)
    assert.equal(configSchemaForAddon(null), undefined)
    assert.equal(configSchemaForAddon(undefined), undefined)
  })

  it('enumerates llamacpp fields with type hints and descriptions', () => {
    const schema = configSchemaForAddon('llm')
    assert.ok(schema)
    const fields = paramFields(schema)
    assert.ok(fields.length > 10)

    const ctx = fields.find((f) => f.name === 'ctx_size')
    assert.ok(ctx)
    assert.equal(ctx.type, 'number')
    assert.match(ctx.description, /context window/i)

    const temp = fields.find((f) => f.name === 'temp')
    assert.ok(temp)
    assert.match(temp.type, /<= 2/)

    // every field carries a schema for validation
    for (const f of fields) assert.ok(f.schema)
  })

  it('coerces raw input to the right JSON type, blank clears', () => {
    assert.equal(coerceParam('1024'), 1024)
    assert.equal(coerceParam('true'), true)
    assert.equal(coerceParam(''), undefined)
    assert.equal(coerceParam('   '), undefined)
    assert.equal(coerceParam('gpu'), 'gpu')
    assert.deepEqual(coerceParam('["stop"]'), ['stop'])
  })

  it('renders enum values bare and accepts bare/single/double-quoted input', () => {
    const schema = configSchemaForAddon('embeddings')
    assert.ok(schema)
    const attention = paramFields(schema).find((f) => f.name === 'attention')
    assert.ok(attention)
    // hint shows bare values, matching how they're typed (no surrounding quotes)
    assert.equal(attention.type, 'causal | non-causal')
    // all three forms the user might type (incl. the single-quoted form the
    // description renders) coerce and validate the same
    assert.equal(coerceParam("'causal'"), 'causal')
    assert.equal(validateParam(attention, 'causal'), true)
    assert.equal(validateParam(attention, "'causal'"), true)
    assert.equal(validateParam(attention, '"causal"'), true)
    assert.equal(validateParam(attention, "'non-causal'"), true)
  })

  it('validates input against the real field schema', () => {
    const schema = configSchemaForAddon('llm')
    assert.ok(schema)
    const fields = paramFields(schema)
    const temp = fields.find((f) => f.name === 'temp')
    const ctx = fields.find((f) => f.name === 'ctx_size')
    assert.ok(temp && ctx)

    assert.equal(validateParam(temp, '0.8'), true)
    assert.equal(validateParam(temp, ''), true) // blank = clear
    assert.notEqual(validateParam(temp, '3'), true) // above max 2
    assert.equal(validateParam(ctx, '2048'), true)
    assert.notEqual(validateParam(ctx, 'abc'), true)
  })
})
