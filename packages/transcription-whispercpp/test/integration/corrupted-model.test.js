'use strict'

const test = require('brittle')
const path = require('bare-path')
const fs = require('bare-fs')
const os = require('bare-os')
const { Readable } = require('bare-stream')
const TranscriptionWhispercpp = require('../../index.js')
const FakeDL = require('../mocks/loader.fake.js')
const { setupJsLogger, ensureWhisperModel, isMobile } = require('./helpers.js')

function createLoader () {
  return new FakeDL({})
}

/**
 * Helper function to test that corrupted model files throw exceptions
 */
async function testCorruptedModelFile (t, { corruptedFilePath, constructorArgs, config }) {
  let loggerBinding = null
  if (!isMobile) {
    loggerBinding = setupJsLogger()
  }
  let model
  let exceptionThrown = false

  try {
    model = new TranscriptionWhispercpp(constructorArgs, config)
    await model._load()

    const audioData = new Uint8Array(1600)
    const audioStream = new Readable({
      read () {
        this.push(Buffer.from(audioData))
        this.push(null)
      }
    })

    const response = await model.run(audioStream)

    // Iterate over results - this should throw if there's an error
    // eslint-disable-next-line no-unused-vars
    for await (const output of response.iterate()) {
      // If we get any output, that would be unexpected
    }

    // If we get here without exception, the test should FAIL
    t.fail('Should have thrown an exception for corrupted model')
  } catch (error) {
    exceptionThrown = true
    console.log(`Expected error caught: ${error.message}`)
  } finally {
    // Clean up corrupted file
    if (fs.existsSync(corruptedFilePath)) {
      try {
        fs.unlinkSync(corruptedFilePath)
      } catch (e) {
        console.log('Could not delete corrupted file:', e.message)
      }
    }
    // Clean up model
    if (model) {
      try {
        await model.destroy()
      } catch (e) {
        // ignore cleanup errors
      }
    }
    // Clean up logger
    if (loggerBinding) {
      try {
        loggerBinding.releaseLogger()
      } catch (e) {
      // ignore
      }
    }
  }

  t.ok(exceptionThrown, 'An exception should have been thrown for corrupted model')
}

/**
 * Test corrupted Whisper model file
 * Works on both mobile and desktop
 */
test('Corrupted model file should throw exception to JavaScript', { timeout: 30000 }, async (t) => {
  const testDir = isMobile ? path.join(global.testDir || os.tmpdir(), '.test-models') : path.join(__dirname, '../.test-models')
  const corruptedModelPath = path.join(testDir, 'corrupted-model.bin')

  if (!fs.existsSync(testDir)) {
    fs.mkdirSync(testDir, { recursive: true })
  }

  fs.writeFileSync(corruptedModelPath, 'This is not a valid GGML model file')
  t.ok(fs.existsSync(corruptedModelPath), 'Corrupted model file should exist')

  await testCorruptedModelFile(t, {
    corruptedFilePath: corruptedModelPath,
    constructorArgs: {
      modelName: path.basename(corruptedModelPath),
      diskPath: testDir,
      loader: createLoader()
    },
    config: {
      whisperConfig: { language: 'en' },
      contextParams: { model: corruptedModelPath },
      miscConfig: { caption_enabled: false }
    }
  })
})

/**
 * Test corrupted VAD model file
 * Works on both mobile and desktop
 */
test('Corrupted VAD model file should throw exception to JavaScript', { timeout: 180000 }, async (t) => {
  const testDir = isMobile ? path.join(global.testDir || os.tmpdir(), '.test-models') : path.join(__dirname, '../.test-models')
  const corruptedVadPath = path.join(testDir, 'corrupted-vad-model.bin')

  // Ensure we have a valid whisper model
  const modelsDir = isMobile ? path.join(global.testDir || os.tmpdir(), 'models') : path.resolve(__dirname, '../../examples/models')
  const validModelPath = path.join(modelsDir, 'ggml-tiny.bin')

  // Download the model if needed
  const modelResult = await ensureWhisperModel(validModelPath)
  if (!modelResult.success) {
    console.log('⚠️ Could not download model, skipping test')
    t.pass('Test skipped - model not available')
    return
  }

  t.ok(fs.existsSync(validModelPath), 'Valid whisper model should exist')

  if (!fs.existsSync(testDir)) {
    fs.mkdirSync(testDir, { recursive: true })
  }

  fs.writeFileSync(corruptedVadPath, 'This is not a valid VAD model file')
  t.ok(fs.existsSync(corruptedVadPath), 'Corrupted VAD model file should exist')

  await testCorruptedModelFile(t, {
    corruptedFilePath: corruptedVadPath,
    constructorArgs: {
      modelName: path.basename(validModelPath),
      diskPath: path.dirname(validModelPath),
      loader: createLoader()
    },
    config: {
      whisperConfig: {
        language: 'en',
        vad_model_path: corruptedVadPath
      },
      vad_model_path: corruptedVadPath,
      contextParams: { model: validModelPath },
      miscConfig: { caption_enabled: false }
    }
  })
})
