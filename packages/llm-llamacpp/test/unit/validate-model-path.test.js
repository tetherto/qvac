'use strict'

const test = require('brittle')
const { validateModelPath } = require('../../index.js')

test('single non-sharded file returns that file', function (t) {
  const files = ['/models/Qwen3-1.7B-Q4_0.gguf']
  t.is(validateModelPath(files), '/models/Qwen3-1.7B-Q4_0.gguf')
})

test('removed streaming list with tensors.txt is rejected', async function (t) {
  const files = [
    '/models/Qwen3-4B-Q4_K_M.tensors.txt',
    '/models/Qwen3-4B-Q4_K_M-00001-of-00005.gguf',
    '/models/Qwen3-4B-Q4_K_M-00002-of-00005.gguf',
    '/models/Qwen3-4B-Q4_K_M-00003-of-00005.gguf',
    '/models/Qwen3-4B-Q4_K_M-00004-of-00005.gguf',
    '/models/Qwen3-4B-Q4_K_M-00005-of-00005.gguf'
  ]
  await t.exception.all(() => validateModelPath(files), /Weight streaming is no longer supported/)
})

test('removed streaming list without tensors.txt is rejected', async function (t) {
  const files = [
    '/models/Qwen3-0.6B-UD-IQ1_S-00001-of-00003.gguf',
    '/models/Qwen3-0.6B-UD-IQ1_S-00002-of-00003.gguf',
    '/models/Qwen3-0.6B-UD-IQ1_S-00003-of-00003.gguf'
  ]
  await t.exception.all(() => validateModelPath(files), /Weight streaming is no longer supported/)
})

test('a single disk path does not require a gguf extension', function (t) {
  const files = ['/models/some-model.bin']
  t.is(validateModelPath(files), '/models/some-model.bin')
})

test('first disk shard alone is accepted', function (t) {
  const first = '/models/model-00001-of-00003.gguf'
  t.is(validateModelPath([first]), first)
})

test('weight buffers are rejected as model paths', async function (t) {
  await t.exception.all(
    () => validateModelPath([new Uint8Array(8)]),
    /weight buffers are not supported/
  )
})
