'use strict'

/* global Bare */

/**
 * Bergamot Pivot Translation Integration Test
 *
 * Tests English-as-pivot translation using two chained Bergamot models.
 * Example: Spanish → English → Italian (es→en + en→it)
 *
 * Platform Behavior:
 *   - Mobile (iOS/Android): GPU devices discovered at runtime, each gets its
 *     own test run with identifiable label (e.g. [GPU:0 Vulkan0])
 *   - Desktop: Tests CPU mode only (intgemm is CPU-optimized)
 *
 * Usage:
 *   bare test/integration/pivot-bergamot.test.js
 */

// See indictrans.test.js for the full rationale on why we both catch
// and then exit non-zero on `beforeExit`. tl;dr: catch to avoid the
// Samsung SIGABRT, then propagate failure so CI doesn't lie about
// passing when no translation actually ran. The `Corestore is closed`
// filter is preserved — that's a known benign tear-down race that
// shouldn't fail the run.
let _pivotBergamotUnhandledRejection = null
Bare.on('unhandledRejection', (err) => {
  if (err && err.message && err.message.includes('Corestore is closed')) return
  console.error('[pivot-bergamot] Unhandled rejection:', err)
  if (!_pivotBergamotUnhandledRejection) _pivotBergamotUnhandledRejection = err
})
Bare.on('beforeExit', () => {
  if (_pivotBergamotUnhandledRejection) {
    console.error('[pivot-bergamot] FATAL: tests had unhandled rejections, exiting with code 1')
    if (typeof Bare.exit === 'function') Bare.exit(1)
    else if (typeof process !== 'undefined' && process.exit) process.exit(1)
  }
})

const test = require('brittle')
const path = require('bare-path')
const fs = require('bare-fs')
const TranslationNmtcpp = require('@qvac/translation-nmtcpp')
const { ensureBergamotModelFiles } = require('@qvac/translation-nmtcpp/lib/bergamot-model-fetcher')
const {
  createLogger,
  createPerformanceCollector,
  formatPerformanceMetrics,
  isMobile,
  platform,
  discoverGpuDevices,
  MAX_GPU_DEVICE_PROBES
} = require('./utils')

const PIVOT_BERGAMOT_FIXTURE = path.resolve(__dirname, 'fixtures/pivot-bergamot.quality.json')

const PIVOT_TIMEOUT = isMobile ? 900_000 : 180_000

/**
 * Ensures a Bergamot model pair is available on disk.
 * Downloads directly from Firefox CDN.
 *
 * @param {string} src - source language code (e.g. 'es')
 * @param {string} dst - destination language code (e.g. 'en')
 * @returns {Promise<string>} path to model directory
 */
async function ensureModelPair (src, dst) {
  const pairKey = `${src}${dst}`
  const relativeDir = `../../model/bergamot/${pairKey}`
  const modelDir = path.resolve(__dirname, relativeDir)

  if (fs.existsSync(modelDir)) {
    const files = fs.readdirSync(modelDir)
    const hasModel = files.some(f => f.includes('.intgemm') || f.includes('.bin'))
    const hasVocab = files.some(f => f.includes('.spm'))
    if (hasModel && hasVocab) return modelDir
  }

  const writableRoot = isMobile ? (global.testDir || '/tmp') : path.resolve(__dirname, '../..')
  const destDir = path.join(writableRoot, 'model', 'bergamot', pairKey)
  // `ensureBergamotModelFiles` (not the raw `downloadBergamotFromFirefox`)
  // short-circuits when destDir is already populated — important for the
  // pivot test which calls this for the same language pair across four
  // sub-tests (GPU/CPU × es→en→it and fr→en→es × 2 variants each). Without
  // the short-circuit the test re-fetches every pair from Firefox CDN and
  // blows through the 20-min per-test WDIO timeout on slow Device Farm
  // lanes (root cause of the Samsung Galaxy S25 Ultra timeout in CI
  // run 24796639547).
  return ensureBergamotModelFiles(src, dst, destDir)
}

