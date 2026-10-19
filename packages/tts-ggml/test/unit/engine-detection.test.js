'use strict'

const test = require('brittle')
const path = require('bare-path')
const fs = require('bare-fs')
const os = require('bare-os')
const process = require('bare-process')
const { detectEngineType, resolveModelPaths } = require('../../lib/engineDetection.js')
const { normalizeGgmlFiles } = require('../../lib/modelFiles.js')
const ids = require('../../lib/engineIds.js')

global.process = process

function withTempDir(name, body) {
  const root = path.join(
    os.tmpdir(),
    `${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  )
  fs.mkdirSync(root, { recursive: true })
  try {
    return body(root)
  } finally {
    try {
      fs.rmSync(root, { recursive: true, force: true })
    } catch (_e) {}
  }
}

function touch(root, ...names) {
  for (const name of names) fs.writeFileSync(path.join(root, name), name)
}

function detect(files) {
  return detectEngineType(undefined, normalizeGgmlFiles(files))
}

test('engine detection: an explicit engine option wins over every file hint', (t) => {
  t.is(
    detectEngineType(ids.ENGINE_SUPERTONIC, normalizeGgmlFiles({ t3Model: '/m/t3.gguf' })),
    ids.ENGINE_SUPERTONIC
  )
  for (const engine of ids.ENGINE_TYPES) {
    t.is(detectEngineType(engine, {}), engine, `${engine} passes through`)
  }
  t.exception(
    () => detectEngineType('kokoro', {}),
    /'engine' option must be 'chatterbox', 'supertonic', 'cosyvoice3', 'parler', 'audio8', 'moss', 'moss-sfx', 'moss-speech' or 'pocket' \(got 'kokoro'\)/
  )
})

test('engine detection: explicit file keys are ranked, and nothing at all means chatterbox', (t) => {
  const ranked = [
    [ids.ENGINE_POCKET, { pocketFlowModel: '/m/flow-lm.gguf' }],
    [ids.ENGINE_COSYVOICE3, { cosyvoiceModelDir: '/m/cosy' }],
    [ids.ENGINE_CHATTERBOX, { s3genModel: '/m/s3.gguf' }],
    [ids.ENGINE_SUPERTONIC, { supertonicModel: '/m/st.gguf' }],
    [ids.ENGINE_PARLER, { parlerModel: '/m/parler.gguf' }],
    [ids.ENGINE_AUDIO8, { audio8CodecDecoder: '/m/a8-dec.gguf' }],
    [ids.ENGINE_MOSS, { mossCodecDecoder: '/m/moss-dec.gguf' }],
    [ids.ENGINE_MOSS_SFX, { mossSoundEffect: '/m/sfx.gguf' }],
    [ids.ENGINE_MOSS_SPEECH, { mossSpeechCodec: '/m/speech-codec.gguf' }]
  ]
  // Each entry wins against every key ranked below it.
  for (let i = 0; i < ranked.length; i++) {
    const files = Object.assign({}, ...ranked.slice(i).map(([, keys]) => keys))
    t.is(detect(files), ranked[i][0], `${ranked[i][0]} outranks the lower keys`)
  }
  t.is(detect({}), ids.ENGINE_CHATTERBOX, 'no files at all defaults to chatterbox')
  t.is(detect({ modelDir: '/does/not/exist' }), ids.ENGINE_CHATTERBOX, 'an unreadable dir too')
})

test('engine detection: a shared modelDir is sniffed in a fixed order', (t) => {
  withTempDir('tts-ggml-detect', (root) => {
    const files = { modelDir: root }
    t.is(detect(files), ids.ENGINE_CHATTERBOX, 'an empty directory defaults to chatterbox')
    const expectations = [
      ['flow-lm.gguf', ids.ENGINE_POCKET],
      ['moss-speech-q8_0.gguf', ids.ENGINE_MOSS_SPEECH],
      ['moss-sfx-v2-q8_0.gguf', ids.ENGINE_MOSS_SFX],
      ['moss-ttsd-f16.gguf', ids.ENGINE_MOSS],
      ['audio8-lm-q8_0.gguf', ids.ENGINE_AUDIO8],
      ['parler-mini-v1-q8_0.gguf', ids.ENGINE_PARLER],
      ['supertonic3-f16.gguf', ids.ENGINE_SUPERTONIC],
      ['chatterbox-t3-mtl.gguf', ids.ENGINE_CHATTERBOX],
      ['cosyvoice3-llm-q8_0.gguf', ids.ENGINE_COSYVOICE3]
    ]
    // Adding a higher-ranked file flips the detection each time.
    for (const [name, engine] of expectations) {
      touch(root, name)
      t.is(detect(files), engine, `${name} selects ${engine}`)
    }
  })
})

test('engine detection: explicit paths win over modelDir discovery, per engine', (t) => {
  withTempDir('tts-ggml-paths', (root) => {
    touch(
      root,
      'chatterbox-t3-mtl.gguf',
      'chatterbox-s3gen-mtl.gguf',
      'supertonic.gguf',
      'parler-mini-v1-q8_0.gguf',
      'audio8-lm-q8_0.gguf',
      'audio8-codec-decoder-q8_0.gguf',
      'moss-tts-delay-f16.gguf',
      'moss-ttsd-f16.gguf',
      'moss-codec-decoder-f16.gguf'
    )
    const files = normalizeGgmlFiles({
      modelDir: root,
      t3Model: '/x/t3.gguf',
      mecabDictDir: '/dict'
    })
    const opts = { dialogue: false }

    const chatterbox = resolveModelPaths(ids.ENGINE_CHATTERBOX, files, opts)
    t.is(chatterbox.t3ModelPath, '/x/t3.gguf', 'an explicit T3 wins')
    t.is(
      chatterbox.s3genModelPath,
      path.join(root, 'chatterbox-s3gen-mtl.gguf'),
      'the multilingual S3Gen pairs with the multilingual T3 found in the dir'
    )
    t.is(chatterbox.mecabDictPath, '/dict', 'files.mecabDictDir reaches the paths')
    t.is(
      resolveModelPaths(ids.ENGINE_CHATTERBOX, files, { ...opts, mecabDictPath: '/opt-dict' })
        .mecabDictPath,
      '/opt-dict',
      'the option alias wins over the files alias'
    )
    t.is(
      resolveModelPaths(ids.ENGINE_SUPERTONIC, files, opts).supertonicModelPath,
      path.join(root, 'supertonic.gguf')
    )
    t.is(
      resolveModelPaths(ids.ENGINE_PARLER, files, opts).parlerModelPath,
      path.join(root, 'parler-mini-v1-q8_0.gguf')
    )
    const audio8 = resolveModelPaths(ids.ENGINE_AUDIO8, files, opts)
    t.is(audio8.audio8LmPath, path.join(root, 'audio8-lm-q8_0.gguf'))
    t.absent(audio8.audio8CodecEncoderPath, 'a missing encoder stays unset')
    t.is(
      resolveModelPaths(ids.ENGINE_MOSS, files, opts).mossBackbonePath,
      path.join(root, 'moss-tts-delay-f16.gguf'),
      'plain TTS takes the Delay backbone first'
    )
    t.is(
      resolveModelPaths(ids.ENGINE_MOSS, files, { ...opts, dialogue: true }).mossBackbonePath,
      path.join(root, 'moss-ttsd-f16.gguf'),
      'dialogue only accepts the TTSD backbone'
    )
    const pocket = resolveModelPaths(ids.ENGINE_POCKET, files, opts)
    t.absent(pocket.t3ModelPath, 'pocket resolves no engine model paths')
    t.is(pocket.mecabDictPath, '/dict', 'but keeps the shared dictionary paths')
  })
})
