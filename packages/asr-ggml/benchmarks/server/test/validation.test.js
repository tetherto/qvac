'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { ParakeetConfigSchema, ParakeetRunConfigSchema } = require('../src/validation')

test('accepts Parakeet Unified without a language', () => {
  const config = ParakeetConfigSchema.parse({ modelType: 'unified' })

  assert.equal(config.modelType, 'unified')
  assert.equal(config.language, undefined)
})

test('accepts Indic Conformer with a language', () => {
  const config = ParakeetConfigSchema.parse({
    modelType: 'indic-conformer',
    language: 'hi'
  })

  assert.equal(config.language, 'hi')
})

test('rejects Indic Conformer without a language', () => {
  assert.throws(
    () => ParakeetConfigSchema.parse({ modelType: 'indic-conformer' }),
    /Indic Conformer requires a language/
  )
})

test('accepts the ms-based streaming controls', () => {
  const config = ParakeetRunConfigSchema.parse({
    path: './models/parakeet-unified-en-0.6b.f16.gguf',
    streaming: true,
    streamingChunkMs: 320,
    streamingHistoryMs: 30000,
    streamingEmitPartials: false
  })

  assert.equal(config.streaming, true)
  assert.equal(config.streamingChunkMs, 320)
  assert.equal(config.streamingHistoryMs, 30000)
  assert.equal(config.streamingEmitPartials, false)
})

test('streaming controls are optional and streaming defaults to false', () => {
  const config = ParakeetRunConfigSchema.parse({ path: './models/model.gguf' })

  assert.equal(config.streaming, false)
  assert.equal(config.streamingChunkMs, undefined)
  assert.equal(config.streamingHistoryMs, undefined)
  assert.equal(config.streamingEmitPartials, undefined)
})

test('rejects a non-positive streaming chunk', () => {
  assert.throws(() =>
    ParakeetRunConfigSchema.parse({
      path: './models/model.gguf',
      streamingChunkMs: 0
    })
  )
})

test('strips the retired byte-based streamingChunkSize key', () => {
  const config = ParakeetRunConfigSchema.parse({
    path: './models/model.gguf',
    streaming: true,
    streamingChunkSize: 64000
  })

  assert.equal('streamingChunkSize' in config, false)
})
