'use strict'

const test = require('brittle')
const path = require('bare-path')
const fs = require('bare-fs')
const binding = require('../../binding')
const { ParakeetInterface } = require('../../parakeet')
const TranscriptionParakeet = require('../../index.js')
const FakeDL = require('../mocks/loader.fake.js')
const {
  setupJsLogger,
  getTestPaths,
  ensureModel,
  ensureModelForType,
  getNamedPathsConfig
} = require('./helpers.js')

function createLoader () {
  return new FakeDL({})
}

const { samplesDir } = getTestPaths()

function loadAudioSample () {
  const samplePath = path.join(samplesDir, 'sample.raw')
  if (!fs.existsSync(samplePath)) return null
  const rawBuffer = fs.readFileSync(samplePath)
  const pcm = new Int16Array(rawBuffer.buffer, rawBuffer.byteOffset, rawBuffer.length / 2)
  const audio = new Float32Array(pcm.length)
  for (let i = 0; i < pcm.length; i++) audio[i] = pcm[i] / 32768.0
  return audio
}

// ── Constructor / validation tests ──────────────────────────────────────────

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
  t.ok(model._hasNamedPaths(), '_hasNamedPaths returns true for CTC paths')

  const resolved = model._resolveFilePath('', 'model.onnx')
  t.is(resolved, ctcModelPath, '_resolveFilePath maps model.onnx to ctcModelPath')

  const resolvedTok = model._resolveFilePath('', 'tokenizer.json')
  t.is(resolvedTok, tokenizerPath, '_resolveFilePath maps tokenizer.json to tokenizerPath')
})

