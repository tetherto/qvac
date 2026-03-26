'use strict'

const test = require('brittle')
const os = require('bare-os')
const path = require('bare-path')
const ONNXTTS = require('../..')
const { readWavAsFloat32, resampleLinear } = require('../utils/wav-helper')
const { ensureChatterboxModels, ensureSupertonicModels, ensureLavaSRModels } = require('../utils/downloadModel')

const platform = os.platform()
const isMobile = platform === 'ios' || platform === 'android'

const CHATTERBOX_VARIANT = os.getEnv('CHATTERBOX_VARIANT') || 'fp32'
const VARIANT_SUFFIX = CHATTERBOX_VARIANT === 'fp32' ? '' : `_${CHATTERBOX_VARIANT}`


function getBaseDir () {
  return isMobile && global.testDir ? global.testDir : '.'
}

function chatterboxPath (modelDir, baseName) {
  return path.join(modelDir, `${baseName}${VARIANT_SUFFIX}.onnx`)
}

function chatterboxLmPath (modelDir) {
  return path.join(modelDir, `language_model${VARIANT_SUFFIX}.onnx`)
}

function loadReferenceAudio () {
  const refPath = path.join(__dirname, '..', 'reference-audio', 'jfk.wav')
  const { samples, sampleRate } = readWavAsFloat32(refPath)
  if (sampleRate !== CHATTERBOX_SAMPLE_RATE) {
    return resampleLinear(samples, sampleRate, CHATTERBOX_SAMPLE_RATE)
  }
  return samples
}

test('LavaSR: Chatterbox + enhance produces 48kHz output', { timeout: 1800000 }, async (t) => {
  const baseDir = getBaseDir()
  const chatterboxDir = path.join(baseDir, 'models', 'chatterbox')
  const lavasrDir = path.join(baseDir, 'models', 'lavasr')

  console.log('\n=== Ensuring Chatterbox + LavaSR models ===')
  const cbResult = await ensureChatterboxModels({ targetDir: chatterboxDir, variant: CHATTERBOX_VARIANT })
  const lsResult = await ensureLavaSRModels({ targetDir: lavasrDir })

  t.ok(cbResult.success, 'Chatterbox models should be downloaded')
  t.ok(lsResult.success, 'LavaSR models should be downloaded')
  if (!cbResult.success || !lsResult.success) {
    console.log('Failed to download models, skipping test')
    return
  }

  const referenceAudio = loadReferenceAudio()

  const model = new ONNXTTS({
    tokenizerPath: path.join(chatterboxDir, 'tokenizer.json'),
    speechEncoderPath: chatterboxPath(chatterboxDir, 'speech_encoder'),
    embedTokensPath: chatterboxPath(chatterboxDir, 'embed_tokens'),
    conditionalDecoderPath: chatterboxPath(chatterboxDir, 'conditional_decoder'),
    languageModelPath: chatterboxLmPath(chatterboxDir),
    referenceAudio,
    enhance: true,
    enhancerModelDir: lavasrDir,
    opts: { stats: true }
  }, { language: 'en' })

  await model.load()

  const response = await model.run({ type: 'text', input: 'Hello world.' })
  const result = await response.await()

  t.ok(result.data.outputArray, 'Should produce output audio')
  t.ok(result.data.outputArray.length > 0, 'Output should be non-empty')

  console.log(`Output length: ${result.data.outputArray.length} samples`)
  console.log(`Expected ~48kHz output (enhanced from ${CHATTERBOX_SAMPLE_RATE}Hz)`)

  await model.unload()
})

test('LavaSR: Chatterbox + denoise + enhance', { timeout: 1800000 }, async (t) => {
  const baseDir = getBaseDir()
  const chatterboxDir = path.join(baseDir, 'models', 'chatterbox')
  const lavasrDir = path.join(baseDir, 'models', 'lavasr')

  const cbResult = await ensureChatterboxModels({ targetDir: chatterboxDir, variant: CHATTERBOX_VARIANT })
  const lsResult = await ensureLavaSRModels({ targetDir: lavasrDir })

  if (!cbResult.success || !lsResult.success) {
    console.log('Models not available, skipping')
    return
  }

  const referenceAudio = loadReferenceAudio()

  const model = new ONNXTTS({
    tokenizerPath: path.join(chatterboxDir, 'tokenizer.json'),
    speechEncoderPath: chatterboxPath(chatterboxDir, 'speech_encoder'),
    embedTokensPath: chatterboxPath(chatterboxDir, 'embed_tokens'),
    conditionalDecoderPath: chatterboxPath(chatterboxDir, 'conditional_decoder'),
    languageModelPath: chatterboxLmPath(chatterboxDir),
    referenceAudio,
    enhance: true,
    denoise: true,
    enhancerModelDir: lavasrDir,
    opts: { stats: true }
  }, { language: 'en' })

  await model.load()

  const response = await model.run({ type: 'text', input: 'Testing denoiser and enhancer.' })
  const result = await response.await()

  t.ok(result.data.outputArray, 'Should produce output audio')
  t.ok(result.data.outputArray.length > 0, 'Output should be non-empty')

  await model.unload()
})

