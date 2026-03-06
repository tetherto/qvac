'use strict'

const test = require('brittle')
const path = require('bare-path')
const fs = require('bare-fs')
const TranscriptionParakeet = require('../../index.js')
const FakeDL = require('../mocks/loader.fake.js')
const { getTestPaths, ensureModel, ensureModelForType } = require('./helpers.js')

function createLoader () {
  return new FakeDL({})
}

test('CTC with named file paths — constructor accepts and validates', { timeout: 60000 }, async (t) => {
  TranscriptionParakeet.prototype.validateModelFiles?.restore?.()

  const modelDir = await ensureModelForType('ctc')
  if (!modelDir) { t.pass('CTC model not available — skipping'); return }

  const ctcModelPath = path.join(modelDir, 'model.onnx')
  const ctcModelDataPath = path.join(modelDir, 'model.onnx_data')
  const tokenizerPath = path.join(modelDir, 'tokenizer.json')

  const args = {
    modelName: 'ctc-named-test',
    diskPath: '/nonexistent',
    loader: createLoader()
  }
  const config = {
    ctcModelPath,
    ctcModelDataPath,
    tokenizerPath,
    parakeetConfig: { modelType: 'ctc' }
  }

  const model = new TranscriptionParakeet(args, config)
  t.ok(model, 'CTC model created with named paths (no directory throw)')
  t.ok(model._hasAnyNamedPaths(), '_hasAnyNamedPaths returns true for CTC paths')
  t.ok(!model._hasNamedPaths(), '_hasNamedPaths returns false (TDT-only)')

  const resolved = model._resolveFilePath('', 'model.onnx')
  t.is(resolved, ctcModelPath, '_resolveFilePath maps model.onnx to ctcModelPath')

  const resolvedTok = model._resolveFilePath('', 'tokenizer.json')
  t.is(resolvedTok, tokenizerPath, '_resolveFilePath maps tokenizer.json to tokenizerPath')
})

test('CTC with named file paths — full load and transcription', { timeout: 600000 }, async (t) => {
  TranscriptionParakeet.prototype.validateModelFiles?.restore?.()

  const modelDir = await ensureModelForType('ctc')
  if (!modelDir) { t.pass('CTC model not available — skipping'); return }

  const { samplesDir } = getTestPaths()
  const samplePath = path.join(samplesDir, 'sample.raw')
  if (!fs.existsSync(samplePath)) { t.pass('sample.raw not found — skipping'); return }

  const args = {
    modelName: 'ctc-named-test',
    loader: createLoader()
  }
  const config = {
    path: modelDir,
    ctcModelPath: path.join(modelDir, 'model.onnx'),
    ctcModelDataPath: path.join(modelDir, 'model.onnx_data'),
    tokenizerPath: path.join(modelDir, 'tokenizer.json'),
    parakeetConfig: { modelType: 'ctc', maxThreads: 4, useGPU: false }
  }

  const model = new TranscriptionParakeet(args, config)

  try {
    await model._load()

    const rawBuffer = fs.readFileSync(samplePath)
    const pcm = new Int16Array(rawBuffer.buffer, rawBuffer.byteOffset, rawBuffer.length / 2)
    const audioData = new Float32Array(pcm.length)
    for (let i = 0; i < pcm.length; i++) audioData[i] = pcm[i] / 32768.0

    const audioStream = (async function * () {
      yield audioData
    })()

    const response = await model.run(audioStream)
    const segments = []
    await response.onUpdate((output) => {
      const items = Array.isArray(output) ? output : [output]
      segments.push(...items)
    }).await()

    const fullText = segments.map(s => s?.text || '').join(' ').trim()
    console.log(`[ctc-named] Result: "${fullText.substring(0, 100)}..."`)

    t.ok(fullText.length > 10, `CTC named paths produced text (${fullText.length} chars)`)
    t.ok(fullText.toLowerCase().includes('alice'), 'CTC transcription includes expected content')
  } finally {
    try { await model.unload() } catch (e) {}
  }
})

