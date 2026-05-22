'use strict'

// Chatterbox multilingual integration: same engine class, but loads
// the MTL GGUFs (chatterbox-t3-mtl + chatterbox-s3gen-mtl) and
// exercises a small sweep of non-en languages.  The turbo English
// integration test lives in addon.test.js; this file is a
// language-coverage smoke that surfaces any regression in the
// multilingual variant's tokenizer / language-conditioning code paths
// (e.g. mtl_tokenizer break, run_t3 variant dispatch in tts-cpp).

const fs = require('bare-fs')
const os = require('bare-os')
const path = require('bare-path')
const test = require('brittle')

const TTSGgml = require('@qvac/tts-ggml')
const { runTTS } = require('../utils/runTTS')
const { resolveRefWavPath } = require('../utils/runChatterboxTTS')
const { ensureChatterboxMtlModels } = require('../utils/downloadModel')

const platform = os.platform()
const isMobile = platform === 'ios' || platform === 'android'

// Language coverage test, not a GPU policy test: rely on the package
// default (`useGPU: false`) and the Android C++-side override in
// ChatterboxModel::loadLocked rather than opting into GPU here.
// Tests that *are* about GPU live in gpu-smoke.test.js.

function getBaseDir () {
  return isMobile && global.testDir ? global.testDir : '.'
}

const SAMPLE_RATE = 24000

const MTL_SENTENCES = [
  { lang: 'es', text: 'El zorro marrón salta sobre el perro perezoso.' },
  { lang: 'fr', text: 'Le renard brun saute par-dessus le chien paresseux.' },
  { lang: 'de', text: 'Der braune Fuchs springt über den faulen Hund.' },
  { lang: 'pt', text: 'A raposa marrom pula sobre o cachorro preguiçoso.' }
]

async function loadChatterboxMtlTTS (params) {
  // Route through `resolveRefWavPath` so the mobile-asset path (staged
  // into `Library/Caches/jfk.wav` via `global.assetPaths`) is preferred
  // over the in-bundle `test/reference-audio/jfk.wav`; the bundled
  // path is not readable from native code on iOS, which previously
  // tripped `ChatterboxModel::validateConfig` with `ModelFileNotFound`
  // the moment `model.load()` reached the C++ constructor.
  const refWavPath = resolveRefWavPath(params)
  if (!fs.existsSync(refWavPath)) {
    throw new Error('[Chatterbox MTL] reference audio not found at ' + refWavPath)
  }

  const model = new TTSGgml({
    files: {
      modelDir: params.modelDir,
      t3Model: params.t3ModelPath,
      s3genModel: params.s3genModelPath
    },
    referenceAudio: refWavPath,
    config: {
      language: params.language || 'en',
      ...(params.useGPU !== undefined ? { useGPU: params.useGPU } : {})
    },
    opts: { stats: true }
  })
  await model.load()
  return model
}

test('Chatterbox MTL TTS (ggml): synthesizes across es/fr/de/pt with shared engine', { timeout: 1800000 }, async (t) => {
  const baseDir = getBaseDir()
  const download = await ensureChatterboxMtlModels({ targetDir: path.join(baseDir, 'models') })

  const model = await loadChatterboxMtlTTS({
    modelDir: download.targetDir,
    language: MTL_SENTENCES[0].lang
  })
  try {
    for (let i = 0; i < MTL_SENTENCES.length; i++) {
      const { lang, text } = MTL_SENTENCES[i]
      console.log(`  [${lang}] "${text.slice(0, 50)}..."`)
      if (i > 0) {
        await model.reload({ language: lang })
      }
      const result = await runTTS(
        model,
        { text },
        { minSamples: 5000, maxSamples: 5000000, minDurationMs: 200, maxDurationMs: 300000 },
        { sampleRate: SAMPLE_RATE, engineTag: 'Chatterbox MTL' }
      )
      console.log('    ' + result.output)

      t.ok(result.passed, `MTL ${lang} run passes expectations`)
      t.ok(result.data.sampleCount > 0, `MTL ${lang} produced audio`)
      t.is(result.data.reportedSampleRate || SAMPLE_RATE, SAMPLE_RATE, `MTL ${lang} reports 24 kHz`)
    }
  } finally {
    try { await model.unload() } catch (_e) {}
  }
})

test('Chatterbox MTL TTS (ggml): backendDevice + backendId surfaced in stats', { timeout: 600000 }, async (t) => {
  const baseDir = getBaseDir()
  const download = await ensureChatterboxMtlModels({ targetDir: path.join(baseDir, 'models') })

  const model = await loadChatterboxMtlTTS({
    modelDir: download.targetDir,
    language: 'es'
  })
  try {
    const result = await runTTS(
      model,
      { text: 'Comprobando los datos de telemetría del backend.' },
      { minSamples: 5000 },
      { sampleRate: SAMPLE_RATE, engineTag: 'Chatterbox MTL' }
    )
    t.ok(result.passed, 'MTL run for backend telemetry passes')
    if (result.data.stats) {
      t.ok(typeof result.data.stats.backendDevice === 'number', 'backendDevice surfaced in stats')
      t.ok(typeof result.data.stats.backendId === 'number', 'backendId surfaced in stats')
    } else {
      t.fail('expected stats from MTL run')
    }
  } finally {
    try { await model.unload() } catch (_e) {}
  }
})