/**
 * Finds the model binary and vocab file inside a Bergamot model directory.
 *
 * @param {string} modelDir - path to model directory
 * @returns {{ modelFile: string, vocabFile: string }}
 */
function findModelFiles (modelDir) {
  const files = fs.readdirSync(modelDir)
  const modelFile = files.find(f => f.includes('.intgemm') && f.includes('.bin'))
  const vocabFile = files.find(f => f.includes('.spm'))
  return { modelFile, vocabFile }
}

/**
 * Creates pivot translation constructor args from model directories.
 */
function createPivotArgs (primaryDir, primaryFiles, pivotDir, pivotFiles, opts = {}) {
  return {
    files: {
      model: path.join(primaryDir, primaryFiles.modelFile),
      srcVocab: path.join(primaryDir, primaryFiles.vocabFile),
      dstVocab: path.join(primaryDir, primaryFiles.vocabFile),
      pivotModel: path.join(pivotDir, pivotFiles.modelFile),
      pivotSrcVocab: path.join(pivotDir, pivotFiles.vocabFile),
      pivotDstVocab: path.join(pivotDir, pivotFiles.vocabFile)
    },
    params: opts.params || { srcLang: 'es', dstLang: 'it' },
    config: {
      modelType: TranslationNmtcpp.ModelTypes.Bergamot,
      beamsize: 1,
      ...(opts.normalize !== undefined && { normalize: opts.normalize }),
      ...(opts.use_gpu !== undefined && { use_gpu: opts.use_gpu }),
      ...(typeof opts.gpu_device === 'number' && { gpu_device: opts.gpu_device }),
      pivotConfig: {
        beamsize: 1,
        ...(opts.pivotNormalize !== undefined && { normalize: opts.pivotNormalize })
      }
    },
    logger: opts.logger || createLogger(),
    opts: { stats: true }
  }
}

// ---------------------------------------------------------------------------
// Test: Pivot translation happy path (es → en → it)
// Per-GPU-device tests (mobile only) + CPU test.
// ---------------------------------------------------------------------------

/**
 * Shared runner for the es→en→it pivot test on a specific GPU device or CPU.
 */
async function runEsEnItPivotTest (t, label, useGpu, gpuDevice) {
  t.comment('Platform: ' + platform + ', isMobile: ' + isMobile)
  t.comment(`${label} Testing with use_gpu: ${useGpu}` +
    (typeof gpuDevice === 'number' ? `, gpu_device: ${gpuDevice}` : ''))

  t.comment(`${label} Ensuring es→en model...`)
  const esEnDir = await ensureModelPair('es', 'en')
  t.ok(esEnDir, `${label} es→en model directory available`)

  t.comment(`${label} Ensuring en→it model...`)
  const enItDir = await ensureModelPair('en', 'it')
  t.ok(enItDir, `${label} en→it model directory available`)

  const esEn = findModelFiles(esEnDir)
  const enIt = findModelFiles(enItDir)

  t.ok(esEn.modelFile, `${label} es→en model file found`)
  t.ok(esEn.vocabFile, `${label} es→en vocab file found`)
  t.ok(enIt.modelFile, `${label} en→it model file found`)
  t.ok(enIt.vocabFile, `${label} en→it vocab file found`)

  const logger = createLogger()
  const perfCollector = createPerformanceCollector()
  let model

  try {
    const opts = {
      logger,
      normalize: 1,
      use_gpu: useGpu,
      pivotNormalize: 1
    }
    if (typeof gpuDevice === 'number') opts.gpu_device = gpuDevice

    model = new TranslationNmtcpp(createPivotArgs(esEnDir, esEn, enItDir, enIt, opts))

    await model.load()
    t.pass(`${label} Pivot model loaded (es→en→it)`)

    const testSentence = 'Buenos días, ¿cómo estás hoy?'
    t.comment(`${label} Translating: "${testSentence}"`)

    perfCollector.start()

    const response = await model.run(testSentence)
    await response
      .onUpdate(data => { perfCollector.onToken(data) })
      .await()

    const addonStats = response.stats || {}
    t.comment(`${label} Native addon stats: ${JSON.stringify(addonStats)}`)
    const metrics = perfCollector.getMetrics(testSentence, addonStats)
    t.comment(formatPerformanceMetrics(`[Pivot es→en→it] ${label}`, metrics, {
      fixturePath: PIVOT_BERGAMOT_FIXTURE,
      srcLang: 'es',
      dstLang: 'it'
    }))

    t.ok(metrics.fullOutput.length > 0, `${label} pivot translation produced output`)
    t.pass(`${label} Pivot translation completed successfully`)
  } finally {
    if (model) {
      try { await model.unload() } catch (e) {
        t.comment(`${label} unload error: ${e.message}`)
      }
    }
  }
}

