'use strict'

const test = require('brittle')
const path = require('bare-path')
const fs = require('bare-fs')
const os = require('bare-os')
const binding = require('../../binding')
const { ParakeetInterface } = require('../../parakeet')
const { setupJsLogger, getNamedPathsConfig, isMobile } = require('./helpers.js')

/**
 * Helper function to create a test directory with corrupted model files
 * @param {string} testDir - Directory to create files in
 * @param {Object} options - File content options
 * @returns {string} Path to the model directory
 */
function createCorruptedModelDir (testDir, options = {}) {
  const modelDir = path.join(testDir, 'corrupted-model')

  if (!fs.existsSync(modelDir)) {
    fs.mkdirSync(modelDir, { recursive: true })
  }

  // Create corrupted files with invalid content
  const files = {
    'encoder-model.onnx': options.encoder || 'This is not a valid ONNX model file - corrupted encoder data',
    'encoder-model.onnx.data': options.encoderData || 'Corrupted encoder weights data',
    'decoder_joint-model.onnx': options.decoder || 'This is not a valid ONNX decoder model',
    'vocab.txt': options.vocab || '▁the 0\n▁a 1\n▁is 2\n</s> 3\n<pad> 4',
    'preprocessor.onnx': options.preprocessor || 'Corrupted preprocessor model'
  }

  for (const [filename, content] of Object.entries(files)) {
    const filePath = path.join(modelDir, filename)
    fs.writeFileSync(filePath, content)
  }

  return modelDir
}

/**
 * Helper function to clean up test directory
 * @param {string} dirPath - Directory to remove
 */
function cleanupTestDir (dirPath) {
  if (fs.existsSync(dirPath)) {
    try {
      const files = fs.readdirSync(dirPath)
      for (const file of files) {
        const filePath = path.join(dirPath, file)
        fs.unlinkSync(filePath)
      }
      fs.rmSync(dirPath, { recursive: true })
    } catch (e) {
      // Ignore cleanup errors
    }
  }
}

/**
 * Test that corrupted model files throw an error event to JavaScript.
 * After the C++ fix, ONNX Runtime errors should be propagated as Error events.
 */
test('Corrupted model files should emit Error event to JavaScript', { timeout: 60000 }, async (t) => {
  const testDir = isMobile
    ? path.join(global.testDir || os.tmpdir(), '.test-corrupted-models')
    : path.join(os.tmpdir(), '.parakeet-test-corrupted-models')

  const modelDir = createCorruptedModelDir(testDir)
  const loggerBinding = setupJsLogger(binding)

  console.log('\n=== Testing Corrupted Model Error Propagation ===')
  console.log(`   Model directory: ${modelDir}`)

  // Track events received from the addon
  const events = []
  let errorReceived = false
  let errorMessage = ''
  let resolvePromise = null
  const waitForError = new Promise(resolve => { resolvePromise = resolve })

  function outputCallback (handle, event, id, output, error) {
    events.push({ event, id, output, error })
    console.log(`   Event received: ${event}, error: ${error || 'none'}`)

    if (event === 'Error') {
      errorReceived = true
      errorMessage = error || ''
      resolvePromise()
    }
  }

  let parakeet = null

  try {
    const config = {
      modelPath: modelDir,
      modelType: 'tdt',
      maxThreads: 4,
      useGPU: false,
      sampleRate: 16000,
      channels: 1,
      ...getNamedPathsConfig('tdt', modelDir)
    }

    parakeet = new ParakeetInterface(binding, config, outputCallback)

    // Try to activate - this should trigger model loading and fail on corrupted files
    await parakeet.activate()

    // Wait for error event with timeout
    const timeout = setTimeout(() => resolvePromise(), 5000)
    await waitForError
    clearTimeout(timeout)
  } catch (error) {
    // If an exception is thrown directly, that's also acceptable
    errorReceived = true
    errorMessage = error.message
    console.log(`   Exception caught: ${error.message}`)
  } finally {
    if (parakeet) {
      try {
        await parakeet.destroyInstance()
        console.log('   Instance destroyed successfully')
      } catch (e) {
        console.log('   Instance destroy note:', e.message)
      }
    }
    try {
      loggerBinding.releaseLogger()
    } catch (e) {
      // Ignore
    }
    cleanupTestDir(modelDir)
    cleanupTestDir(testDir)
  }

  console.log(`\n   Total events received: ${events.length}`)
  console.log(`   Error received: ${errorReceived}`)
  if (errorMessage) {
    console.log(`   Error message: ${errorMessage}`)
  }

  t.ok(errorReceived, 'Should receive an Error event or exception for corrupted model')
  if (errorMessage) {
    t.ok(
      errorMessage.includes('ONNX') ||
      errorMessage.includes('protobuf') ||
      errorMessage.includes('Failed to load') ||
      errorMessage.includes('parsing failed'),
      'Error message should mention ONNX or model loading failure'
    )
  }
})

/**
 * Test that empty model files throw an error event to JavaScript.
 */
