'use strict'

const test = require('brittle')
const process = require('bare-process')
const { resolveEngineSetup } = require('../../lib/setup.js')
const {
  assertChunkStreamingSupport,
  assertDenoiserBatchOnly,
  assertSentenceStreamingAllowed,
  requestsChunkStreaming
} = require('../../lib/streamingSupport.js')

global.process = process

const FILES = {
  chatterbox: { t3Model: './models/t3.gguf', s3genModel: './models/s3.gguf' },
  supertonic: { supertonicModel: './models/supertonic.gguf' },
  audio8: { audio8Lm: './models/lm.gguf', audio8CodecDecoder: './models/dec.gguf' },
  moss: { mossBackbone: './models/moss-tts-delay-f16.gguf', mossCodecDecoder: './models/dec.gguf' },
  'moss-sfx': { mossSoundEffect: './models/moss-sfx-v2-f16.gguf' },
  'moss-speech': {
    mossSpeechModel: './models/moss-speech-f16.gguf',
    mossSpeechCodec: './models/codec.gguf'
  }
}

// A valid setup first; the checks are then exercised on edited settings so each
// rule is hit in isolation rather than through the constructor's full chain.
function setupFor(engine) {
  return resolveEngineSetup({ engine, files: FILES[engine] })
}

test('streaming support: chunk streaming is refused where the engine cannot do it', (t) => {
  const supertonic = setupFor('supertonic')
  supertonic.settings.streamChunkTokens = 50
  supertonic.backend.enhancerGgufPath = '/e.gguf'
  t.exception(() => assertChunkStreamingSupport(supertonic), /supertonic native chunk streaming/)
  supertonic.backend.enhancerGgufPath = undefined
  t.execution(() => assertChunkStreamingSupport(supertonic), 'without LavaSR it streams')

  const audio8 = setupFor('audio8')
  audio8.settings.streamFirstChunkTokens = 10
  t.exception(() => assertChunkStreamingSupport(audio8), /not supported by the audio8 engine/)

  const sfx = setupFor('moss-sfx')
  sfx.settings.streamChunkTokens = 10
  t.exception(() => assertChunkStreamingSupport(sfx), /not supported by the moss-sfx engine/)

  const moss = setupFor('moss')
  moss.settings.streamFirstChunkTokens = 5
  t.exception(() => assertChunkStreamingSupport(moss), /streams fixed-size chunks/)
  moss.settings.streamFirstChunkTokens = undefined
  moss.settings.streamChunkTokens = 25
  t.execution(() => assertChunkStreamingSupport(moss), 'streamChunkTokens alone is fine')
})

test('streaming support: the denoiser is batch-only, and streamChunkTokens 0 means batch', (t) => {
  const chatterbox = setupFor('chatterbox')
  chatterbox.backend.denoiserGgufPath = '/d.gguf'
  chatterbox.settings.streamChunkTokens = 0
  t.absent(requestsChunkStreaming(chatterbox.settings))
  t.execution(() => assertDenoiserBatchOnly(chatterbox))
  chatterbox.settings.streamChunkTokens = 25
  t.ok(requestsChunkStreaming(chatterbox.settings))
  t.exception(
    () => assertDenoiserBatchOnly(chatterbox),
    /denoiser is not yet supported with native chunk streaming/
  )
})

test('streaming support: sentence streaming is refused for moss-speech, moss-sfx and MOSS dialogue', (t) => {
  t.exception(
    () => assertSentenceStreamingAllowed(setupFor('moss-speech'), 'runStreaming'),
    /runStreaming: the moss-speech engine/
  )
  t.exception(
    () => assertSentenceStreamingAllowed(setupFor('moss-sfx'), 'run with streamOutput'),
    /run with streamOutput: the moss-sfx engine/
  )
  const dialogue = setupFor('moss')
  dialogue.settings.dialogueReferences = ['/s1.wav']
  t.exception(
    () => assertSentenceStreamingAllowed(dialogue, 'runStream'),
    /MOSS dialogue cannot be split/
  )
  t.execution(() => assertSentenceStreamingAllowed(setupFor('chatterbox'), 'runStream'))
})