if (isMobile) {
  for (let gpuIdx = 0; gpuIdx < MAX_GPU_DEVICE_PROBES; gpuIdx++) {
    test(`Pivot translation [GPU device ${gpuIdx}] - Spanish → English → Italian`, { timeout: PIVOT_TIMEOUT }, async function (t) {
      const devices = await discoverGpuDevices()
      const device = devices.find(d => d.index === gpuIdx)

      if (!device) {
        t.comment(`[GPU:${gpuIdx}] No GPU device at index ${gpuIdx} — skipping`)
        t.pass(`[GPU:${gpuIdx}] Skipped (device not present)`)
        return
      }

      const label = `[GPU:${gpuIdx} ${device.name}]`
      await runEsEnItPivotTest(t, label, true, gpuIdx)
    })
  }
}

test('Pivot translation [CPU] - Spanish → English → Italian', { timeout: PIVOT_TIMEOUT }, async function (t) {
  await runEsEnItPivotTest(t, '[CPU]', false, undefined)
})

// ---------------------------------------------------------------------------
// Test: Pivot stats are populated (regression for v0.6.1 hang fix)
// ---------------------------------------------------------------------------

test('Pivot translation - stats object is populated (no hang)', { timeout: PIVOT_TIMEOUT }, async function (t) {
  const esEnDir = await ensureModelPair('es', 'en')
  const enItDir = await ensureModelPair('en', 'it')
  const esEn = findModelFiles(esEnDir)
  const enIt = findModelFiles(enItDir)

  let model
  try {
    model = new TranslationNmtcpp(createPivotArgs(esEnDir, esEn, enItDir, enIt))

    await model.load()

    const response = await model.run('Hola mundo')
    let output = ''
    await response
      .onUpdate(data => { output += data })
      .await()

    const stats = response.stats
    t.ok(stats, 'stats object should exist')
    t.ok(typeof stats === 'object', 'stats should be an object')
    t.comment('Pivot stats keys: ' + Object.keys(stats).join(', '))
    t.ok(output.length > 0, 'translation output should not be empty')
    t.pass('Stats received without hang')
  } finally {
    if (model) {
      try { await model.unload() } catch (_) {}
    }
  }
})

// ---------------------------------------------------------------------------
// Test: Pivot batch translation via runBatch()
// ---------------------------------------------------------------------------

test('Pivot translation - batch translation via runBatch()', { timeout: PIVOT_TIMEOUT }, async function (t) {
  const esEnDir = await ensureModelPair('es', 'en')
  const enItDir = await ensureModelPair('en', 'it')
  const esEn = findModelFiles(esEnDir)
  const enIt = findModelFiles(enItDir)

  let model
  try {
    model = new TranslationNmtcpp(createPivotArgs(esEnDir, esEn, enItDir, enIt))

    await model.load()

    const inputs = [
      'Buenos días',
      'Gracias por tu ayuda',
      'El gato está en la mesa'
    ]
    t.comment('Batch input: ' + JSON.stringify(inputs))

    const results = await model.runBatch(inputs)

    t.ok(Array.isArray(results), 'batch results should be an array')
    t.is(results.length, inputs.length, `should return ${inputs.length} translations`)

    for (let i = 0; i < results.length; i++) {
      t.ok(typeof results[i] === 'string', `result[${i}] should be a string`)
      t.ok(results[i].length > 0, `result[${i}] should not be empty`)
      t.comment(`  "${inputs[i]}" → "${results[i]}"`)
    }

    t.pass('Batch pivot translation completed')
  } finally {
    if (model) {
      try { await model.unload() } catch (_) {}
    }
  }
})

