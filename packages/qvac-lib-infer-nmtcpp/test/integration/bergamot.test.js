'use strict'

/**
 * Bergamot Backend Integration Test
 *
 * Tests the Bergamot (intgemm quantized) translation backend with English to Italian translation.
 * Uses Mozilla's Bergamot project models optimized for CPU inference.
 *
 * Platform Behavior:
 *   - Mobile (iOS/Android): Downloads from presigned S3 URLs (configured in bergamot-urls.json)
 *   - Desktop: Uses local ../../model/bergamot/enit directory
 *
 * Usage:
 *   bare test/integration/bergamot.test.js
 */

const test = require('brittle')
const path = require('bare-path')
const fs = require('bare-fs')
const TranslationNmtcpp = require('@qvac/translation-nmtcpp')
const { ensureBergamotModel, createLogger, TEST_TIMEOUT } = require('./utils')

test('Bergamot backend - English to Italian translation', { timeout: TEST_TIMEOUT }, async function (t) {
  const modelDir = await ensureBergamotModel()
  t.ok(modelDir, 'Bergamot model path should be available')
  t.comment('Model directory: ' + modelDir)

  // Locate model and vocab files
  const files = fs.readdirSync(modelDir)
  const modelFile = files.find(f => f.includes('.intgemm') && f.includes('.bin'))
  const vocabFile = files.find(f => f.includes('.spm'))

  t.ok(modelFile, 'model file should exist')
  t.ok(vocabFile, 'vocab file should exist')

  const fullVocabPath = path.join(modelDir, vocabFile)

  /**
   * Local file loader for Bergamot model
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
        srcLang: 'en',
        dstLang: 'it'
      },
      diskPath: modelDir,
      modelName: modelFile,
      logger
    }, {
      modelType: TranslationNmtcpp.ModelTypes.Bergamot,
      srcVocabPath: fullVocabPath,
      dstVocabPath: fullVocabPath,
      beamsize: 1,
      normalize: 1,
      use_gpu: false
    })

    await model.load()
    t.pass('Bergamot model loaded successfully')

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
    t.pass('Bergamot translation completed successfully')
  } catch (e) {
    t.fail('Bergamot test failed: ' + e.message)
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
