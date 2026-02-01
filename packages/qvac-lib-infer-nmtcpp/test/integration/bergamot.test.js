'use strict'

/**
 * Bergamot Backend Integration Test
 *
 * Tests the Bergamot (intgemm quantized) translation backend with English to Italian translation.
 * Uses Mozilla's Bergamot project models optimized for CPU inference.
 *
 * Platform Behavior:
 *   - Mobile (iOS/Android): Tests both CPU and GPU modes
 *   - Desktop: Tests CPU mode only
 *
 * Usage:
 *   bare test/integration/bergamot.test.js
 */

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
  platform
} = require('./utils')

/**
 * Device configurations for testing
 * - Mobile (iOS/Android): Both CPU and GPU
 * - Desktop: CPU only
 */
const ALL_DEVICE_CONFIGS = [
  { id: 'gpu', useGpu: true },
  { id: 'cpu', useGpu: false }
]

const DEVICE_CONFIGS = isMobile
  ? ALL_DEVICE_CONFIGS
  : ALL_DEVICE_CONFIGS.filter(c => c.id === 'cpu')

for (const deviceConfig of DEVICE_CONFIGS) {
  const label = `[${deviceConfig.id.toUpperCase()}]`

  test(`Bergamot backend ${label} - English to Italian translation`, { timeout: TEST_TIMEOUT }, async function (t) {
    const modelDir = await ensureBergamotModel()
    t.ok(modelDir, `${label} Bergamot model path should be available`)
    t.comment(`${label} Model directory: ` + modelDir)
    t.comment('Platform: ' + platform + ', isMobile: ' + isMobile)

    // Locate model and vocab files
    const files = fs.readdirSync(modelDir)
    const modelFile = files.find(f => f.includes('.intgemm') && f.includes('.bin'))
    const vocabFile = files.find(f => f.includes('.spm'))

    t.ok(modelFile, `${label} model file should exist`)
    t.ok(vocabFile, `${label} vocab file should exist`)

    const fullVocabPath = path.join(modelDir, vocabFile)

    /**
     * Local file loader for Bergamot model
     * Provides synchronous file access for model loading
     */
    const localLoader = {
      ready: async () => {},
      close: async () => {},
      download: async (filename) => {
        const filePath = path.join(modelDir, filename)
        return fs.readFileSync(filePath)
      },
      getFileSize: async (filename) => {
        const filePath = path.join(modelDir, filename)
        const stats = fs.statSync(filePath)
        return stats.size
      }
    }

    const logger = createLogger()
    const perfCollector = createPerformanceCollector()
    let model

    t.comment(`${label} Testing with use_gpu: ${deviceConfig.useGpu}`)

    try {
      model = new TranslationNmtcpp({
        loader: localLoader,
        params: {
          srcLang: 'en',
          dstLang: 'it'
        },
        diskPath: modelDir,
        modelName: modelFile,
        logger,
        opts: { stats: true }
      }, {
        modelType: TranslationNmtcpp.ModelTypes.Bergamot,
        srcVocabPath: fullVocabPath,
        dstVocabPath: fullVocabPath,
        beamsize: 1,
        normalize: 1,
        use_gpu: deviceConfig.useGpu
      })

      await model.load()
      t.pass(`${label} Bergamot model loaded successfully`)

      const testSentence = 'Hello, how are you?'
      t.comment(`${label} Translating: "` + testSentence + '"')

      // Start performance tracking
      perfCollector.start()

      const response = await model.run(testSentence)

      await response
        .onUpdate(data => {
          perfCollector.onToken(data)
        })
        .await()

      // Get and log performance metrics
      const addonStats = response.stats || {}
      t.comment(`${label} Native addon stats: ` + JSON.stringify(addonStats))
      const metrics = perfCollector.getMetrics(testSentence, addonStats)
      t.comment(formatPerformanceMetrics(`[Bergamot] ${label}`, metrics))

      t.ok(metrics.fullOutput.length > 0, `${label} translation should not be empty`)
      t.pass(`${label} Bergamot translation completed successfully`)
    } catch (e) {
      t.fail(`${label} Bergamot test failed: ` + e.message)
      throw e
    } finally {
      if (model) {
        try {
          await model.unload()
        } catch (e) {
          t.comment(`${label} unload() error: ` + e.message)
        }
      }
    }
  })
}