// ---------------------------------------------------------------------------
// Test: Cancel during pivot translation
// ---------------------------------------------------------------------------

test('Pivot translation - cancel does not crash', { timeout: PIVOT_TIMEOUT }, async function (t) {
  const esEnDir = await ensureModelPair('es', 'en')
  const enItDir = await ensureModelPair('en', 'it')
  const esEn = findModelFiles(esEnDir)
  const enIt = findModelFiles(enItDir)

  let model
  try {
    model = new TranslationNmtcpp(createPivotArgs(esEnDir, esEn, enItDir, enIt))

    await model.load()

    const longText = 'Esta es una oración muy larga que debería tomar un poco de tiempo para traducir. ' +
      'Queremos asegurarnos de que la cancelación funcione correctamente durante la traducción pivote. ' +
      'El texto sigue y sigue para dar tiempo al proceso de ser cancelado antes de terminar.'

    const response = await model.run(longText)

    response.cancel()
    t.pass('Response cancel() during pivot translation did not crash')

    const addonCancelOk = model.addon && typeof model.addon.cancel === 'function'
    t.ok(addonCancelOk, 'addon.cancel() is available')
    if (addonCancelOk) {
      model.addon.cancel()
      t.pass('addon.cancel() during pivot translation did not crash')
    }
  } finally {
    if (model) {
      try { await model.unload() } catch (_) {}
    }
  }
})

// ---------------------------------------------------------------------------
// Test: Multiple sequential translations reuse the same loaded model
// ---------------------------------------------------------------------------

test('Pivot translation - multiple sequential runs', { timeout: PIVOT_TIMEOUT }, async function (t) {
  const esEnDir = await ensureModelPair('es', 'en')
  const enItDir = await ensureModelPair('en', 'it')
  const esEn = findModelFiles(esEnDir)
  const enIt = findModelFiles(enItDir)

  let model
  try {
    model = new TranslationNmtcpp(createPivotArgs(esEnDir, esEn, enItDir, enIt))

    await model.load()

    const sentences = ['Hola', 'Adiós', 'Gracias']
    const results = []

    for (const sentence of sentences) {
      const response = await model.run(sentence)
      let output = ''
      await response
        .onUpdate(data => { output += data })
        .await()
      results.push(output)
      t.ok(output.length > 0, `"${sentence}" produced output: "${output}"`)
    }

    t.is(results.length, 3, 'all 3 sequential translations completed')
    t.pass('Multiple sequential pivot translations succeeded')
  } finally {
    if (model) {
      try { await model.unload() } catch (_) {}
    }
  }
})

// ---------------------------------------------------------------------------
// Test: Empty string input
// ---------------------------------------------------------------------------

test('Pivot translation - empty string input', { timeout: PIVOT_TIMEOUT }, async function (t) {
  const esEnDir = await ensureModelPair('es', 'en')
  const enItDir = await ensureModelPair('en', 'it')
  const esEn = findModelFiles(esEnDir)
  const enIt = findModelFiles(enItDir)

  let model
  try {
    model = new TranslationNmtcpp(createPivotArgs(esEnDir, esEn, enItDir, enIt))

    await model.load()

    const response = await model.run('')
    let output = ''
    await response
      .onUpdate(data => { output += data })
      .await()

    t.comment('Empty input produced output: "' + output + '"')
    t.pass('Empty string input did not crash')
  } catch (e) {
    t.comment('Empty string threw (acceptable): ' + e.message)
    t.pass('Empty string input handled gracefully')
  } finally {
    if (model) {
      try { await model.unload() } catch (_) {}
    }
  }
})