test('EOU with named file paths — constructor accepts and validates', { timeout: 60000 }, async (t) => {
  TranscriptionParakeet.prototype.validateModelFiles?.restore?.()

  const modelDir = await ensureModelForType('eou')
  if (!modelDir) { t.pass('EOU model not available — skipping'); return }

  const eouEncoderPath = path.join(modelDir, 'encoder.onnx')
  const eouDecoderPath = path.join(modelDir, 'decoder_joint.onnx')
  const tokenizerPath = path.join(modelDir, 'tokenizer.json')

  const args = {
    modelName: 'eou-named-test',
    diskPath: '/nonexistent',
    loader: createLoader()
  }
  const config = {
    eouEncoderPath,
    eouDecoderPath,
    tokenizerPath,
    parakeetConfig: { modelType: 'eou' }
  }

  const model = new TranscriptionParakeet(args, config)
  t.ok(model, 'EOU model created with named paths (no directory throw)')
  t.ok(model._hasAnyNamedPaths(), '_hasAnyNamedPaths returns true for EOU paths')
  t.ok(!model._hasNamedPaths(), '_hasNamedPaths returns false (TDT-only)')

  const resolved = model._resolveFilePath('', 'encoder.onnx')
  t.is(resolved, eouEncoderPath, '_resolveFilePath maps encoder.onnx to eouEncoderPath')

  const resolvedDec = model._resolveFilePath('', 'decoder_joint.onnx')
  t.is(resolvedDec, eouDecoderPath, '_resolveFilePath maps decoder_joint.onnx to eouDecoderPath')
})

test('EOU with named file paths — full load and transcription', { timeout: 600000 }, async (t) => {
  TranscriptionParakeet.prototype.validateModelFiles?.restore?.()

  const modelDir = await ensureModelForType('eou')
  if (!modelDir) { t.pass('EOU model not available — skipping'); return }

  const { samplesDir } = getTestPaths()
  const samplePath = path.join(samplesDir, 'sample.raw')
  if (!fs.existsSync(samplePath)) { t.pass('sample.raw not found — skipping'); return }

  const args = {
    modelName: 'eou-named-test',
    loader: createLoader()
  }
  const config = {
    path: modelDir,
    eouEncoderPath: path.join(modelDir, 'encoder.onnx'),
    eouDecoderPath: path.join(modelDir, 'decoder_joint.onnx'),
    tokenizerPath: path.join(modelDir, 'tokenizer.json'),
    parakeetConfig: { modelType: 'eou', maxThreads: 4, useGPU: false }
  }

  const model = new TranscriptionParakeet(args, config)

  try {
    await model._load()

    const rawBuffer = fs.readFileSync(samplePath)
    const pcm = new Int16Array(rawBuffer.buffer, rawBuffer.byteOffset, rawBuffer.length / 2)
    const audioData = new Float32Array(pcm.length)
    for (let i = 0; i < pcm.length; i++) audioData[i] = pcm[i] / 32768.0

    const audioStream = (async function * () {
      yield audioData
    })()

    const response = await model.run(audioStream)
    const segments = []
    await response.onUpdate((output) => {
      const items = Array.isArray(output) ? output : [output]
      segments.push(...items)
    }).await()

    const fullText = segments.map(s => s?.text || '').join(' ').trim()
    console.log(`[eou-named] Result: "${fullText.substring(0, 100)}..."`)

    t.ok(fullText.length > 0, `EOU named paths produced text (${fullText.length} chars)`)
  } finally {
    try { await model.unload() } catch (e) {}
  }
})

