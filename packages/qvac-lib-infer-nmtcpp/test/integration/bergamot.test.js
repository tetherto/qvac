'use strict'

/* global Bare */

/**
 * Bergamot Backend Integration Test
 *
 * Tests the Bergamot (intgemm quantized) translation backend with English to Italian translation.
 * Uses Mozilla's Bergamot project models optimized for CPU inference.
 *
 * Platform Behavior:
 *   - Mobile (iOS/Android): GPU devices discovered at runtime, each gets its
 *     own test run with identifiable label (e.g. [GPU:0 Vulkan0])
 *   - Desktop: Tests CPU mode only (intgemm is CPU-optimized)
 *
 * Usage:
 *   bare test/integration/bergamot.test.js
 */

// Guard against Bare's default abort() on unhandled promise rejections.
// Without this, a transient network error during model fetch would
// SIGABRT the process (see notes in indictrans.test.js and pivot-bergamot.test.js).
if (typeof Bare !== 'undefined' && Bare.on) {
  Bare.on('unhandledRejection', (err) => {
    console.error('[bergamot] Unhandled rejection:', err && (err.stack || err.message || err))
  })
}

const test = require('brittle')
const path = require('bare-path')
const fs = require('bare-fs')
const TranslationNmtcpp = require('@qvac/translation-nmtcpp')
const {
  ensureBergamotModel,
  createLogger,
  TEST_TIMEOUT,
  createPerformanceCollector,
  formatPerformanceMetrics,
  isMobile,
  platform,
  discoverGpuDevices,
  MAX_GPU_DEVICE_PROBES
} = require('./utils')

const BERGAMOT_FIXTURE = path.resolve(__dirname, 'fixtures/bergamot.quality.json')

// ---------------------------------------------------------------------------
// Per-GPU-device tests (mobile only).  On desktop only the CPU test runs.
// ---------------------------------------------------------------------------

if (isMobile) {
  for (let gpuIdx = 0; gpuIdx < MAX_GPU_DEVICE_PROBES; gpuIdx++) {
    test(`Bergamot backend [GPU device ${gpuIdx}] - English to Italian translation`, { timeout: TEST_TIMEOUT }, async function (t) {
      const modelDir = await ensureBergamotModel()
      const allFiles = fs.readdirSync(modelDir)
      const modelFile = allFiles.find(f => f.includes('.intgemm') && f.includes('.bin'))
      const vocabFile = allFiles.find(f => f.includes('.spm'))

      const devices = await discoverGpuDevices()
      const device = devices.find(d => d.index === gpuIdx)

      if (!device) {
        t.comment(`[GPU:${gpuIdx}] No GPU device at index ${gpuIdx} — skipping`)
        t.pass(`[GPU:${gpuIdx}] Skipped (device not present)`)
        return
      }

      const label = `[GPU:${gpuIdx} ${device.name}]`
      t.ok(modelDir, `${label} Bergamot model path should be available`)
      t.comment(`${label} Model directory: ` + modelDir)
      t.comment('Platform: ' + platform + ', isMobile: ' + isMobile)
      t.comment(`${label} Testing with use_gpu: true, gpu_device: ${gpuIdx}`)

      const fullVocabPath = path.join(modelDir, vocabFile)
      const logger = createLogger()
      const perfCollector = createPerformanceCollector()
      let model

      try {
        model = new TranslationNmtcpp({
          files: {
            model: path.join(modelDir, modelFile),
            srcVocab: fullVocabPath,
            dstVocab: fullVocabPath
          },
          params: { srcLang: 'en', dstLang: 'it' },
          config: {
            modelType: TranslationNmtcpp.ModelTypes.Bergamot,
            beamsize: 1,
            normalize: 1,
            use_gpu: true,
            gpu_device: gpuIdx
          },
          logger,
          opts: { stats: true }
        })
        model.logger.setLevel('debug')
        await model.load()
        t.pass(`${label} Bergamot model loaded successfully`)

        const testSentence = 'Hello, how are you?'
        t.comment(`${label} Translating: "` + testSentence + '"')

        perfCollector.start()
        const response = await model.run(testSentence)
        await response
          .onUpdate(data => { perfCollector.onToken(data) })
          .await()

        const addonStats = response.stats || {}
        t.comment(`${label} Native addon stats: ` + JSON.stringify(addonStats))
        const metrics = perfCollector.getMetrics(testSentence, addonStats)
        t.comment(formatPerformanceMetrics(`[Bergamot] ${label}`, metrics, {
          fixturePath: BERGAMOT_FIXTURE,
          srcLang: 'en',
          dstLang: 'it'
        }))

        t.ok(metrics.fullOutput.length > 0, `${label} translation should not be empty`)
        t.pass(`${label} Bergamot translation completed successfully`)
      } catch (e) {
        t.fail(`${label} Bergamot test failed: ` + e.message)
        throw e
      } finally {
        if (model) {
          try { await model.unload() } catch (e) {
            t.comment(`${label} unload() error: ` + e.message)
          }
        }
      }
    })
  }
}

// CPU test (always runs)
test('Bergamot backend [CPU] - English to Italian translation', { timeout: TEST_TIMEOUT }, async function (t) {
  const modelDir = await ensureBergamotModel()
  const label = '[CPU]'
  t.ok(modelDir, `${label} Bergamot model path should be available`)
  t.comment(`${label} Model directory: ` + modelDir)
  t.comment('Platform: ' + platform + ', isMobile: ' + isMobile)

  const allFiles = fs.readdirSync(modelDir)
  const modelFile = allFiles.find(f => f.includes('.intgemm') && f.includes('.bin'))
  const vocabFile = allFiles.find(f => f.includes('.spm'))

  t.ok(modelFile, `${label} model file should exist`)
  t.ok(vocabFile, `${label} vocab file should exist`)

  const fullVocabPath = path.join(modelDir, vocabFile)
  const logger = createLogger()
  const perfCollector = createPerformanceCollector()
  let model

  t.comment(`${label} Testing with use_gpu: false`)

  try {
    model = new TranslationNmtcpp({
      files: {
        model: path.join(modelDir, modelFile),
        srcVocab: fullVocabPath,
        dstVocab: fullVocabPath
      },
      params: { srcLang: 'en', dstLang: 'it' },
      config: {
        modelType: TranslationNmtcpp.ModelTypes.Bergamot,
        beamsize: 1,
        normalize: 1,
        use_gpu: false
      },
      logger,
      opts: { stats: true }
    })
    model.logger.setLevel('debug')
    await model.load()
    t.pass(`${label} Bergamot model loaded successfully`)

    const testSentence = 'Hello, how are you?'
    t.comment(`${label} Translating: "` + testSentence + '"')

    perfCollector.start()
    const response = await model.run(testSentence)
    await response
      .onUpdate(data => { perfCollector.onToken(data) })
      .await()

    const addonStats = response.stats || {}
    t.comment(`${label} Native addon stats: ` + JSON.stringify(addonStats))
    const metrics = perfCollector.getMetrics(testSentence, addonStats)
    t.comment(formatPerformanceMetrics(`[Bergamot] ${label}`, metrics, {
      fixturePath: BERGAMOT_FIXTURE,
      srcLang: 'en',
      dstLang: 'it'
    }))

    t.ok(metrics.fullOutput.length > 0, `${label} translation should not be empty`)
    t.pass(`${label} Bergamot translation completed successfully`)
  } catch (e) {
    t.fail(`${label} Bergamot test failed: ` + e.message)
    throw e
  } finally {
    if (model) {
      try { await model.unload() } catch (e) {
        t.comment(`${label} unload() error: ` + e.message)
      }
    }
  }
})
