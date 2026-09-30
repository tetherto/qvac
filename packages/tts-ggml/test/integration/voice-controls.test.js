'use strict'

// Model-free: tts-cpp's conditioning vocabulary, read through the native
// binding by TTSGgml.getVoiceControls(), must agree with what the JS layer
// accepts per engine, so the JS validation tables cannot drift from the
// library they front.

const test = require('brittle')
const TTSGgml = require('../../index.js')
const { TTS_TEST_THREADS } = require('../utils/testThreads')

const ENGINE_FILES = {
  [TTSGgml.ENGINE_CHATTERBOX]: { t3Model: './t3.gguf', s3genModel: './s3gen.gguf' },
  [TTSGgml.ENGINE_SUPERTONIC]: { supertonicModel: './supertonic.gguf' },
  [TTSGgml.ENGINE_COSYVOICE3]: { cosyvoiceModelDir: './cosyvoice3' },
  [TTSGgml.ENGINE_PARLER]: { parlerModel: './parler.gguf' },
  [TTSGgml.ENGINE_AUDIO8]: { audio8Lm: './lm.gguf', audio8CodecDecoder: './decoder.gguf' }
}

function acceptedBy(engine, key, values) {
  return values.filter((value) => {
    try {
      const model = new TTSGgml({
        threads: TTS_TEST_THREADS,
        engine,
        files: ENGINE_FILES[engine],
        [key]: value
      })
      return model.getEngineType() === engine
    } catch (_err) {
      return false
    }
  })
}

test('getVoiceControls: native vocabulary matches the JS validation tables', (t) => {
  const catalog = TTSGgml.getVoiceControls()
  t.ok(catalog.emotions.length > 0, 'canonical emotions are listed')
  t.ok(catalog.paces.includes('moderate'), 'canonical paces include moderate')

  for (const engine of Object.keys(ENGINE_FILES)) {
    const native = catalog.engines[engine]
    t.ok(native, `${engine} is in the native catalog`)
    if (!native) continue
    t.alike(
      acceptedBy(engine, 'emotion', catalog.emotions),
      native.emotions,
      `${engine}: the emotions the JS layer accepts are the native subset`
    )
    t.alike(
      acceptedBy(engine, 'pace', catalog.paces),
      native.paces,
      `${engine}: the paces the JS layer accepts are the native subset`
    )
  }
})
