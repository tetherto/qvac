'use strict'

const test = require('brittle')

const { audio8Ggufs } = require('../utils/downloadModel')

const REGISTRY_PREFIX = 'qvac_models_compiled/ggml/audio-8/2026-08-12'

test('Audio8 registry descriptors select the q8_0 runtime trio', (t) => {
  const files = audio8Ggufs()

  t.is(files.length, 3)
  t.is(files[0].name, 'audio8-lm-q8_0.gguf')
  t.is(files[0].registryPath, `${REGISTRY_PREFIX}/audio8-lm-q8_0.gguf`)
  t.is(files[1].name, 'audio8-codec-decoder-q8_0.gguf')
  t.is(files[2].name, 'audio8-codec-encoder-q8_0.gguf')
})

test('Audio8 registry descriptors can omit the cloning encoder', (t) => {
  const files = audio8Ggufs('f16', false)

  t.is(files.length, 2)
  t.is(files[0].name, 'audio8-lm-f16.gguf')
  t.is(files[1].name, 'audio8-codec-decoder-f16.gguf')
})

test('Audio8 registry descriptors reject unpublished tiers', (t) => {
  t.alike(audio8Ggufs('q4_0'), [])
})
