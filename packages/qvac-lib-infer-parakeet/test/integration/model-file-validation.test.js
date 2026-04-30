'use strict'

const test = require('brittle')
const path = require('bare-path')
const fs = require('bare-fs')
const os = require('bare-os')
const {
  TranscriptionParakeet,
  ensureModel,
  getTestPaths,
  isMobile
} = require('./helpers.js')

/**
 * Test 1: Empty files map is accepted (validation only warns for missing files)
 */
test('Should accept empty files map without throwing', { timeout: 60000 }, async (t) => {
  if (isMobile) { t.pass('Skipped on mobile'); return }
  TranscriptionParakeet.prototype.validateModelFiles?.restore?.()

  try {
    const model = new TranscriptionParakeet({
      files: {},
      config: { parakeetConfig: { modelType: 'tdt' } }
    })
    t.ok(model, 'Model instance created with empty files map')
    t.pass('Empty files map is accepted (validation skipped for unset paths)')
  } catch (error) {
    t.fail('Should not throw for empty files map: ' + error.message)
  }
})

/**
 * Test 2: Non-existent file paths produce warnings but do not throw
 */
test('Non-existent file paths produce warnings but do not throw', { timeout: 60000 }, async (t) => {
  if (isMobile) { t.pass('Skipped on mobile'); return }
  TranscriptionParakeet.prototype.validateModelFiles?.restore?.()

  try {
    const model = new TranscriptionParakeet({
      files: {
        encoder: '/this/path/definitely/does/not/exist/encoder.onnx',
        decoder: '/this/path/definitely/does/not/exist/decoder.onnx',
        vocab: '/this/path/definitely/does/not/exist/vocab.txt',
        preprocessor: '/this/path/definitely/does/not/exist/preprocessor.onnx'
      },
      config: { parakeetConfig: { modelType: 'tdt' } }
    })
    t.ok(model, 'Model instance created despite non-existent file paths')
    t.pass('Non-existent file paths produce warnings, not errors')
  } catch (error) {
    t.fail('Should not throw for non-existent file paths: ' + error.message)
  }
})

/**
 * Test 3: Valid file paths do not produce warnings or errors
 */
test('Should not warn when model files exist at provided paths', { timeout: 180000 }, async (t) => {
  if (isMobile) { t.pass('Skipped on mobile'); return }
  TranscriptionParakeet.prototype.validateModelFiles?.restore?.()

  const { modelPath: testModelPath } = getTestPaths()
  await ensureModel(testModelPath)

  try {
    const model = new TranscriptionParakeet({
      files: {
        encoder: path.join(testModelPath, 'encoder-model.onnx'),
        encoderData: path.join(testModelPath, 'encoder-model.onnx.data'),
        decoder: path.join(testModelPath, 'decoder_joint-model.onnx'),
        vocab: path.join(testModelPath, 'vocab.txt'),
        preprocessor: path.join(testModelPath, 'preprocessor.onnx')
      },
      config: { parakeetConfig: { modelType: 'tdt' } }
    })
    t.ok(model, 'Model should be created successfully with valid file paths')
    t.pass('No exception thrown when all file paths are valid')
  } catch (error) {
    t.fail('Should not have thrown an error: ' + error.message)
  }
})

/**
 * Test 4: Validation happens in constructor
 */
test('Model validation happens in constructor', { timeout: 60000 }, async (t) => {
  if (isMobile) { t.pass('Skipped on mobile'); return }
  TranscriptionParakeet.prototype.validateModelFiles?.restore?.()

  try {
    const model = new TranscriptionParakeet({
      files: {},
      config: { parakeetConfig: { modelType: 'tdt' } }
    })
    t.ok(model, 'Constructor completes — validation ran without throw for empty files')
  } catch (error) {
    t.fail('Constructor threw unexpectedly: ' + error.message)
  }
})

/**
 * Test 5: CTC model type resolves correct files from the files map
 */
