'use strict'

// Chatterbox multilingual integration: same engine class, but loads
// the MTL GGUFs (chatterbox-t3-mtl + chatterbox-s3gen-mtl) and
// exercises a small sweep of non-en languages.  The turbo English
// integration test lives in addon.test.js; this file is a
// language-coverage smoke that surfaces any regression in the
// multilingual variant's tokenizer / language-conditioning code paths
// (e.g. mtl_tokenizer break, run_t3 variant dispatch in tts-cpp). Japanese
// also covers the MeCab/IPAdic path because kanji needs word-level
// morphological segmentation for phonetic readings. Chinese is covered as
// an explicit unsupported-language assertion until tts-cpp enables it.

const fs = require('bare-fs')
const os = require('bare-os')
const path = require('bare-path')
const test = require('brittle')

const TTSGgml = require('@qvac/tts-ggml')
const { runTTS } = require('../utils/runTTS')
const { resolveRefWavPath } = require('../utils/runChatterboxTTS')
const { ensureChatterboxMtlModels, ensureMecabDict } = require('../utils/downloadModel')
const { recordTtsStats } = require('../utils/perf-helper')

const platform = os.platform()
const isMobile = platform === 'ios' || platform === 'android'

// Language coverage test, not a GPU policy test: rely on the package
// default (`useGPU: false`) rather than opting into GPU here.
// Tests that *are* about GPU live in gpu-smoke.test.js.

function getBaseDir () {
  return isMobile && global.testDir ? global.testDir : '.'
}

const SAMPLE_RATE = 24000

const MTL_SENTENCES = [
  { lang: 'es', text: 'El zorro marrón salta sobre el perro perezoso.' },
  { lang: 'fr', text: 'Le renard brun saute par-dessus le chien paresseux.' },
  { lang: 'de', text: 'Der braune Fuchs springt über den faulen Hund.' },
  { lang: 'pt', text: 'A raposa marrom pula sobre o cachorro preguiçoso.' },
  { lang: 'it', text: 'La rapida volpe marrone salta sopra il cane pigro.' }
]

const JA_SENTENCE = '今日はいい天気ですね。'
const ZH_SENTENCE = '敏捷的棕色狐狸跳过懒狗。'

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
      s3genModel: params.s3genModelPath,
      ...(params.mecabDictDir ? { mecabDictDir: params.mecabDictDir } : {})
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

test('Chatterbox MTL TTS (ggml): synthesizes across es/fr/de/pt/it with shared engine', { timeout: 1800000 }, async (t) => {
  const baseDir = getBaseDir()
  const download = await ensureChatterboxMtlModels({ targetDir: path.join(baseDir, 'models') })
  if (!download.success) {
    t.fail('Chatterbox MTL GGUFs not available - registry fetch failed. Run `npm run download-models:registry` or stage models locally.')
    return
  }

  const model = await loadChatterboxMtlTTS({
    modelDir: download.targetDir,
    t3ModelPath: path.join(download.targetDir, 'chatterbox-t3-mtl.gguf'),
    s3genModelPath: path.join(download.targetDir, 'chatterbox-s3gen-mtl.gguf'),
    language: MTL_SENTENCES[0].lang
  })
  try {
    for (let i = 0; i < MTL_SENTENCES.length; i++) {
      const { lang, text } = MTL_SENTENCES[i]
      console.log(`  [${lang}] "${text.slice(0, 50)}..."`)
      if (i > 0) {
        await model.reload({ language: lang })
      }
      const t0 = Date.now()
      const result = await runTTS(
        model,
        { text },
        { minSamples: 5000, maxSamples: 5000000, minDurationMs: 200, maxDurationMs: 300000 },
        { sampleRate: SAMPLE_RATE, engineTag: 'Chatterbox MTL' }
      )
      const wallMs = Date.now() - t0
      console.log('    ' + result.output)

      t.ok(result.passed, `MTL ${lang} run passes expectations`)
      t.ok(result.data.sampleCount > 0, `MTL ${lang} produced audio`)
      t.is(result.data.reportedSampleRate || SAMPLE_RATE, SAMPLE_RATE, `MTL ${lang} reports 24 kHz`)

      const st = result.data?.stats || {}
      t.comment(recordTtsStats(
        `chatterbox mtl ${lang}`,
        { realTimeFactor: st.realTimeFactor, audioDurationMs: st.audioDurationMs || result.data?.durationMs, totalSamples: st.totalSamples, backendDevice: st.backendDevice },
        { wallMs, sampleCount: result.data?.sampleCount, model: 'chatterbox-mtl', output: text }
      ))
    }
  } finally {
    try { await model.unload() } catch (_e) {}
  }
})

