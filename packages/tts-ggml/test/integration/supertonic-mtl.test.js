'use strict'

// Supertonic multilingual integration: same engine class as
// supertonic.test.js but exercises a small sweep of non-en languages
// against the real ggml backend.  Surfaces regressions in the MTL
// language-conditioning path (supertonic_preprocess.cpp's
// language_wrap_mode + is_supported_language gate).

const os = require('bare-os')
const path = require('bare-path')
const test = require('brittle')

const TTSGgml = require('@qvac/tts-ggml')
const { runSupertonicTTS } = require('../utils/runSupertonicTTS')
const { ensureSupertonicMtlModel } = require('../utils/downloadModel')
const { recordTtsStats } = require('../utils/perf-helper')

const platform = os.platform()
const isMobile = platform === 'ios' || platform === 'android'

function getBaseDir () {
  return isMobile && global.testDir ? global.testDir : '.'
}

const SAMPLE_RATE = 44100

const MTL_SENTENCES = [
  { lang: 'es', text: 'El zorro marrón salta sobre el perro perezoso.' },
  { lang: 'fr', text: 'Le renard brun saute par-dessus le chien paresseux.' },
  { lang: 'pt', text: 'A raposa marrom pula sobre o cachorro preguiçoso.' }
]

async function loadSupertonicMtlTTS (params) {
  const model = new TTSGgml({
    engine: TTSGgml.ENGINE_SUPERTONIC,
    files: { supertonicModel: params.supertonicModelPath },
    voice: params.voice || 'F1',
    config: { language: params.language || 'en', useGPU: false },
    opts: { stats: true }
  })
  await model.load()
  return model
}

test('Supertonic MTL TTS (ggml): synthesizes across es/fr/pt with shared engine', { timeout: 1800000 }, async (t) => {
  const baseDir = getBaseDir()
  const download = await ensureSupertonicMtlModel({ targetDir: path.join(baseDir, 'models') })
  if (!download.success) {
    t.fail('Supertonic MTL GGUF not available - registry fetch failed. Run `npm run download-models:registry` or stage models locally.')
    return
  }

  const model = await loadSupertonicMtlTTS({
    supertonicModelPath: download.path,
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
      const result = await runSupertonicTTS(
        model,
        { text },
        { minSamples: 5000, maxSamples: 5000000, minDurationMs: 200, maxDurationMs: 300000 }
      )
      const wallMs = Date.now() - t0
      console.log('    ' + result.output)

      t.ok(result.passed, `Supertonic MTL ${lang} run passes expectations`)
      t.ok(result.data.sampleCount > 0, `Supertonic MTL ${lang} produced audio`)
      t.is(result.data.reportedSampleRate || SAMPLE_RATE, SAMPLE_RATE, `Supertonic MTL ${lang} reports 44.1 kHz`)

      const st = result.data?.stats || {}
      t.comment(recordTtsStats(
        `supertonic mtl ${lang}`,
        { realTimeFactor: st.realTimeFactor, audioDurationMs: st.audioDurationMs || result.data?.durationMs, totalSamples: st.totalSamples, backendDevice: st.backendDevice },
        { wallMs, sampleCount: result.data?.sampleCount, model: 'supertonic-mtl', output: text }
      ))
    }
  } finally {
    try { await model.unload() } catch (_e) {}
  }
})

test('Supertonic MTL TTS (ggml): unsupported language fails fast at engine load', { timeout: 600000 }, async (t) => {
  const baseDir = getBaseDir()
  const download = await ensureSupertonicMtlModel({ targetDir: path.join(baseDir, 'models') })
  if (!download.success) {
    t.fail('Supertonic MTL GGUF not available - registry fetch failed. Run `npm run download-models:registry` or stage models locally.')
    return
  }

  // 'de' is in Chatterbox MTL's tier-1 set but NOT in Supertonic's
  // (which only handles en/ko/es/pt/fr today; see
  // supertonic_preprocess.cpp::is_supported_language).  The native
  // engine should reject the run with a clear "invalid Supertonic
  // language" error rather than silently producing garbage.
  const model = await loadSupertonicMtlTTS({
    supertonicModelPath: download.path,
    language: 'de'
  })
  try {
    let failed = false
    let message = ''
    try {
      const response = await model.run({
        type: 'text',
        input: 'Der braune Fuchs springt über den faulen Hund.'
      })
      await response.await()
    } catch (e) {
      failed = true
      message = String(e && e.message)
    }
    t.ok(failed, 'unsupported language should reject the synthesis call')
    t.ok(/language|Supertonic/i.test(message),
      `error mentions language / Supertonic (got: ${message})`)
  } finally {
    try { await model.unload() } catch (_e) {}
  }
})

test('Supertonic MTL TTS (ggml): backendDevice + backendId surfaced in stats', { timeout: 600000 }, async (t) => {
  const baseDir = getBaseDir()
  const download = await ensureSupertonicMtlModel({ targetDir: path.join(baseDir, 'models') })
  if (!download.success) {
    t.fail('Supertonic MTL GGUF not available - registry fetch failed. Run `npm run download-models:registry` or stage models locally.')
    return
  }

  const model = await loadSupertonicMtlTTS({
    supertonicModelPath: download.path,
    language: 'es'
  })
  try {
    const result = await runSupertonicTTS(
      model,
      { text: 'Comprobando los datos de telemetría del backend.' },
      { minSamples: 5000 }
    )
    t.ok(result.passed, 'MTL run for backend telemetry passes')
    if (result.data.stats) {
      t.ok(typeof result.data.stats.backendDevice === 'number', 'backendDevice surfaced in stats')
      t.ok(typeof result.data.stats.backendId === 'number', 'backendId surfaced in stats')
    } else {
      t.fail('expected stats from Supertonic MTL run')
    }
  } finally {
    try { await model.unload() } catch (_e) {}
  }
})