test('Sortformer with named file paths — constructor accepts and validates', { timeout: 60000 }, async (t) => {
  TranscriptionParakeet.prototype.validateModelFiles?.restore?.()

  const modelDir = await ensureModelForType('sortformer')
  if (!modelDir) { t.pass('Sortformer model not available — skipping'); return }

  const sortformerPath = path.join(modelDir, 'sortformer.onnx')

  const args = {
    modelName: 'sf-named-test',
    diskPath: '/nonexistent',
    loader: createLoader()
  }
  const config = {
    sortformerPath,
    parakeetConfig: { modelType: 'sortformer' }
  }

  const model = new TranscriptionParakeet(args, config)
  t.ok(model, 'Sortformer model created with named paths (no directory throw)')
  t.ok(model._hasAnyNamedPaths(), '_hasAnyNamedPaths returns true for Sortformer paths')
  t.ok(!model._hasNamedPaths(), '_hasNamedPaths returns false (TDT-only)')

  const resolved = model._resolveFilePath('', 'sortformer.onnx')
  t.is(resolved, sortformerPath, '_resolveFilePath maps sortformer.onnx to sortformerPath')
})

test('Sortformer with named file paths — full load and diarization', { timeout: 600000 }, async (t) => {
  TranscriptionParakeet.prototype.validateModelFiles?.restore?.()

  const modelDir = await ensureModelForType('sortformer')
  if (!modelDir) { t.pass('Sortformer model not available — skipping'); return }

  const { samplesDir } = getTestPaths()
  const samplePath = path.join(samplesDir, 'sample.raw')
  if (!fs.existsSync(samplePath)) { t.pass('sample.raw not found — skipping'); return }

  const args = {
    modelName: 'sf-named-test',
    loader: createLoader()
  }
  const config = {
    path: modelDir,
    sortformerPath: path.join(modelDir, 'sortformer.onnx'),
    parakeetConfig: { modelType: 'sortformer', maxThreads: 4, useGPU: false }
  }

  const model = new TranscriptionParakeet(args, config)

  try {
    await model._load()

    const rawBuffer = fs.readFileSync(samplePath)
    const pcm = new Int16Array(rawBuffer.buffer, rawBuffer.byteOffset, rawBuffer.length / 2)
    const audioData = new Float32Array(pcm.length)
    for (let i = 0; i < pcm.length; i++) audioData[i] = pcm[i] / 32768.0

    const audioStream = (async function * () {
      yield audioData
    })()

    const response = await model.run(audioStream)
    const segments = []
    await response.onUpdate((output) => {
      const items = Array.isArray(output) ? output : [output]
      segments.push(...items)
    }).await()

    const fullText = segments.map(s => s?.text || '').join('\n').trim()
    console.log(`[sf-named] Result: "${fullText.substring(0, 100)}"`)

    t.ok(fullText.length > 0, `Sortformer named paths produced text (${fullText.length} chars)`)
    t.ok(fullText.includes('Speaker'), 'Sortformer output contains speaker labels')
  } finally {
    try { await model.unload() } catch (e) {}
  }
})

test('TDT with named file paths — verify existing flow still works', { timeout: 60000 }, async (t) => {
  TranscriptionParakeet.prototype.validateModelFiles?.restore?.()

  const { modelPath } = getTestPaths()
  await ensureModel(modelPath)

  const args = {
    modelName: 'tdt-named-test',
    diskPath: '/nonexistent',
    loader: createLoader()
  }
  const config = {
    encoderPath: path.join(modelPath, 'encoder-model.onnx'),
    encoderDataPath: path.join(modelPath, 'encoder-model.onnx.data'),
    decoderPath: path.join(modelPath, 'decoder_joint-model.onnx'),
    vocabPath: path.join(modelPath, 'vocab.txt'),
    preprocessorPath: path.join(modelPath, 'preprocessor.onnx'),
    parakeetConfig: { modelType: 'tdt' }
  }

  const model = new TranscriptionParakeet(args, config)
  t.ok(model, 'TDT model created with named paths')
  t.ok(model._hasNamedPaths(), '_hasNamedPaths returns true for TDT paths')
  t.ok(model._hasAnyNamedPaths(), '_hasAnyNamedPaths also returns true')

  const resolved = model._resolveFilePath('', 'encoder-model.onnx')
  t.is(resolved, path.join(modelPath, 'encoder-model.onnx'), '_resolveFilePath maps correctly')
})