test('Chatterbox MTL TTS (ggml): synthesizes Japanese with MeCab dictionary', { timeout: 1800000 }, async (t) => {
  const baseDir = getBaseDir()
  const download = await ensureChatterboxMtlModels({ targetDir: path.join(baseDir, 'models') })
  if (!download.success) {
    t.fail('Chatterbox MTL GGUFs not available - registry fetch failed. Run `npm run download-models:registry` or stage models locally.')
    return
  }

  const mecab = await ensureMecabDict({ targetDir: path.join(baseDir, 'models', 'mecab-ipadic') })
  if (!mecab.success) {
    t.pass('Skipped: MeCab/IPAdic dictionary not available')
    return
  }

  const model = await loadChatterboxMtlTTS({
    modelDir: download.targetDir,
    t3ModelPath: path.join(download.targetDir, 'chatterbox-t3-mtl.gguf'),
    s3genModelPath: path.join(download.targetDir, 'chatterbox-s3gen-mtl.gguf'),
    mecabDictDir: mecab.dir,
    language: 'ja'
  })
  try {
    const t0 = Date.now()
    const result = await runTTS(
      model,
      { text: JA_SENTENCE },
      { minSamples: 5000, maxSamples: 5000000, minDurationMs: 200, maxDurationMs: 300000 },
      { sampleRate: SAMPLE_RATE, engineTag: 'Chatterbox MTL JA' }
    )
    const wallMs = Date.now() - t0
    console.log('    ' + result.output)

    t.ok(result.passed, 'MTL ja run passes expectations')
    t.ok(result.data.sampleCount > 0, 'MTL ja produced audio')
    t.is(result.data.reportedSampleRate || SAMPLE_RATE, SAMPLE_RATE, 'MTL ja reports 24 kHz')

    const st = result.data?.stats || {}
    t.comment(recordTtsStats(
      'chatterbox mtl ja',
      { realTimeFactor: st.realTimeFactor, audioDurationMs: st.audioDurationMs || result.data?.durationMs, totalSamples: st.totalSamples, backendDevice: st.backendDevice },
      { wallMs, sampleCount: result.data?.sampleCount, model: 'chatterbox-mtl', output: JA_SENTENCE }
    ))
  } finally {
    try { await model.unload() } catch (_e) {}
  }
})

test('Chatterbox MTL TTS (ggml): rejects zh while tokenizer support is disabled', { timeout: 600000 }, async (t) => {
  const baseDir = getBaseDir()
  const download = await ensureChatterboxMtlModels({ targetDir: path.join(baseDir, 'models') })
  if (!download.success) {
    t.fail('Chatterbox MTL GGUFs not available - registry fetch failed. Run `npm run download-models:registry` or stage models locally.')
    return
  }

  let model = null
  let error = null
  try {
    model = await loadChatterboxMtlTTS({
      modelDir: download.targetDir,
      t3ModelPath: path.join(download.targetDir, 'chatterbox-t3-mtl.gguf'),
      s3genModelPath: path.join(download.targetDir, 'chatterbox-s3gen-mtl.gguf'),
      language: 'zh'
    })
    await runTTS(model, { text: ZH_SENTENCE })
  } catch (err) {
    error = err
  } finally {
    if (model) {
      try { await model.unload() } catch (_e) {}
    }
  }

  const message = String(error?.cause?.message || error?.message || '')
  t.ok(error, 'MTL zh is rejected by the current tokenizer')
  t.ok(message.includes("language 'zh' not in the multilingual tokenizer's tier-1 set"), 'MTL zh rejection explains tokenizer support')
})

test('Chatterbox MTL TTS (ggml): backendDevice + backendId surfaced in stats', { timeout: 600000 }, async (t) => {
  const baseDir = getBaseDir()
  const download = await ensureChatterboxMtlModels({ targetDir: path.join(baseDir, 'models') })
  if (!download.success) {
    t.fail('Chatterbox MTL GGUFs not available - registry fetch failed. Run `npm run download-models:registry` or stage models locally.')
    return
  }

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
