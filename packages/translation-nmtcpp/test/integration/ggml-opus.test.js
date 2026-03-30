'use strict'

/**
 * GGML/Opus Backend Integration Test
 *
 * Tests the GGML neural machine translation backend with English to Italian translation.
 * Uses HyperDrive to download model if not cached locally.
 *
 * Platform Behavior:
 *   - Mobile (iOS/Android): Tests both CPU and GPU modes
 *   - Desktop: Tests CPU mode only
 *
 * Usage:
 *   bare test/integration/ggml-opus.test.js
 */

const test = require('brittle')
const TranslationNmtcpp = require('@qvac/translation-nmtcpp')
const FilesystemDL = require('@qvac/dl-filesystem')
const HyperDriveDL = require('@qvac/dl-hyperdrive')
const WeightsProvider = require('@qvac/infer-base/WeightsProvider/WeightsProvider')
const path = require('bare-path')
const fs = require('bare-fs')
const {
  isMobile,
  platform,
  TEST_TIMEOUT,
  createPerformanceCollector,
  formatPerformanceMetrics
} = require('./utils')

/** HyperDrive key for downloading NMT model */
const HYPERDRIVE_KEY = 'hd://9ef58f31c20d5556722e0b58a5d262fd89801daf2e6cb28e3f21ac6e9228088f'

/** Model filename in HyperDrive */
const MODEL_NAME = 'model.bin'

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

/**
 * Gets the working directory for model storage
 * On mobile: uses global.dirPath or global.testDir (writable path provided by test framework) or /tmp
 * On desktop: uses local model directory
 *
 * @returns {string} Directory path for model storage
 */
function getModelDir () {
  if (isMobile) {
    const writableDir = global.dirPath || global.testDir || '/tmp'
    console.log('[GGML] Mobile detected, using writable dir:', writableDir)
    return writableDir
  }
  return path.resolve(__dirname, '../../model/nmt')
}

/**
 * Downloads NMT model from HyperDrive if not already present
 */
async function ensureModel (dirPath) {
  const modelPath = path.join(dirPath, MODEL_NAME)

  if (fs.existsSync(modelPath)) {
    console.log('[GGML] 📦 Model already cached, skipping download')
    return modelPath
  }

  console.log('[GGML] 📥 Downloading NMT model from HyperDrive...')
  console.log('[GGML] Target directory:', dirPath)

  fs.mkdirSync(dirPath, { recursive: true })

  const hd = new HyperDriveDL({ key: HYPERDRIVE_KEY })
  const weightsProvider = new WeightsProvider(hd, console)

  await weightsProvider.downloadFiles([MODEL_NAME], dirPath, {
    closeLoader: true
  })

  console.log('[GGML] ✅ Model downloaded successfully')
  return modelPath
}

for (const deviceConfig of DEVICE_CONFIGS) {
  const label = `[${deviceConfig.id.toUpperCase()}]`

  test(`GGML/Opus backend ${label} - English to Italian translation`, { timeout: TEST_TIMEOUT }, async t => {
    const dirPath = getModelDir()
    let translation = null
    let loader = null

    t.comment('Platform: ' + platform + ', isMobile: ' + isMobile)
    t.comment(`${label} Working directory: ` + dirPath)
    t.comment(`${label} Testing with use_gpu: ${deviceConfig.useGpu}`)

    const perfCollector = createPerformanceCollector()

    try {
      const modelPath = await ensureModel(dirPath)
      t.ok(modelPath, `${label} model path should be available`)
      t.comment(`${label} Model path: ` + modelPath)

      loader = new FilesystemDL({ dirPath })
      t.ok(loader, `${label} loader created`)

      const config = {
        beamsize: 4,
        lengthpenalty: 0.4,
        maxlength: 128,
        repetitionpenalty: 1.2,
        norepeatngramsize: 2,
        temperature: 0.8,
        topk: 40,
        topp: 0.9,
        use_gpu: deviceConfig.useGpu
      }

      const args = {
        loader,
        modelName: MODEL_NAME,
        params: {
          srcLang: 'en',
          dstLang: 'it'
        },
        logger: console,
        diskPath: dirPath,
        exclusiveRun: true,
        opts: { stats: true }
      }

      translation = new TranslationNmtcpp(args, config)
      t.ok(translation, `${label} translation engine created`)

      await translation.load()
      t.pass(`${label} model loaded successfully`)

      const inputText = 'Hello, how are you today?'
      t.comment(`${label} Translating: "` + inputText + '"')

      perfCollector.start()

      const response = await translation.run(inputText)

      await response
        .onUpdate(data => {
          perfCollector.onToken(data)
        })
        .await()

      const addonStats = response.stats || {}
      t.comment(`${label} Native addon stats: ` + JSON.stringify(addonStats))
      const metrics = perfCollector.getMetrics(inputText, addonStats)
      t.comment(formatPerformanceMetrics(`[GGML/Opus] ${label}`, metrics))

      t.ok(metrics.fullOutput.length > 0, `${label} translation should not be empty`)
      t.pass(`${label} GGML/Opus translation completed successfully`)
    } catch (err) {
      t.fail(`${label} GGML/Opus test failed: ` + err.message)
      console.error('[GGML] Error:', err)
      throw err
    } finally {
      if (translation) {
        try {
          await translation.unload()
          t.comment(`${label} Translation engine unloaded`)
        } catch (e) {
          t.comment(`${label} unload error: ` + e.message)
        }
        translation = null
      }
      if (loader) {
        try {
          await loader.close()
          t.comment(`${label} Loader closed`)
        } catch (e) {
          t.comment(`${label} loader.close error: ` + e.message)
        }
        loader = null
      }
    }
  })
}
