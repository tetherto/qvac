'use strict'

// Sequential / fresh-instance / reload stability tests for both engines.
// Mirrors transcription-parakeet/test/integration/multiple-transcriptions.test.js
// and tts-onnx's lifecycle assertions, adapted to the
// tts-ggml engine API.  These exercise:
//
//   1. N back-to-back run() calls on the SAME loaded instance
//      (catches per-call state leaks: stale _job handles, accumulating
//      cancel flags, output queue draining, etc.).
//   2. Fresh model instances per run (catches addon-side
//      destroyInstance regressions and ensures unload/load cycles are
//      idempotent at the engine layer).
//   3. reload() across runs (catches engine swap-in semantics +
//      sentence-stream context cleanup on reload).
//
// Both Chatterbox (turbo English) and Supertonic engines are exercised
// in sequence so a regression in either engine surfaces in CI.

const fs = require('bare-fs')
const os = require('bare-os')
const path = require('bare-path')
const test = require('brittle')

const { loadChatterboxTTS, runChatterboxTTS, resolveRefWavPath } = require('../utils/runChatterboxTTS')
const { loadSupertonicTTS, runSupertonicTTS } = require('../utils/runSupertonicTTS')
const {
  ensureChatterboxModels,
  ensureSupertonicModel
} = require('../utils/downloadModel')

const platform = os.platform()
const isMobile = platform === 'ios' || platform === 'android'

// Lifecycle / sequential-run test, not a GPU policy test: rely on the
// package default (`useGPU: false`) rather than opting into GPU here.
// Tests that *are* about GPU live in gpu-smoke.test.js.

function getBaseDir () {
  return isMobile && global.testDir ? global.testDir : '.'
}

const PHRASES = [
  'The quick brown fox jumps over the lazy dog.',
  'Multiple consecutive runs share one engine instance.',
  'This is the third sentence in the sequential run test.'
]

test('Chatterbox: multiple sequential runs reuse the same engine instance', { timeout: 1800000 }, async (t) => {
  const baseDir = getBaseDir()
  const download = await ensureChatterboxModels({ targetDir: path.join(baseDir, 'models') })
  if (!download.success) { t.fail('Chatterbox GGUFs not available - registry fetch failed. Run `npm run download-models:registry` or stage models locally.'); return }

  // Mobile-aware resolution: on iOS / Android the asset is staged into
  // `Library/Caches/jfk.wav` via `global.assetPaths`; on desktop falls
  // back to the in-tree `test/reference-audio/jfk.wav`. The bundled
  // path is not readable from native code on iOS, which would trip
  // `ModelFileNotFound` the moment `model.load()` reaches the C++
  // `ChatterboxModel::validateConfig` check.
  const refWavPath = resolveRefWavPath({})
  if (!fs.existsSync(refWavPath)) { t.pass('Skipped: reference audio missing'); return }

  const model = await loadChatterboxTTS({
    modelDir: download.targetDir,
    refWavPath,
    language: 'en'
  })
  try {
    const timings = []
    for (let i = 0; i < PHRASES.length; i++) {
      const t0 = Date.now()
      const result = await runChatterboxTTS(
        model,
        { text: PHRASES[i] },
        { minSamples: 5000 }
      )
      const wallMs = Date.now() - t0
      timings.push(wallMs)
      console.log(`  run ${i + 1}/${PHRASES.length}: ${result.data.sampleCount} samples (${wallMs}ms)`)

      t.ok(result.passed, `Chatterbox run ${i + 1} should pass expectations`)
      t.ok(result.data.sampleCount > 0, `Chatterbox run ${i + 1} should produce audio`)
      const stats = result.data.stats
      if (stats) {
        t.ok(typeof stats.realTimeFactor === 'number', `Chatterbox run ${i + 1} reports RTF`)
      }
    }

    const avg = timings.reduce((a, b) => a + b, 0) / timings.length
    console.log(`  avg wall-time across ${PHRASES.length} runs: ${avg.toFixed(0)}ms`)
    t.ok(timings.length === PHRASES.length, 'all sequential runs completed')
  } finally {
    try { await model.unload() } catch (_e) {}
  }
})