test('CTC with named file paths — full load and transcription', { timeout: 600000 }, async (t) => {
  const loggerBinding = setupJsLogger(binding)
  let parakeet = null

  try {
    const modelDir = await ensureModelForType('ctc')
    if (!modelDir) { t.pass('CTC model not available — skipping'); return }

    const audio = loadAudioSample()
    if (!audio) { t.pass('sample.raw not found — skipping'); return }

    const transcriptions = []
    let outputResolve = null
    const outputPromise = new Promise(resolve => { outputResolve = resolve })

    parakeet = new ParakeetInterface(binding, {
      modelPath: modelDir,
      modelType: 'ctc',
      maxThreads: 4,
      useGPU: false,
      sampleRate: 16000,
      channels: 1,
      ...getNamedPathsConfig('ctc', modelDir)
    }, (_, event, __, output, error) => {
      if (event === 'Output' && output) {
        const segments = Array.isArray(output) ? output : [output]
        for (const seg of segments) {
          if (seg?.text) transcriptions.push(seg)
        }
        if (transcriptions.length > 0 && outputResolve) {
          outputResolve()
          outputResolve = null
        }
      }
      if (error) console.error('[ctc-named] Error:', error)
    })

    await parakeet.activate()

    await parakeet.append({ type: 'audio', data: audio.buffer })
    await parakeet.append({ type: 'end of job' })

    const timeout = setTimeout(() => { if (outputResolve) { outputResolve(); outputResolve = null } }, 300000)
    await outputPromise
    clearTimeout(timeout)

    const fullText = transcriptions.map(s => s.text).join(' ').trim()
    console.log(`[ctc-named] Result: "${fullText.substring(0, 120)}..."`)

    t.ok(fullText.length > 10, `CTC named paths produced text (${fullText.length} chars)`)
    t.ok(fullText.toLowerCase().includes('alice'), 'CTC transcription includes expected content')
  } finally {
    if (parakeet) try { await parakeet.destroyInstance() } catch (e) {}
    try { loggerBinding.releaseLogger() } catch (e) {}
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
  t.ok(model._hasNamedPaths(), '_hasNamedPaths returns true for EOU paths')

  const resolved = model._resolveFilePath('', 'encoder.onnx')
  t.is(resolved, eouEncoderPath, '_resolveFilePath maps encoder.onnx to eouEncoderPath')

  const resolvedDec = model._resolveFilePath('', 'decoder_joint.onnx')
  t.is(resolvedDec, eouDecoderPath, '_resolveFilePath maps decoder_joint.onnx to eouDecoderPath')
})

test('EOU with named file paths — full load and transcription', { timeout: 600000 }, async (t) => {
  const loggerBinding = setupJsLogger(binding)
  let parakeet = null

  try {
    const modelDir = await ensureModelForType('eou')
    if (!modelDir) { t.pass('EOU model not available — skipping'); return }

    const audio = loadAudioSample()
    if (!audio) { t.pass('sample.raw not found — skipping'); return }

    const transcriptions = []
    let outputResolve = null
    const outputPromise = new Promise(resolve => { outputResolve = resolve })

    parakeet = new ParakeetInterface(binding, {
      modelPath: modelDir,
      modelType: 'eou',
      maxThreads: 4,
      useGPU: false,
      sampleRate: 16000,
      channels: 1,
      ...getNamedPathsConfig('eou', modelDir)
    }, (_, event, __, output, error) => {
      if (event === 'Output' && output) {
        const segments = Array.isArray(output) ? output : [output]
        for (const seg of segments) {
          if (seg?.text) transcriptions.push(seg)
        }
        if (transcriptions.length > 0 && outputResolve) {
          outputResolve()
          outputResolve = null
        }
      }
      if (error) console.error('[eou-named] Error:', error)
    })

    await parakeet.activate()

    await parakeet.append({ type: 'audio', data: audio.buffer })
    await parakeet.append({ type: 'end of job' })

    const timeout = setTimeout(() => { if (outputResolve) { outputResolve(); outputResolve = null } }, 300000)
    await outputPromise
    clearTimeout(timeout)

    const fullText = transcriptions.map(s => s.text).join(' ').trim()
    console.log(`[eou-named] Result: "${fullText.substring(0, 120)}..."`)

    t.ok(transcriptions.length > 0, `EOU produced ${transcriptions.length} segments`)
    t.ok(fullText.length > 0, `EOU named paths produced text (${fullText.length} chars)`)
  } finally {
    if (parakeet) try { await parakeet.destroyInstance() } catch (e) {}
    try { loggerBinding.releaseLogger() } catch (e) {}
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
  t.ok(model._hasNamedPaths(), '_hasNamedPaths returns true for Sortformer paths')

  const resolved = model._resolveFilePath('', 'sortformer.onnx')
  t.is(resolved, sortformerPath, '_resolveFilePath maps sortformer.onnx to sortformerPath')
})

test('Sortformer with named file paths — full load and diarization', { timeout: 600000 }, async (t) => {
  const loggerBinding = setupJsLogger(binding)
  let parakeet = null

  try {
    const modelDir = await ensureModelForType('sortformer')
    if (!modelDir) { t.pass('Sortformer model not available — skipping'); return }

    const audio = loadAudioSample()
    if (!audio) { t.pass('sample.raw not found — skipping'); return }

    const transcriptions = []
    let outputResolve = null
    const outputPromise = new Promise(resolve => { outputResolve = resolve })

    parakeet = new ParakeetInterface(binding, {
      modelPath: modelDir,
      modelType: 'sortformer',
      maxThreads: 4,
      useGPU: false,
      sampleRate: 16000,
      channels: 1,
      ...getNamedPathsConfig('sortformer', modelDir)
    }, (_, event, __, output, error) => {
      if (event === 'Output' && output) {
        const segments = Array.isArray(output) ? output : [output]
        for (const seg of segments) {
          if (seg?.text) transcriptions.push(seg)
        }
        if (transcriptions.length > 0 && outputResolve) {
          outputResolve()
          outputResolve = null
        }
      }
      if (error) console.error('[sf-named] Error:', error)
    })

    await parakeet.activate()

    await parakeet.append({ type: 'audio', data: audio.buffer })
    await parakeet.append({ type: 'end of job' })

    const timeout = setTimeout(() => { if (outputResolve) { outputResolve(); outputResolve = null } }, 300000)
    await outputPromise
    clearTimeout(timeout)

    const fullText = transcriptions.map(s => s.text).join('\n').trim()
    console.log(`[sf-named] Result:\n${fullText.substring(0, 200)}`)

    t.ok(transcriptions.length > 0, `Sortformer produced ${transcriptions.length} segments`)
    t.ok(fullText.includes('Speaker'), 'Sortformer output contains speaker labels')
  } finally {
    if (parakeet) try { await parakeet.destroyInstance() } catch (e) {}
    try { loggerBinding.releaseLogger() } catch (e) {}
  }
})

// ── TDT constructor validation ──────────────────────────────────────────────

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

  const resolved = model._resolveFilePath('', 'encoder-model.onnx')
  t.is(resolved, path.join(modelPath, 'encoder-model.onnx'), '_resolveFilePath maps correctly')
})
