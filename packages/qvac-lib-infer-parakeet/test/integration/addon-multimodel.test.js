'use strict'

const fs = require('bare-fs')
const path = require('bare-path')
const test = require('brittle')
const binding = require('../../binding')
const { ParakeetInterface } = require('../../parakeet')
const {
  setupJsLogger,
  getTestPaths,
  ensureModelForType,
  readFileChunked
} = require('./helpers.js')

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

function loadWeightsFromDir (parakeet, modelDir, files) {
  const promises = []
  for (const file of files) {
    const filePath = path.join(modelDir, file)
    if (!fs.existsSync(filePath)) continue
    const chunks = []
    for (const buffer of readFileChunked(filePath)) {
      chunks.push(buffer)
    }
    const fullBuffer = Buffer.concat(chunks)
    const chunk = new Uint8Array(fullBuffer.buffer, fullBuffer.byteOffset, fullBuffer.byteLength)
    promises.push(parakeet.loadWeights({ filename: file, chunk, completed: true }))
  }
  return Promise.all(promises)
}

test('CTC desktop integration — English transcription', { timeout: 600000 }, async (t) => {
  const loggerBinding = setupJsLogger(binding)
  let parakeet = null

  try {
    const modelDir = await ensureModelForType('ctc')
    if (!modelDir) {
      t.pass('CTC model download not configured — skipping')
      return
    }

    const audio = loadAudioSample()
    if (!audio) {
      t.pass('sample.raw not found — skipping')
      return
    }

    const transcriptions = []
    let outputResolve = null
    const outputPromise = new Promise(resolve => { outputResolve = resolve })

    parakeet = new ParakeetInterface(binding, {
      modelPath: modelDir,
      modelType: 'ctc',
      maxThreads: 4,
      useGPU: false,
      sampleRate: 16000,
      channels: 1
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
      if (error) console.error('[ctc] Error:', error)
    })

    await loadWeightsFromDir(parakeet, modelDir, ['model.onnx', 'model.onnx_data', 'tokenizer.json'])
    await parakeet.activate()

    await parakeet.append({ type: 'audio', data: audio.buffer })
    await parakeet.append({ type: 'end of job' })

    const timeout = setTimeout(() => { if (outputResolve) { outputResolve(); outputResolve = null } }, 300000)
    await outputPromise
    clearTimeout(timeout)

    const fullText = transcriptions.map(s => s.text).join(' ').trim()
    console.log(`[ctc] Result: "${fullText.substring(0, 120)}..."`)

    t.ok(transcriptions.length > 0, `CTC produced ${transcriptions.length} segments`)
    t.ok(fullText.length > 10, `CTC produced text (${fullText.length} chars)`)
  } finally {
    if (parakeet) try { parakeet.destroyInstance() } catch (e) {}
    try { loggerBinding.releaseLogger() } catch (e) {}
  }
})

test('EOU desktop integration — streaming transcription', { timeout: 600000 }, async (t) => {
  const loggerBinding = setupJsLogger(binding)
  let parakeet = null

  try {
    const modelDir = await ensureModelForType('eou')
    if (!modelDir) {
      t.pass('EOU model download not configured — skipping')
      return
    }

    const audio = loadAudioSample()
    if (!audio) {
      t.pass('sample.raw not found — skipping')
      return
    }

    const transcriptions = []
    let outputResolve = null
    const outputPromise = new Promise(resolve => { outputResolve = resolve })

    parakeet = new ParakeetInterface(binding, {
      modelPath: modelDir,
      modelType: 'eou',
      maxThreads: 4,
      useGPU: false,
      sampleRate: 16000,
      channels: 1
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
      if (error) console.error('[eou] Error:', error)
    })

    await loadWeightsFromDir(parakeet, modelDir, ['encoder.onnx', 'decoder_joint.onnx', 'tokenizer.json'])
    await parakeet.activate()

    await parakeet.append({ type: 'audio', data: audio.buffer })
    await parakeet.append({ type: 'end of job' })

    const timeout = setTimeout(() => { if (outputResolve) { outputResolve(); outputResolve = null } }, 300000)
    await outputPromise
    clearTimeout(timeout)

    const fullText = transcriptions.map(s => s.text).join(' ').trim()
    console.log(`[eou] Result: "${fullText.substring(0, 120)}..."`)

    t.ok(transcriptions.length > 0, `EOU produced ${transcriptions.length} segments`)
    t.ok(fullText.length > 0, `EOU produced text (${fullText.length} chars)`)
  } finally {
    if (parakeet) try { parakeet.destroyInstance() } catch (e) {}
    try { loggerBinding.releaseLogger() } catch (e) {}
  }
})

test('Sortformer desktop integration — speaker diarization', { timeout: 600000 }, async (t) => {
  const loggerBinding = setupJsLogger(binding)
  let parakeet = null

  try {
    const modelDir = await ensureModelForType('sortformer')
    if (!modelDir) {
      t.pass('Sortformer model download not configured — skipping')
      return
    }

    const audio = loadAudioSample()
    if (!audio) {
      t.pass('sample.raw not found — skipping')
      return
    }

    const transcriptions = []
    let outputResolve = null
    const outputPromise = new Promise(resolve => { outputResolve = resolve })

    parakeet = new ParakeetInterface(binding, {
      modelPath: modelDir,
      modelType: 'sortformer',
      maxThreads: 4,
      useGPU: false,
      sampleRate: 16000,
      channels: 1
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
      if (error) console.error('[sortformer] Error:', error)
    })

    await loadWeightsFromDir(parakeet, modelDir, ['sortformer.onnx'])
    await parakeet.activate()

    await parakeet.append({ type: 'audio', data: audio.buffer })
    await parakeet.append({ type: 'end of job' })

    const timeout = setTimeout(() => { if (outputResolve) { outputResolve(); outputResolve = null } }, 300000)
    await outputPromise
    clearTimeout(timeout)

    const fullText = transcriptions.map(s => s.text).join('\n').trim()
    console.log(`[sortformer] Result:\n${fullText.substring(0, 200)}`)

    t.ok(transcriptions.length > 0, `Sortformer produced ${transcriptions.length} segments`)
    t.ok(fullText.includes('Speaker'), 'Sortformer output contains speaker labels')
  } finally {
    if (parakeet) try { parakeet.destroyInstance() } catch (e) {}
    try { loggerBinding.releaseLogger() } catch (e) {}
  }
})