test('Empty model files should emit Error event to JavaScript', { timeout: 60000 }, async (t) => {
  const testDir = isMobile
    ? path.join(global.testDir || os.tmpdir(), '.test-empty-models')
    : path.join(os.tmpdir(), '.parakeet-test-empty-models')

  const modelDir = path.join(testDir, 'empty-model')
  if (!fs.existsSync(modelDir)) {
    fs.mkdirSync(modelDir, { recursive: true })
  }

  // Create empty files
  const files = [
    'encoder-model.onnx',
    'encoder-model.onnx.data',
    'decoder_joint-model.onnx',
    'vocab.txt',
    'preprocessor.onnx'
  ]

  for (const file of files) {
    fs.writeFileSync(path.join(modelDir, file), '')
  }

  const loggerBinding = setupJsLogger(binding)

  console.log('\n=== Testing Empty Model Error Propagation ===')
  console.log(`   Model directory: ${modelDir}`)

  // Track events
  const events = []
  let errorReceived = false
  let errorMessage = ''
  let resolvePromise = null
  const waitForError = new Promise(resolve => { resolvePromise = resolve })

  function outputCallback (handle, event, id, output, error) {
    events.push({ event, id, output, error })
    console.log(`   Event received: ${event}, error: ${error || 'none'}`)

    if (event === 'Error') {
      errorReceived = true
      errorMessage = error || ''
      resolvePromise()
    }
  }

  let parakeet = null

  try {
    const config = {
      modelPath: modelDir,
      modelType: 'tdt',
      maxThreads: 4,
      useGPU: false,
      sampleRate: 16000,
      channels: 1,
      ...getNamedPathsConfig('tdt', modelDir)
    }

    parakeet = new ParakeetInterface(binding, config, outputCallback)

    // Try to activate - C++ will load empty files from named paths and fail
    await parakeet.activate()

    // Wait for error event with timeout
    const timeout = setTimeout(() => resolvePromise(), 5000)
    await waitForError
    clearTimeout(timeout)
  } catch (error) {
    errorReceived = true
    errorMessage = error.message
    console.log(`   Exception caught: ${error.message}`)
  } finally {
    if (parakeet) {
      try {
        await parakeet.destroyInstance()
        console.log('   Instance destroyed successfully')
      } catch (e) {
        console.log('   Instance destroy note:', e.message)
      }
    }
    try {
      loggerBinding.releaseLogger()
    } catch (e) {
      // Ignore
    }
    cleanupTestDir(modelDir)
    cleanupTestDir(testDir)
  }

  console.log(`\n   Total events received: ${events.length}`)
  console.log(`   Error received: ${errorReceived}`)
  if (errorMessage) {
    console.log(`   Error message: ${errorMessage}`)
  }

  t.ok(errorReceived, 'Should receive an Error event or exception for empty model files')
})

/**
 * Test that truncated model files throw an error event to JavaScript.
 */
test('Truncated model files should emit Error event to JavaScript', { timeout: 60000 }, async (t) => {
  const testDir = isMobile
    ? path.join(global.testDir || os.tmpdir(), '.test-truncated-models')
    : path.join(os.tmpdir(), '.parakeet-test-truncated-models')

  const modelDir = path.join(testDir, 'truncated-model')
  if (!fs.existsSync(modelDir)) {
    fs.mkdirSync(modelDir, { recursive: true })
  }

  // Create truncated files with partial data
  const truncatedOnnx = Buffer.from([0x08, 0x00, 0x00, 0x00])
  const truncatedData = Buffer.alloc(100).fill(0xFF)

  fs.writeFileSync(path.join(modelDir, 'encoder-model.onnx'), truncatedOnnx)
  fs.writeFileSync(path.join(modelDir, 'encoder-model.onnx.data'), truncatedData)
  fs.writeFileSync(path.join(modelDir, 'decoder_joint-model.onnx'), truncatedOnnx)
  fs.writeFileSync(path.join(modelDir, 'vocab.txt'), '▁test 0\n')
  fs.writeFileSync(path.join(modelDir, 'preprocessor.onnx'), truncatedOnnx)

  const loggerBinding = setupJsLogger(binding)

  console.log('\n=== Testing Truncated Model Error Propagation ===')
  console.log(`   Model directory: ${modelDir}`)

  // Track events
  const events = []
  let errorReceived = false
  let errorMessage = ''
  let resolvePromise = null
  const waitForError = new Promise(resolve => { resolvePromise = resolve })

  function outputCallback (handle, event, id, output, error) {
    events.push({ event, id, output, error })
    console.log(`   Event received: ${event}, error: ${error || 'none'}`)

    if (event === 'Error') {
      errorReceived = true
      errorMessage = error || ''
      resolvePromise()
    }
  }

  let parakeet = null

  try {
    const config = {
      modelPath: modelDir,
      modelType: 'tdt',
      maxThreads: 4,
      useGPU: false,
      sampleRate: 16000,
      channels: 1,
      ...getNamedPathsConfig('tdt', modelDir)
    }

    parakeet = new ParakeetInterface(binding, config, outputCallback)

    // Try to activate - C++ will load truncated files from named paths and fail
    await parakeet.activate()

    // Wait for error event with timeout
    const timeout = setTimeout(() => resolvePromise(), 5000)
    await waitForError
    clearTimeout(timeout)
  } catch (error) {
    errorReceived = true
    errorMessage = error.message
    console.log(`   Exception caught: ${error.message}`)
  } finally {
    if (parakeet) {
      try {
        await parakeet.destroyInstance()
        console.log('   Instance destroyed successfully')
      } catch (e) {
        console.log('   Instance destroy note:', e.message)
      }
    }
    try {
      loggerBinding.releaseLogger()
    } catch (e) {
      // Ignore
    }
    cleanupTestDir(modelDir)
    cleanupTestDir(testDir)
  }

  console.log(`\n   Total events received: ${events.length}`)
  console.log(`   Error received: ${errorReceived}`)
  if (errorMessage) {
    console.log(`   Error message: ${errorMessage}`)
  }

  t.ok(errorReceived, 'Should receive an Error event or exception for truncated model files')
})
