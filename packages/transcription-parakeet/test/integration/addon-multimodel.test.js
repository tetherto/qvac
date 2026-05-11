'use strict'

const fs = require('bare-fs')
const path = require('bare-path')
const test = require('brittle')
const {
  binding,
  TranscriptionParakeet,
  setupJsLogger,
  getTestPaths,
  loadGgufOrSkip
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

async function transcribe (model, audio) {
  const segments = []
  const response = await model.run(audio)
  await response
    .onUpdate(out => {
      const items = Array.isArray(out) ? out : [out]
      for (const seg of items) {
        if (seg && seg.text) segments.push(seg)
      }
    })
    .await()
  return segments
}

async function runModelTest (t, modelType, modelPath, audio, expectations) {
  const model = new TranscriptionParakeet({
    files: { model: modelPath },
    config: { parakeetConfig: { maxThreads: 4, useGPU: false } }
  })
  try {
    await model.load()
    const segments = await transcribe(model, audio)
    const joiner = modelType === 'sortformer' ? '\n' : ' '
    const fullText = segments.map(s => s.text).join(joiner).trim()
    console.log(`[${modelType}] Result: "${fullText.substring(0, 120)}${fullText.length > 120 ? '...' : ''}"`)

    t.ok(segments.length > 0, `${modelType} produced ${segments.length} segments`)
    if (expectations.containsSpeaker) {
      t.ok(fullText.includes('Speaker'), `${modelType} output contains speaker labels`)
    } else {
      t.ok(fullText.length > expectations.minTextLength,
        `${modelType} produced text (${fullText.length} chars)`)
    }
  } finally {
    try { await model.unload() } catch (e) { /* ignore */ }
  }
}

test('CTC desktop integration — English transcription', { timeout: 600000 }, async (t) => {
  const loggerBinding = setupJsLogger(binding)
  try {
    const modelPath = await loadGgufOrSkip(t, 'ctc')
    if (!modelPath) return
    const audio = loadAudioSample()
    if (!audio) { t.pass('sample.raw not found — skipping'); return }
    await runModelTest(t, 'ctc', modelPath, audio, { minTextLength: 10 })
  } finally {
    try { loggerBinding.releaseLogger() } catch (e) { /* ignore */ }
  }
})

test('EOU desktop integration — streaming transcription', { timeout: 600000 }, async (t) => {
  const loggerBinding = setupJsLogger(binding)
  try {
    const modelPath = await loadGgufOrSkip(t, 'eou')
    if (!modelPath) return
    const audio = loadAudioSample()
    if (!audio) { t.pass('sample.raw not found — skipping'); return }
    await runModelTest(t, 'eou', modelPath, audio, { minTextLength: 0 })
  } finally {
    try { loggerBinding.releaseLogger() } catch (e) { /* ignore */ }
  }
})

test('Sortformer desktop integration — speaker diarization', { timeout: 600000 }, async (t) => {
  const loggerBinding = setupJsLogger(binding)
  try {
    const modelPath = await loadGgufOrSkip(t, 'sortformer')
    if (!modelPath) return
    const audio = loadAudioSample()
    if (!audio) { t.pass('sample.raw not found — skipping'); return }
    await runModelTest(t, 'sortformer', modelPath, audio, { containsSpeaker: true })
  } finally {
    try { loggerBinding.releaseLogger() } catch (e) { /* ignore */ }
  }
})
