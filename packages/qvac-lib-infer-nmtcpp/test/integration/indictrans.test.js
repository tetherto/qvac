'use strict'

/**
 * IndicTrans Backend Integration Test
 *
 * Tests the IndicTrans2 translation backend with English to Hindi translation.
 * Uses AI4Bharat's IndicTrans2 model with IndicProcessor for language-specific preprocessing.
 *
 * IndicProcessor:
 *   - Handles language-specific tokenization and preprocessing
 *   - No manual language prefixes needed (unlike raw model access)
 *
 * Platform Behavior:
 *   - Mobile (iOS/Android): Tests both CPU and GPU modes
 *   - Desktop: Tests CPU mode only
 *
 * Usage:
 *   bare test/integration/indictrans.test.js
 */

const test = require('brittle')
const path = require('bare-path')
const TranslationNmtcpp = require('@qvac/translation-nmtcpp')
const {
  ensureIndicTransModel,
  createLogger,
  TEST_TIMEOUT,
  createPerformanceCollector,
  formatPerformanceMetrics,
  isMobile,
  platform
} = require('./utils')

const INDICTRANS_FIXTURE = path.resolve(__dirname, 'fixtures/indictrans.quality.json')

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

  test(`IndicTrans backend ${label} - English to Hindi translation`, { timeout: TEST_TIMEOUT }, async function (t) {
    const modelPath = await ensureIndicTransModel()
    t.ok(modelPath, `${label} IndicTrans model path should be available`)
    t.comment(`${label} Model path: ` + modelPath)
    t.comment('Platform: ' + platform + ', isMobile: ' + isMobile)

    const logger = createLogger()
    const perfCollector = createPerformanceCollector()
    let model

    t.comment(`${label} Testing with use_gpu: ${deviceConfig.useGpu}`)

    try {
      model = new TranslationNmtcpp({
        files: {
          model: modelPath
        },
        params: {
          mode: 'full',
          srcLang: 'eng_Latn',
          dstLang: 'hin_Deva'
        },
        config: {
          modelType: TranslationNmtcpp.ModelTypes.IndicTrans,
          use_gpu: deviceConfig.useGpu
        },
        logger,
        opts: { stats: true }
      })
      model.logger.setLevel('debug')
      await model.load()
      t.pass(`${label} IndicTrans model loaded successfully`)

      const testSentence = 'Hello, how are you?'
      t.comment(`${label} Translating: "` + testSentence + '"')

      perfCollector.start()

      const response = await model.run(testSentence)

      await response
        .onUpdate(data => {
          perfCollector.onToken(data)
        })
        .await()

      const addonStats = response.stats || {}
      t.comment(`${label} Native addon stats: ` + JSON.stringify(addonStats))
      const metrics = perfCollector.getMetrics(testSentence, addonStats)
      t.comment(formatPerformanceMetrics(`[IndicTrans] ${label}`, metrics, {
        fixturePath: INDICTRANS_FIXTURE,
        srcLang: 'eng_Latn',
        dstLang: 'hin_Deva'
      }))

      t.ok(metrics.fullOutput.length > 0, `${label} translation should not be empty`)
      t.pass(`${label} IndicTrans translation completed successfully`)
    } catch (e) {
      t.fail(`${label} IndicTrans test failed: ` + e.message)
      throw e
    } finally {
      if (model) {
        try {
          await model.unload()
          t.pass(`${label} After model.unload().`)
        } catch (e) {
          t.comment(`${label} unload() error: ` + e.message)
        }
      }
    }
  })
}
