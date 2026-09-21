'use strict'

const test = require('brittle')
const LlmLlamacpp = require('../../index.js')

function construct(parallel) {
  const config = { device: 'cpu' }
  if (parallel !== undefined) config.parallel = parallel
  return new LlmLlamacpp({
    files: { model: ['/tmp/test.gguf'] },
    config,
    opts: {},
    logger: { info() {}, warn() {}, error() {}, debug() {} }
  })
}

test('constructor rejects malformed or out-of-range parallel values', (t) => {
  const invalid = [
    ['-1', 'negative string'],
    ['2.5', 'fractional string'],
    ['2workers', 'trailing text'],
    [0, 'zero number'],
    ['0', 'zero string'],
    [2 ** 53, 'unsafe integer'],
    [4294967296, 'unsigned 32-bit overflow'],
    [2000, 'far above the sequence ceiling'],
    // The engine rejects n_seq_max > LLAMA_MAX_SEQ (256), so anything above it
    // could only ever spawn its thread pool and then fail the model load.
    [257, 'one above the 256 sequence ceiling']
  ]

  for (const [value, label] of invalid) {
    let err = null
    try {
      construct(value)
    } catch (caught) {
      err = caught
    }
    t.ok(
      err instanceof TypeError && /parallel must be an integer between 1 and 256/.test(err.message),
      `parallel=${JSON.stringify(value)} (${label}) must throw the validation TypeError`
    )
  }
})

test('constructor accepts valid parallel values and defaults to 1 when absent', (t) => {
  const asString = construct('4')
  t.is(asString._maxConcurrency, 4, "parallel: '4' must yield _maxConcurrency 4")

  const asNumber = construct(4)
  t.is(asNumber._maxConcurrency, 4, 'parallel: 4 must yield _maxConcurrency 4')

  const atCeiling = construct(256)
  t.is(atCeiling._maxConcurrency, 256, 'parallel: 256 (the engine ceiling) must be accepted')

  const absent = construct(undefined)
  t.is(absent._maxConcurrency, 1, 'absent parallel must default _maxConcurrency to 1')
})
