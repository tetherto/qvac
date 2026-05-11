'use strict'

const test = require('brittle')
const TranscriptionWhispercpp = require('../../index.js')
const path = require('bare-path')
const os = require('bare-os')
const { ensureWhisperModel, ensureVADModel, isMobile } = require('./helpers.js')

const tmpDir = isMobile ? (global.testDir || os.tmpdir()) : os.tmpdir()
const testModelPath = path.join(tmpDir, 'qvac-test-models', 'ggml-tiny.bin')
const testVadPath = path.join(tmpDir, 'qvac-test-models', 'ggml-silero-v5.1.2.bin')

let modelsReady = false

async function ensureModelsDownloaded () {
  if (modelsReady) return

  await ensureWhisperModel(testModelPath)
  await ensureVADModel(testVadPath)
  modelsReady = true
}

/**
 * Test 1: If files.model is not provided, an exception should be thrown
 * Works on both mobile and desktop - just tests constructor validation
 */
test('Should throw error when files.model is not provided', { timeout: 60000 }, async (t) => {
  // Restore any stubs from other tests
  TranscriptionWhispercpp.prototype.validateModelFiles?.restore?.()

  const args = {}
  const config = {
    whisperConfig: {
      language: 'en'
    },
    contextParams: {
      model: ''
    },
    miscConfig: {
      caption_enabled: false
    }
  }

  try {
    new TranscriptionWhispercpp(args, config) // eslint-disable-line no-new
    t.fail('Should have thrown an error for missing files.model')
  } catch (error) {
    t.ok(error.message.includes('files.model'), 'Error message should mention files.model')
  }
})

/**
 * Test 2: If the model path is provided but the file doesn't exist, an exception should be thrown
 * Works on both mobile and desktop
 */
test('Should throw error when model file does not exist', { timeout: 60000 }, async (t) => {
  // Restore any stubs from other tests
  TranscriptionWhispercpp.prototype.validateModelFiles?.restore?.()

  const nonexistent = path.join(tmpDir, 'qvac-test-models', 'non-existent-model.bin')
  const args = {
    files: {
      model: nonexistent
    }
  }
  const config = {
    whisperConfig: {
      language: 'en'
    },
    contextParams: {
      model: nonexistent
    },
    miscConfig: {
      caption_enabled: false
    }
  }

  try {
    new TranscriptionWhispercpp(args, config) // eslint-disable-line no-new
    t.fail('Should have thrown an error for non-existent model file')
  } catch (error) {
    t.ok(error.message.includes('Model file doesn\'t exist'), 'Error message should mention model file doesn\'t exist')
    t.ok(error.message.includes('non-existent-model.bin'), 'Error message should include the model filename')
  }
})

/**
 * Test 3: If the VAD model path is provided but the file doesn't exist, an exception should be thrown
 * Works on both mobile and desktop
 */
test('Should throw error when VAD model file does not exist', { timeout: 180000 }, async (t) => {
  // Restore any stubs from other tests
  TranscriptionWhispercpp.prototype.validateModelFiles?.restore?.()

  // Ensure model is downloaded
  await ensureModelsDownloaded()

  const args = {
    files: {
      model: testModelPath
    }
  }
  const config = {
    whisperConfig: {
      language: 'en',
      vad_model_path: 'non-existent-vad-model.bin' // Non-existent VAD model
    },
    contextParams: {
      model: testModelPath
    },
    miscConfig: {
      caption_enabled: false
    }
  }

  try {
    new TranscriptionWhispercpp(args, config) // eslint-disable-line no-new
    t.fail('Should have thrown an error for non-existent VAD model file')
  } catch (error) {
    t.ok(error.message.includes('VAD model file not found'), 'Error message should mention VAD model file doesn\'t exist')
    t.ok(error.message.includes('non-existent-vad-model.bin'), 'Error message should include the VAD model filename')
  }
})

/**
 * Test 4: If model path is valid and VAD path is not provided, no exception should be thrown
 * Works on both mobile and desktop
 */
test('Should not throw error when model file exists and VAD is not specified', { timeout: 180000 }, async (t) => {
  // Restore any stubs from other tests
  TranscriptionWhispercpp.prototype.validateModelFiles?.restore?.()

  // Ensure model is downloaded
  await ensureModelsDownloaded()

  const args = {
    files: {
      model: testModelPath
    }
  }
  const config = {
    whisperConfig: {
      language: 'en'
      // No vad_model_path specified
    },
    contextParams: {
      model: testModelPath
    },
    miscConfig: {
      caption_enabled: false
    }
  }

  try {
    const model = new TranscriptionWhispercpp(args, config)
    t.ok(model, 'Model should be created successfully')
    t.pass('No exception thrown when model file exists and VAD is not specified')
  } catch (error) {
    t.fail('Should not have thrown an error: ' + error.message)
  }
})

/**
 * Test 5: If both model path and VAD model path are valid, no exception should be thrown
 * Works on both mobile and desktop
 */
test('Should not throw error when both model and VAD model files exist', { timeout: 180000 }, async (t) => {
  // Restore any stubs from other tests
  TranscriptionWhispercpp.prototype.validateModelFiles?.restore?.()

  // Ensure models are downloaded
  await ensureModelsDownloaded()

  const args = {
    files: {
      model: testModelPath,
      vadModel: testVadPath
    }
  }
  const config = {
    whisperConfig: {
      language: 'en',
      vad_model_path: testVadPath
    },
    contextParams: {
      model: testModelPath
    },
    miscConfig: {
      caption_enabled: false
    }
  }

  try {
    const model = new TranscriptionWhispercpp(args, config)
    t.ok(model, 'Model should be created successfully')
    t.pass('No exception thrown when both model and VAD model files exist')
  } catch (error) {
    t.fail('Should not have thrown an error: ' + error.message)
  }
})
