'use strict'

const test = require('brittle')
const TranscriptionParakeet = require('../../index.js')

TranscriptionParakeet.prototype.validateModelFiles = () => undefined

function buildParams(parakeetConfig = {}) {
  const model = new TranscriptionParakeet({
    files: { model: './models/parakeet-tdt-0.6b-v3.q8_0.gguf' },
    config: { parakeetConfig }
  })
  return model._buildConfigurationParams()
}

test('AOSC numeric fields stay undefined so the native config owns the defaults', (t) => {
  const params = buildParams()

  t.is(params.streamingSpkCacheLen, undefined, 'spkCacheLen is not hardcoded on the JS side')
  t.is(params.streamingFifoLen, undefined, 'fifoLen is not hardcoded on the JS side')
  t.is(params.streamingChunkLeftContextMs, undefined)
  t.is(params.streamingChunkRightContextMs, undefined)
  t.is(params.streamingSpkCacheUpdatePeriod, undefined)
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
