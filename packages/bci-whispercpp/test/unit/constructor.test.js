'use strict'

const test = require('brittle')
const BCIWhispercpp = require('../../index')
const { ERR_CODES } = require('../../lib/error')

const MODEL = '/tmp/ggml-bci-windowed.bin'
const EMBEDDER = '/tmp/bci-embedder.bin'

test('[constructor] embedder is optional - omitting it is allowed', (t) => {
  const bci = new BCIWhispercpp({ files: { model: MODEL } })
  t.is(bci._files.model, MODEL, 'model path is stored')
  t.absent(bci._files.embedder, 'embedder is left unset when omitted')
})

test('[constructor] explicit embedder path is stored', (t) => {
  const bci = new BCIWhispercpp({ files: { model: MODEL, embedder: EMBEDDER } })
  t.is(bci._files.embedder, EMBEDDER, 'embedder path is stored')
})

test('[constructor] throws when model is missing', (t) => {
  try {
    // eslint-disable-next-line no-new
    new BCIWhispercpp({ files: {} })
    t.fail('should have thrown')
  } catch (err) {
    t.is(err.code, ERR_CODES.MODEL_FILE_NOT_FOUND, 'missing model rejected')
  }
})

test('[constructor] throws when embedder is an empty string', (t) => {
  try {
    // eslint-disable-next-line no-new
    new BCIWhispercpp({ files: { model: MODEL, embedder: '' } })
    t.fail('should have thrown')
  } catch (err) {
    t.is(err.code, ERR_CODES.MODEL_FILE_NOT_FOUND, 'empty embedder rejected')
  }
})

test('[constructor] throws when embedder is not a string', (t) => {
  try {
    // eslint-disable-next-line no-new
    new BCIWhispercpp({ files: { model: MODEL, embedder: 123 } })
    t.fail('should have thrown')
  } catch (err) {
    t.is(err.code, ERR_CODES.MODEL_FILE_NOT_FOUND, 'non-string embedder rejected')
  }
})
