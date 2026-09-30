'use strict'

const test = require('brittle')

const { toFilePaths } = require('../../file-paths.js')

const LTX_FILES = {
  model: '/models/ltx-video.gguf',
  t5Xxl: '/models/t5xxl.gguf',
  vae: '/models/ltx-vae.gguf',
  audioVae: '/models/ltx-audio-vae.gguf',
  embeddingsConnectors: '/models/ltx-connectors.gguf'
}

test('a video file set keeps its companion files', (t) => {
  const paths = toFilePaths(LTX_FILES)

  t.is(paths.audioVaePath, LTX_FILES.audioVae)
  t.is(paths.embeddingsConnectorsPath, LTX_FILES.embeddingsConnectors)
})

test('an absent companion file is an empty path', (t) => {
  const paths = toFilePaths({ model: '/models/sd.gguf' })

  t.is(paths.audioVaePath, '')
  t.is(paths.embeddingsConnectorsPath, '')
  t.is(paths.clipVisionPath, '')
})