test('Supertonic: multiple sequential runs reuse the same engine instance', { timeout: 1800000 }, async (t) => {
  const baseDir = getBaseDir()
  const download = await ensureSupertonicModel({ targetDir: path.join(baseDir, 'models') })
  if (!download.success) { t.fail('Supertonic GGUF not available - registry fetch failed. Run `npm run download-models:registry` or stage models locally.'); return }

  const model = await loadSupertonicTTS({
    supertonicModelPath: download.path,
    voice: 'F1',
    language: 'en',
    useGPU: false
  })
  try {
    const timings = []
    for (let i = 0; i < PHRASES.length; i++) {
      const t0 = Date.now()
      const result = await runSupertonicTTS(
        model,
        { text: PHRASES[i] },
        { minSamples: 5000 }
      )
      const wallMs = Date.now() - t0
      timings.push(wallMs)
      console.log(`  run ${i + 1}/${PHRASES.length}: ${result.data.sampleCount} samples (${wallMs}ms)`)

      t.ok(result.passed, `Supertonic run ${i + 1} should pass expectations`)
      t.ok(result.data.sampleCount > 0, `Supertonic run ${i + 1} should produce audio`)
      const stats = result.data.stats
      if (stats) {
        t.ok(typeof stats.realTimeFactor === 'number', `Supertonic run ${i + 1} reports RTF`)
      }
    }

    const avg = timings.reduce((a, b) => a + b, 0) / timings.length
    console.log(`  avg wall-time across ${PHRASES.length} runs: ${avg.toFixed(0)}ms`)
    t.ok(timings.length === PHRASES.length, 'all sequential runs completed')
  } finally {
    try { await model.unload() } catch (_e) {}
  }
})

test('Chatterbox: fresh instance per run (app-restart simulation)', { timeout: 1800000 }, async (t) => {
  const baseDir = getBaseDir()
  const download = await ensureChatterboxModels({ targetDir: path.join(baseDir, 'models') })
  if (!download.success) { t.fail('Chatterbox GGUFs not available - registry fetch failed. Run `npm run download-models:registry` or stage models locally.'); return }

  // Mobile-aware resolution: on iOS / Android the asset is staged into
  // `Library/Caches/jfk.wav` via `global.assetPaths`; on desktop falls
  // back to the in-tree `test/reference-audio/jfk.wav`. The bundled
  // path is not readable from native code on iOS, which would trip
  // `ModelFileNotFound` the moment `model.load()` reaches the C++
  // `ChatterboxModel::validateConfig` check.
  const refWavPath = resolveRefWavPath({})
  if (!fs.existsSync(refWavPath)) { t.pass('Skipped: reference audio missing'); return }

  const N = 2
  const results = []
  for (let i = 0; i < N; i++) {
    const t0 = Date.now()
    const model = await loadChatterboxTTS({
      modelDir: download.targetDir,
      refWavPath,
      language: 'en'
    })
    const loadMs = Date.now() - t0
    try {
      const t1 = Date.now()
      const r = await runChatterboxTTS(model, { text: PHRASES[i % PHRASES.length] }, { minSamples: 5000 })
      const runMs = Date.now() - t1
      console.log(`  instance ${i + 1}/${N}: load=${loadMs}ms run=${runMs}ms samples=${r.data.sampleCount}`)
      results.push({ loadMs, runMs, sampleCount: r.data.sampleCount, passed: r.passed })
    } finally {
      try { await model.unload() } catch (_e) {}
    }
  }

  t.ok(results.every(r => r.passed), 'every fresh instance should pass expectations')
  t.ok(results.every(r => r.sampleCount > 0), 'every fresh instance should produce audio')
})

test('Supertonic: fresh instance per run (app-restart simulation)', { timeout: 1800000 }, async (t) => {
  const baseDir = getBaseDir()
  const download = await ensureSupertonicModel({ targetDir: path.join(baseDir, 'models') })
  if (!download.success) { t.fail('Supertonic GGUF not available - registry fetch failed. Run `npm run download-models:registry` or stage models locally.'); return }

  const N = 2
  const results = []
  for (let i = 0; i < N; i++) {
    const t0 = Date.now()
    const model = await loadSupertonicTTS({
      supertonicModelPath: download.path,
      voice: 'F1',
      language: 'en',
      useGPU: false
    })
    const loadMs = Date.now() - t0
    try {
      const t1 = Date.now()
      const r = await runSupertonicTTS(model, { text: PHRASES[i % PHRASES.length] }, { minSamples: 5000 })
      const runMs = Date.now() - t1
      console.log(`  instance ${i + 1}/${N}: load=${loadMs}ms run=${runMs}ms samples=${r.data.sampleCount}`)
      results.push({ loadMs, runMs, sampleCount: r.data.sampleCount, passed: r.passed })
    } finally {
      try { await model.unload() } catch (_e) {}
    }
  }

  t.ok(results.every(r => r.passed), 'every fresh instance should pass expectations')
  t.ok(results.every(r => r.sampleCount > 0), 'every fresh instance should produce audio')
})

