'use strict'

const test = require('brittle')
const ASRGgml = require('../../index.js')
const { MODEL_PATH, getDriver, createParakeetModel } = require('../mocks/createModel.js')

function buildParams(parakeetConfig = {}) {
  const model = new ASRGgml({
    files: { model: MODEL_PATH },
    config: { engine: 'parakeet', parakeetConfig }
  })
  return getDriver(model)._buildConfigurationParams()
}

test('AOSC numeric fields stay undefined so the native config owns the defaults', (t) => {
  const params = buildParams()

  t.is(params.streamingSpkCacheLen, undefined, 'spkCacheLen is not hardcoded on the JS side')
  t.is(params.streamingFifoLen, undefined, 'fifoLen is not hardcoded on the JS side')
  t.is(params.streamingChunkLeftContextMs, undefined)
  t.is(params.streamingChunkRightContextMs, undefined)
  t.is(params.streamingSpkCacheUpdatePeriod, undefined)
})

test('streaming chunk stays undefined so native model detection owns the default', (t) => {
  t.is(buildParams().streamingChunkMs, undefined)
})

test('explicit streaming chunk is forwarded verbatim', (t) => {
  t.is(buildParams({ streamingChunkMs: 160 }).streamingChunkMs, 160)
  t.is(buildParams({ streamingChunkMs: 2000 }).streamingChunkMs, 2000)
})

test('AOSC numeric fields are forwarded verbatim when the caller sets them', (t) => {
  const params = buildParams({
    streamingSpkCacheLen: 200,
    streamingFifoLen: 100,
    streamingChunkLeftContextMs: 40,
    streamingChunkRightContextMs: 320,
    streamingSpkCacheUpdatePeriod: 72
  })

  t.is(params.streamingSpkCacheLen, 200)
  t.is(params.streamingFifoLen, 100)
  t.is(params.streamingChunkLeftContextMs, 40)
  t.is(params.streamingChunkRightContextMs, 320)
  t.is(params.streamingSpkCacheUpdatePeriod, 72)
})

test('streamingSpkCacheEnable defaults to true and coerces to a boolean', (t) => {
  t.is(buildParams().streamingSpkCacheEnable, true, 'enabled by default')
  t.is(
    buildParams({ streamingSpkCacheEnable: false }).streamingSpkCacheEnable,
    false,
    'explicit false is honoured'
  )
})

test('language is forwarded when the caller sets it', (t) => {
  t.is(buildParams().language, '', 'empty string when unset')
  t.is(buildParams({ language: 'hi' }).language, 'hi')
})

test('explicit backend is forwarded independently of the legacy GPU preference', (t) => {
  t.is(buildParams().backend, 'auto')
  for (const backend of ['auto', 'cpu', 'opencl', 'hexagon']) {
    t.is(buildParams({ backend, useGPU: false }).backend, backend)
    t.is(buildParams({ backend, useGPU: true }).backend, backend)
  }
})

test('invalid backend values fail before native model activation', (t) => {
  for (const backend of ['', 'htp', 'Hexagon', 2, null]) {
    t.exception(() => buildParams({ backend }), /backend must be/)
  }
})

test('invalid backend reload preserves the existing configuration', async (t) => {
  const { model } = createParakeetModel({ parakeetConfig: { backend: 'hexagon' } })
  await model.load()
  await t.exception(model.reload({ parakeetConfig: { backend: 'htp' } }), /backend must be/)
  t.is(getDriver(model).params.backend, 'hexagon')
  await model.destroy()
})

test('unknown parakeetConfig keys are rejected at construction', (t) => {
  try {
    buildParams({ notARealKey: 1 })
    t.fail('Unknown parakeetConfig key should throw INVALID_CONFIG')
  } catch (error) {
    t.is(
      error.code,
      ASRGgml.ERR_CODES.INVALID_CONFIG,
      'Unknown parakeetConfig key rejects with INVALID_CONFIG'
    )
  }
})