// ---------------------------------------------------------------------------
// Test: Run on unloaded model should throw
// ---------------------------------------------------------------------------

test('Pivot translation - run after unload throws', { timeout: PIVOT_TIMEOUT }, async function (t) {
  const esEnDir = await ensureModelPair('es', 'en')
  const enItDir = await ensureModelPair('en', 'it')
  const esEn = findModelFiles(esEnDir)
  const enIt = findModelFiles(enItDir)

  let model
  try {
    model = new TranslationNmtcpp(createPivotArgs(esEnDir, esEn, enItDir, enIt))

    await model.load()
    await model.unload()

    try {
      await model.run('Hola')
      t.fail('Expected run() after unload to throw')
    } catch (e) {
      t.ok(e, 'run() after unload threw an error')
      t.comment('Error message: ' + e.message)
      t.pass('Unloaded model correctly rejects run()')
    }
  } finally {
    if (model) {
      try { await model.unload() } catch (_) {}
    }
  }
})

// ---------------------------------------------------------------------------
// Test: Load → unload → reload cycle
// ---------------------------------------------------------------------------

test('Pivot translation - load, unload, reload cycle', { timeout: PIVOT_TIMEOUT }, async function (t) {
  const esEnDir = await ensureModelPair('es', 'en')
  const enItDir = await ensureModelPair('en', 'it')
  const esEn = findModelFiles(esEnDir)
  const enIt = findModelFiles(enItDir)

  let model
  try {
    model = new TranslationNmtcpp(createPivotArgs(esEnDir, esEn, enItDir, enIt))

    // First load and translate
    await model.load()
    t.pass('First load succeeded')

    const response1 = await model.run('Hola')
    let output1 = ''
    await response1
      .onUpdate(data => { output1 += data })
      .await()
    t.ok(output1.length > 0, 'First translation produced output: "' + output1 + '"')

    // Unload
    await model.unload()
    t.pass('Unload succeeded')

    // Reload and translate again
    await model.load()
    t.pass('Reload succeeded')

    const response2 = await model.run('Gracias')
    let output2 = ''
    await response2
      .onUpdate(data => { output2 += data })
      .await()
    t.ok(output2.length > 0, 'Second translation after reload produced output: "' + output2 + '"')

    t.pass('Load → unload → reload cycle completed successfully')
  } finally {
    if (model) {
      try { await model.unload() } catch (_) {}
    }
  }
})

// ---------------------------------------------------------------------------
// Test: Different language pair (fr → en → es)
//
// WHY: All other tests use es→en→it. If pivot only works for that one pair
// it's a bug — a user should be able to pivot ANY supported pair through
// English. This proves the feature is generic, not accidentally hardcoded.
// ---------------------------------------------------------------------------

/**
 * Shared runner for the fr→en→es pivot test on a specific GPU device or CPU.
 */