test('Chatterbox: reload() between runs preserves stability', { timeout: 1800000 }, async (t) => {
  const baseDir = getBaseDir()
  const download = await ensureChatterboxModels({ targetDir: path.join(baseDir, 'models') })
  if (!download.success) { t.fail('Chatterbox GGUFs not available - registry fetch failed. Run `npm run download-models:registry` or stage models locally.'); return }

  // Mobile-aware resolution: on iOS / Android the asset is staged into
  // `Library/Caches/jfk.wav` via `global.assetPaths`; on desktop falls
  // back to the in-tree `test/reference-audio/jfk.wav`. The bundled
  // path is not readable from native code on iOS, which would trip
  // `ModelFileNotFound` the moment `model.load()` reaches the C++
  // `ChatterboxModel::validateConfig` check.
  const refWavPath = resolveRefWavPath({})
  if (!fs.existsSync(refWavPath)) { t.pass('Skipped: reference audio missing'); return }

  const model = await loadChatterboxTTS({
    modelDir: download.targetDir,
    refWavPath,
    language: 'en'
  })
  try {
    const r1 = await runChatterboxTTS(model, { text: 'First run before reload.' }, { minSamples: 5000 })
    t.ok(r1.passed, 'first run before reload should pass')

    await model.reload({ language: 'en' })
    t.pass('reload() resolved')

    const r2 = await runChatterboxTTS(model, { text: 'Second run after reload.' }, { minSamples: 5000 })
    t.ok(r2.passed, 'second run after reload should pass')
    t.ok(r2.data.sampleCount > 0, 'reloaded model produces audio')
  } finally {
    try { await model.unload() } catch (_e) {}
  }
})

test('Supertonic: reload() between runs preserves stability', { timeout: 1800000 }, async (t) => {
  const baseDir = getBaseDir()
  const download = await ensureSupertonicModel({ targetDir: path.join(baseDir, 'models') })
  if (!download.success) { t.fail('Supertonic GGUF not available - registry fetch failed. Run `npm run download-models:registry` or stage models locally.'); return }

  const model = await loadSupertonicTTS({
    supertonicModelPath: download.path,
    voice: 'F1',
    language: 'en',
    useGPU: false
  })
  try {
    const r1 = await runSupertonicTTS(model, { text: 'First supertonic run before reload.' }, { minSamples: 5000 })
    t.ok(r1.passed, 'first run before reload should pass')

    await model.reload({ language: 'en' })
    t.pass('reload() resolved')

    const r2 = await runSupertonicTTS(model, { text: 'Second supertonic run after reload.' }, { minSamples: 5000 })
    t.ok(r2.passed, 'second run after reload should pass')
    t.ok(r2.data.sampleCount > 0, 'reloaded model produces audio')
  } finally {
    try { await model.unload() } catch (_e) {}
  }
})

test('Engine swap: chatterbox -> supertonic -> chatterbox in separate instances', { timeout: 1800000 }, async (t) => {
  const baseDir = getBaseDir()
  const cb = await ensureChatterboxModels({ targetDir: path.join(baseDir, 'models') })
  const st = await ensureSupertonicModel({ targetDir: path.join(baseDir, 'models') })
  if (!cb.success || !st.success) { t.fail('Not all engines have models locally - registry fetch failed. Run `npm run download-models:registry` or stage models locally.'); return }

  // Mobile-aware resolution: on iOS / Android the asset is staged into
  // `Library/Caches/jfk.wav` via `global.assetPaths`; on desktop falls
  // back to the in-tree `test/reference-audio/jfk.wav`. The bundled
  // path is not readable from native code on iOS, which would trip
  // `ModelFileNotFound` the moment `model.load()` reaches the C++
  // `ChatterboxModel::validateConfig` check.
  const refWavPath = resolveRefWavPath({})
  if (!fs.existsSync(refWavPath)) { t.pass('Skipped: reference audio missing'); return }

  const c1 = await loadChatterboxTTS({ modelDir: cb.targetDir, refWavPath, language: 'en' })
  try {
    const r = await runChatterboxTTS(c1, { text: 'Hello from chatterbox.' }, { minSamples: 5000 })
    t.ok(r.passed, 'first chatterbox instance OK')
  } finally { try { await c1.unload() } catch (_e) {} }

  const s1 = await loadSupertonicTTS({ supertonicModelPath: st.path, voice: 'F1', language: 'en', useGPU: false })
  try {
    const r = await runSupertonicTTS(s1, { text: 'Hello from supertonic.' }, { minSamples: 5000 })
    t.ok(r.passed, 'supertonic instance OK')
  } finally { try { await s1.unload() } catch (_e) {} }

  const c2 = await loadChatterboxTTS({ modelDir: cb.targetDir, refWavPath, language: 'en' })
  try {
    const r = await runChatterboxTTS(c2, { text: 'Hello from chatterbox again.' }, { minSamples: 5000 })
    t.ok(r.passed, 'second chatterbox instance OK after supertonic swap')
  } finally { try { await c2.unload() } catch (_e) {} }
})