test('LavaSR: outputSampleRate without enhance (conventional resample)', { timeout: 1800000 }, async (t) => {
  const baseDir = getBaseDir()
  const chatterboxDir = path.join(baseDir, 'models', 'chatterbox')

  const cbResult = await ensureChatterboxModels({ targetDir: chatterboxDir, variant: CHATTERBOX_VARIANT })
  if (!cbResult.success) {
    console.log('Chatterbox models not available, skipping')
    return
  }

  const referenceAudio = loadReferenceAudio()
  const targetRate = 16000

  const model = new ONNXTTS({
    tokenizerPath: path.join(chatterboxDir, 'tokenizer.json'),
    speechEncoderPath: chatterboxPath(chatterboxDir, 'speech_encoder'),
    embedTokensPath: chatterboxPath(chatterboxDir, 'embed_tokens'),
    conditionalDecoderPath: chatterboxPath(chatterboxDir, 'conditional_decoder'),
    languageModelPath: chatterboxLmPath(chatterboxDir),
    referenceAudio,
    outputSampleRate: targetRate,
    opts: { stats: true }
  }, { language: 'en' })

  await model.load()

  const response = await model.run({ type: 'text', input: 'Testing conventional resampling.' })
  const result = await response.await()

  t.ok(result.data.outputArray, 'Should produce output audio')
  t.ok(result.data.outputArray.length > 0, 'Output should be non-empty')

  console.log(`Output length: ${result.data.outputArray.length} samples (resampled to ${targetRate}Hz)`)

  await model.unload()
})

test('LavaSR: enhance + custom outputSampleRate', { timeout: 1800000 }, async (t) => {
  const baseDir = getBaseDir()
  const chatterboxDir = path.join(baseDir, 'models', 'chatterbox')
  const lavasrDir = path.join(baseDir, 'models', 'lavasr')

  const cbResult = await ensureChatterboxModels({ targetDir: chatterboxDir, variant: CHATTERBOX_VARIANT })
  const lsResult = await ensureLavaSRModels({ targetDir: lavasrDir })

  if (!cbResult.success || !lsResult.success) {
    console.log('Models not available, skipping')
    return
  }

  const referenceAudio = loadReferenceAudio()
  const targetRate = 22050

  const model = new ONNXTTS({
    tokenizerPath: path.join(chatterboxDir, 'tokenizer.json'),
    speechEncoderPath: chatterboxPath(chatterboxDir, 'speech_encoder'),
    embedTokensPath: chatterboxPath(chatterboxDir, 'embed_tokens'),
    conditionalDecoderPath: chatterboxPath(chatterboxDir, 'conditional_decoder'),
    languageModelPath: chatterboxLmPath(chatterboxDir),
    referenceAudio,
    enhance: true,
    outputSampleRate: targetRate,
    enhancerModelDir: lavasrDir,
    opts: { stats: true }
  }, { language: 'en' })

  await model.load()

  const response = await model.run({ type: 'text', input: 'Testing enhance then downsample.' })
  const result = await response.await()

  t.ok(result.data.outputArray, 'Should produce output audio')
  t.ok(result.data.outputArray.length > 0, 'Output should be non-empty')

  console.log(`Output length: ${result.data.outputArray.length} samples (enhanced to 48kHz then resampled to ${targetRate}Hz)`)

  await model.unload()
})

test('LavaSR: Supertonic + enhance', { timeout: 1800000 }, async (t) => {
  const baseDir = getBaseDir()
  const supertonicDir = path.join(baseDir, 'models', 'supertonic')
  const lavasrDir = path.join(baseDir, 'models', 'lavasr')

  const stResult = await ensureSupertonicModels({ targetDir: supertonicDir })
  const lsResult = await ensureLavaSRModels({ targetDir: lavasrDir })

  if (!stResult.success || !lsResult.success) {
    console.log('Models not available, skipping')
    return
  }

  const model = new ONNXTTS({
    modelDir: supertonicDir,
    voiceName: 'F1',
    enhance: true,
    enhancerModelDir: lavasrDir,
    opts: { stats: true }
  }, { language: 'en' })

  await model.load()

  const response = await model.run({ type: 'text', input: 'Testing Supertonic enhancement.' })
  const result = await response.await()

  t.ok(result.data.outputArray, 'Should produce output audio')
  t.ok(result.data.outputArray.length > 0, 'Output should be non-empty')

  console.log(`Output length: ${result.data.outputArray.length} samples (enhanced from ${SUPERTONIC_SAMPLE_RATE}Hz to 48kHz)`)

  await model.unload()
})

test('LavaSR: No flags = backward compatible', { timeout: 1800000 }, async (t) => {
  const baseDir = getBaseDir()
  const chatterboxDir = path.join(baseDir, 'models', 'chatterbox')

  const cbResult = await ensureChatterboxModels({ targetDir: chatterboxDir, variant: CHATTERBOX_VARIANT })
  if (!cbResult.success) {
    console.log('Chatterbox models not available, skipping')
    return
  }

  const referenceAudio = loadReferenceAudio()

  const model = new ONNXTTS({
    tokenizerPath: path.join(chatterboxDir, 'tokenizer.json'),
    speechEncoderPath: chatterboxPath(chatterboxDir, 'speech_encoder'),
    embedTokensPath: chatterboxPath(chatterboxDir, 'embed_tokens'),
    conditionalDecoderPath: chatterboxPath(chatterboxDir, 'conditional_decoder'),
    languageModelPath: chatterboxLmPath(chatterboxDir),
    referenceAudio,
    opts: { stats: true }
  }, { language: 'en' })

  await model.load()

  const response = await model.run({ type: 'text', input: 'No enhancement flags.' })
  const result = await response.await()

  t.ok(result.data.outputArray, 'Should produce output audio')
  t.ok(result.data.outputArray.length > 0, 'Output should be non-empty')

  console.log(`Output length: ${result.data.outputArray.length} samples (native ${CHATTERBOX_SAMPLE_RATE}Hz, no LavaSR)`)

  await model.unload()
})