async function runFrEnEsPivotTest (t, label, useGpu, gpuDevice) {
  t.comment('Platform: ' + platform + ', isMobile: ' + isMobile)
  t.comment(`${label} Testing with use_gpu: ${useGpu}` +
    (typeof gpuDevice === 'number' ? `, gpu_device: ${gpuDevice}` : ''))

  t.comment(`${label} Ensuring fr→en model...`)
  const frEnDir = await ensureModelPair('fr', 'en')
  t.ok(frEnDir, `${label} fr→en model directory available`)

  t.comment(`${label} Ensuring en→es model...`)
  const enEsDir = await ensureModelPair('en', 'es')
  t.ok(enEsDir, `${label} en→es model directory available`)

  const frEn = findModelFiles(frEnDir)
  const enEs = findModelFiles(enEsDir)

  t.ok(frEn.modelFile, `${label} fr→en model file found`)
  t.ok(frEn.vocabFile, `${label} fr→en vocab file found`)
  t.ok(enEs.modelFile, `${label} en→es model file found`)
  t.ok(enEs.vocabFile, `${label} en→es vocab file found`)

  const logger = createLogger()
  const perfCollector = createPerformanceCollector()
  let model

  try {
    const opts = {
      params: { srcLang: 'fr', dstLang: 'es' },
      logger,
      normalize: 1,
      use_gpu: useGpu,
      pivotNormalize: 1
    }
    if (typeof gpuDevice === 'number') opts.gpu_device = gpuDevice

    model = new TranslationNmtcpp(createPivotArgs(frEnDir, frEn, enEsDir, enEs, opts))

    await model.load()
    t.pass(`${label} Pivot model loaded (fr→en→es)`)

    const testSentence = 'Bonjour, comment allez-vous aujourd\'hui?'
    t.comment(`${label} Translating: "${testSentence}"`)

    perfCollector.start()

    const response = await model.run(testSentence)
    await response
      .onUpdate(data => { perfCollector.onToken(data) })
      .await()

    const addonStats = response.stats || {}
    const metrics = perfCollector.getMetrics(testSentence, addonStats)
    t.comment(formatPerformanceMetrics(`[Pivot fr→en→es] ${label}`, metrics, {
      fixturePath: PIVOT_BERGAMOT_FIXTURE,
      srcLang: 'fr',
      dstLang: 'es'
    }))

    t.ok(metrics.fullOutput.length > 0, `${label} pivot translation produced output`)
    t.pass(`${label} fr→en→es pivot translation completed successfully`)
  } finally {
    if (model) {
      try { await model.unload() } catch (e) {
        t.comment(`${label} unload error: ${e.message}`)
      }
    }
  }
}

if (isMobile) {
  for (let gpuIdx = 0; gpuIdx < MAX_GPU_DEVICE_PROBES; gpuIdx++) {
    test(`Pivot translation [GPU device ${gpuIdx}] - French → English → Spanish`, { timeout: PIVOT_TIMEOUT }, async function (t) {
      const devices = await discoverGpuDevices()
      const device = devices.find(d => d.index === gpuIdx)

      if (!device) {
        t.comment(`[GPU:${gpuIdx}] No GPU device at index ${gpuIdx} — skipping`)
        t.pass(`[GPU:${gpuIdx}] Skipped (device not present)`)
        return
      }

      const label = `[GPU:${gpuIdx} ${device.name}]`
      await runFrEnEsPivotTest(t, label, true, gpuIdx)
    })
  }
}

test('Pivot translation [CPU] - French → English → Spanish', { timeout: PIVOT_TIMEOUT }, async function (t) {
  await runFrEnEsPivotTest(t, '[CPU]', false, undefined)
})

// ---------------------------------------------------------------------------
// Test: Long multi-paragraph text
//
// WHY: Short test sentences may hide issues in the chained pipeline.
// Real users translate full paragraphs/documents. The two-model chain
// buffers the entire first-model output before feeding it to the second.
// Long text stresses memory, tokenizer limits, and the intermediate
// handoff between models. If this breaks in production, users lose trust.
// ---------------------------------------------------------------------------

