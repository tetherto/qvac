'use strict'

const test = require('brittle')
const { pickPrimaryGgufPath } = require('../../index.js')

test('single non-sharded file returns that file', function (t) {
  const files = ['/models/bge-small-en-v1.5-q4_0.gguf']
  t.is(pickPrimaryGgufPath(files), '/models/bge-small-en-v1.5-q4_0.gguf')
})

test('sharded model with tensors.txt first returns first shard, not tensors.txt', function (t) {
  const files = [
    '/models/big-embed.tensors.txt',
    '/models/big-embed-00001-of-00003.gguf',
    '/models/big-embed-00002-of-00003.gguf',
    '/models/big-embed-00003-of-00003.gguf'
  ]
  t.is(pickPrimaryGgufPath(files), '/models/big-embed-00001-of-00003.gguf')
})

test('sharded model without tensors.txt returns first shard', function (t) {
  const files = [
    '/models/gte-large-00001-of-00002.gguf',
    '/models/gte-large-00002-of-00002.gguf'
  ]
  t.is(pickPrimaryGgufPath(files), '/models/gte-large-00001-of-00002.gguf')
})

test('non-gguf file falls back to first entry', function (t) {
  const files = ['/models/some-model.bin']
  t.is(pickPrimaryGgufPath(files), '/models/some-model.bin')
})
