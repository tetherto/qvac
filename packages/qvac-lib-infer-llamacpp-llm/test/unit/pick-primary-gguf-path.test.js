'use strict'

const test = require('brittle')
const { pickPrimaryGgufPath } = require('../../index.js')

test('single non-sharded file returns that file', function (t) {
  const files = ['/models/Qwen3-1.7B-Q4_0.gguf']
  t.is(pickPrimaryGgufPath(files), '/models/Qwen3-1.7B-Q4_0.gguf')
})

test('sharded model with tensors.txt first returns first shard, not tensors.txt', function (t) {
  const files = [
    '/models/medgemma-4b-it-Q4_1.tensors.txt',
    '/models/medgemma-4b-it-Q4_1-00001-of-00005.gguf',
    '/models/medgemma-4b-it-Q4_1-00002-of-00005.gguf',
    '/models/medgemma-4b-it-Q4_1-00003-of-00005.gguf',
    '/models/medgemma-4b-it-Q4_1-00004-of-00005.gguf',
    '/models/medgemma-4b-it-Q4_1-00005-of-00005.gguf'
  ]
  t.is(pickPrimaryGgufPath(files), '/models/medgemma-4b-it-Q4_1-00001-of-00005.gguf')
})

test('sharded model without tensors.txt returns first shard', function (t) {
  const files = [
    '/models/Qwen3-0.6B-UD-IQ1_S-00001-of-00003.gguf',
    '/models/Qwen3-0.6B-UD-IQ1_S-00002-of-00003.gguf',
    '/models/Qwen3-0.6B-UD-IQ1_S-00003-of-00003.gguf'
  ]
  t.is(pickPrimaryGgufPath(files), '/models/Qwen3-0.6B-UD-IQ1_S-00001-of-00003.gguf')
})

test('non-gguf file falls back to first entry', function (t) {
  const files = ['/models/some-model.bin']
  t.is(pickPrimaryGgufPath(files), '/models/some-model.bin')
})