test('Pivot translation - long multi-paragraph text', { timeout: PIVOT_TIMEOUT }, async function (t) {
  const esEnDir = await ensureModelPair('es', 'en')
  const enItDir = await ensureModelPair('en', 'it')
  const esEn = findModelFiles(esEnDir)
  const enIt = findModelFiles(enItDir)

  let model
  try {
    model = new TranslationNmtcpp(createPivotArgs(esEnDir, esEn, enItDir, enIt))

    await model.load()

    const longText =
      'Era una mañana soleada cuando María decidió visitar el mercado local. ' +
      'Compró frutas frescas, verduras y flores para su casa. ' +
      'El vendedor le recomendó las mejores manzanas de la temporada. ' +
      'María también encontró un hermoso libro antiguo en una tienda cercana. ' +
      'Fue un día perfecto para explorar la ciudad. ' +
      'Por la tarde, visitó el museo de arte contemporáneo donde admiró las obras de artistas locales. ' +
      'La exposición principal presentaba pinturas abstractas con colores vibrantes. ' +
      'Al final del día, María se sentó en un café junto al río y reflexionó sobre todas las experiencias del día.'

    t.comment('Input length: ' + longText.length + ' characters')

    const response = await model.run(longText)
    let output = ''
    await response
      .onUpdate(data => { output += data })
      .await()

    t.ok(output.length > 0, 'long text produced output')
    t.ok(output.length > 50, 'output is substantial (>' + 50 + ' chars, got ' + output.length + ')')
    t.comment('Output length: ' + output.length + ' characters')
    t.comment('Output preview: "' + output.substring(0, 120) + '..."')
    t.pass('Long multi-paragraph pivot translation completed')
  } finally {
    if (model) {
      try { await model.unload() } catch (_) {}
    }
  }
})

// ---------------------------------------------------------------------------
// Test: Text with numbers, punctuation, and special characters
//
// WHY: Real-world text contains dates, prices, URLs, emails, and
// mixed punctuation. The tokenizer in each model handles these
// differently. If numbers or special chars get corrupted during the
// intermediate handoff (first model output → second model input),
// the final translation silently loses critical information.
// This is a common production bug in chained translation pipelines.
// ---------------------------------------------------------------------------

test('Pivot translation - numbers and special characters preserved', { timeout: PIVOT_TIMEOUT }, async function (t) {
  const esEnDir = await ensureModelPair('es', 'en')
  const enItDir = await ensureModelPair('en', 'it')
  const esEn = findModelFiles(esEnDir)
  const enIt = findModelFiles(enItDir)

  let model
  try {
    model = new TranslationNmtcpp(createPivotArgs(esEnDir, esEn, enItDir, enIt))

    await model.load()

    const textWithSpecials = 'El precio es $49.99 y la fecha es 15/03/2026. Contacto: maria@ejemplo.com (Tel: +34-600-123-456)'
    t.comment('Input: "' + textWithSpecials + '"')

    const response = await model.run(textWithSpecials)
    let output = ''
    await response
      .onUpdate(data => { output += data })
      .await()

    t.ok(output.length > 0, 'special character text produced output')
    t.comment('Output: "' + output + '"')

    const hasNumbers = /\d/.test(output)
    t.ok(hasNumbers, 'output retains numeric content')
    t.pass('Numbers and special characters handled through pivot chain')
  } finally {
    if (model) {
      try { await model.unload() } catch (_) {}
    }
  }
})

// ---------------------------------------------------------------------------
// Test: Batch with single item
//
// WHY: runBatch() follows a different C++ code path (processBatch) than
// run() (process with string). A single-item batch is the most common
// real-world usage — apps often batch-wrap inputs for consistency.
// If the batch path breaks for n=1 while single run() works, it's a
// subtle bug that only shows up in production integrations.
// ---------------------------------------------------------------------------

test('Pivot translation - batch with single item', { timeout: PIVOT_TIMEOUT }, async function (t) {
  const esEnDir = await ensureModelPair('es', 'en')
  const enItDir = await ensureModelPair('en', 'it')
  const esEn = findModelFiles(esEnDir)
  const enIt = findModelFiles(enItDir)

  let model
  try {
    model = new TranslationNmtcpp(createPivotArgs(esEnDir, esEn, enItDir, enIt))

    await model.load()

    const results = await model.runBatch(['Buenos días'])

    t.ok(Array.isArray(results), 'single-item batch returns an array')
    t.is(results.length, 1, 'array has exactly 1 result')
    t.ok(results[0].length > 0, 'single result is not empty: "' + results[0] + '"')
    t.pass('Single-item batch pivot translation works')
  } finally {
    if (model) {
      try { await model.unload() } catch (_) {}
    }
  }
})
