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
 *   - Mobile (iOS/Android): Downloads from presigned S3 URL (configured in indictrans-model-urls.json)
 *   - Desktop: Uses local ../../model/indictrans directory
 *
 * Usage:
 *   bare test/integration/indictrans.test.js
 */

const test = require('brittle')
const path = require('bare-path')
const fs = require('bare-fs')
const TranslationNmtcpp = require('@qvac/translation-nmtcpp')
const { ensureIndicTransModel, createLogger, TEST_TIMEOUT } = require('./utils')

test('IndicTrans backend - English to Hindi translation', { timeout: TEST_TIMEOUT }, async function (t) {
  const modelPath = await ensureIndicTransModel()
  t.ok(modelPath, 'IndicTrans model path should be available')
  t.comment('Model path: ' + modelPath)

  const modelDir = path.dirname(modelPath)
  const modelName = path.basename(modelPath)

  /**
   * Local file loader for IndicTrans model
   * Provides synchronous file access for model loading
   */
  const localLoader = {
    ready: async () => {},
    close: async () => {},
    /**
     * Downloads/reads a file from the model directory
     * @param {string} filename - Name of file to read
     * @returns {Buffer} File contents
     */
    download: async (filename) => {
      const filePath = path.join(modelDir, filename)
      return fs.readFileSync(filePath)
    },
    /**
     * Gets file size for a file in the model directory
     * @param {string} filename - Name of file to check
     * @returns {number} File size in bytes
     */
    getFileSize: async (filename) => {
      const filePath = path.join(modelDir, filename)
      const stats = fs.statSync(filePath)
      return stats.size
    }
  }

  const logger = createLogger()
  let model

  try {
    model = new TranslationNmtcpp({
      loader: localLoader,
      params: {
        mode: 'full', // Use IndicProcessor for preprocessing
        srcLang: 'eng_Latn', // English (Latin script)
        dstLang: 'hin_Deva' // Hindi (Devanagari script)
      },
      diskPath: modelDir,
      modelName,
      logger
    }, {
      modelType: TranslationNmtcpp.ModelTypes.IndicTrans,
      use_gpu: false
    })

    await model.load()
    t.pass('IndicTrans model loaded successfully')

    const testSentence = 'Hello, how are you?'
    t.comment('Translating: "' + testSentence + '"')

    const response = await model.run(testSentence)
    let translation = ''

    await response
      .onUpdate(data => {
        translation += data
      })
      .await()

    t.ok(translation.length > 0, 'translation should not be empty')
    t.comment('Translation output: ' + translation)
    t.pass('IndicTrans translation completed successfully')
  } catch (e) {
    t.fail('IndicTrans test failed: ' + e.message)
    throw e
  } finally {
    // Cleanup: unload model
    if (model) {
      try {
        await model.unload()
      } catch (e) {
        t.comment('unload() error: ' + e.message)
      }
    }
  }
})