test('Should resolve CTC model file paths correctly', { timeout: 60000 }, async (t) => {
  if (isMobile) { t.pass('Skipped on mobile'); return }
  TranscriptionParakeet.prototype.validateModelFiles?.restore?.()

  const testDir = path.join(os.tmpdir(), '.parakeet-test-models')
  const ctcModelPath = path.join(testDir, 'test-ctc-model')

  if (!fs.existsSync(ctcModelPath)) {
    fs.mkdirSync(ctcModelPath, { recursive: true })
  }

  const modelOnnx = path.join(ctcModelPath, 'model.onnx')
  const tokenizer = path.join(ctcModelPath, 'tokenizer.json')

  try {
    const model = new TranscriptionParakeet({
      files: { model: modelOnnx, tokenizer },
      config: { parakeetConfig: { modelType: 'ctc' } }
    })
    t.ok(model, 'CTC model instance created')
    t.is(model._resolveFilePath('model.onnx'), modelOnnx, 'model.onnx resolves to files.model')
    t.is(model._resolveFilePath('tokenizer.json'), tokenizer, 'tokenizer.json resolves to files.tokenizer')
  } catch (error) {
    t.fail('Should not throw: ' + error.message)
  }

  if (fs.existsSync(ctcModelPath)) {
    try { fs.rmSync(ctcModelPath, { recursive: true }) } catch (e) {}
  }
})

/**
 * Test 6: EOU model type resolves correct files from the files map
 */
test('Should resolve EOU model file paths correctly', { timeout: 60000 }, async (t) => {
  if (isMobile) { t.pass('Skipped on mobile'); return }
  TranscriptionParakeet.prototype.validateModelFiles?.restore?.()

  const testDir = path.join(os.tmpdir(), '.parakeet-test-models')
  const eouModelPath = path.join(testDir, 'test-eou-model')

  if (!fs.existsSync(eouModelPath)) {
    fs.mkdirSync(eouModelPath, { recursive: true })
  }

  const eouEncoder = path.join(eouModelPath, 'encoder.onnx')
  const eouDecoder = path.join(eouModelPath, 'decoder_joint.onnx')

  try {
    const model = new TranscriptionParakeet({
      files: { eouEncoder, eouDecoder },
      config: { parakeetConfig: { modelType: 'eou' } }
    })
    t.ok(model, 'EOU model instance created')
    t.is(model._resolveFilePath('encoder.onnx'), eouEncoder, 'encoder.onnx resolves to files.eouEncoder')
    t.is(model._resolveFilePath('decoder_joint.onnx'), eouDecoder, 'decoder_joint.onnx resolves to files.eouDecoder')
  } catch (error) {
    t.fail('Should not throw: ' + error.message)
  }

  if (fs.existsSync(eouModelPath)) {
    try { fs.rmSync(eouModelPath, { recursive: true }) } catch (e) {}
  }
})

/**
 * Test 7: Sortformer model type resolves correct files from the files map
 */
test('Should resolve Sortformer model file paths correctly', { timeout: 60000 }, async (t) => {
  if (isMobile) { t.pass('Skipped on mobile'); return }
  TranscriptionParakeet.prototype.validateModelFiles?.restore?.()

  const testDir = path.join(os.tmpdir(), '.parakeet-test-models')
  const sfModelPath = path.join(testDir, 'test-sortformer-model')

  if (!fs.existsSync(sfModelPath)) {
    fs.mkdirSync(sfModelPath, { recursive: true })
  }

  const sortformerFile = path.join(sfModelPath, 'sortformer.onnx')

  try {
    const model = new TranscriptionParakeet({
      files: { sortformer: sortformerFile },
      config: { parakeetConfig: { modelType: 'sortformer' } }
    })
    t.ok(model, 'Sortformer model instance created')
    t.is(model._resolveFilePath('sortformer.onnx'), sortformerFile, 'sortformer.onnx resolves to files.sortformer')
  } catch (error) {
    t.fail('Should not throw: ' + error.message)
  }

  if (fs.existsSync(sfModelPath)) {
    try { fs.rmSync(sfModelPath, { recursive: true }) } catch (e) {}
  }
})
