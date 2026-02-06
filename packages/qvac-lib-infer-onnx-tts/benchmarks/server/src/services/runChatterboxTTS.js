'use strict'

const ONNXTTS = require('@qvac/tts-onnx')
const path = require('bare-path')
const fs = require('bare-fs')
const process = require('bare-process')
const logger = require('../utils/logger')

// Paths relative to benchmarks/server/src/services/ -> ../../.. = benchmarks
const BENCHMARKS_DIR = path.join(__dirname, '../../..')
const SHARED_DATA_DIR = path.join(BENCHMARKS_DIR, 'shared-data')
const DEFAULT_MODEL_DIR = path.join(SHARED_DATA_DIR, 'models', 'chatterbox')
const DEFAULT_REF_AUDIO_PATH = path.join(BENCHMARKS_DIR, 'assets', 'ref.wav')

let cachedModel = null
let cachedModelKey = null
let loadTimeMs = 0

function loadReferenceAudioFromFile (filePath) {
  const buffer = fs.readFileSync(filePath)
  const dataView = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)

  let dataOffset = 12
  while (dataOffset < buffer.length - 8) {
    const chunkId = String.fromCharCode(buffer[dataOffset], buffer[dataOffset + 1], buffer[dataOffset + 2], buffer[dataOffset + 3])
    const chunkSize = dataView.getUint32(dataOffset + 4, true)
    if (chunkId === 'data') {
      dataOffset += 8
      break
    }
    dataOffset += 8 + chunkSize
  }

  const bitsPerSample = dataView.getUint16(34, true)
  const numChannels = dataView.getUint16(22, true)
  const audioData = buffer.slice(dataOffset)
  const bytesPerSample = bitsPerSample / 8
  const numSamples = Math.floor(audioData.length / bytesPerSample / numChannels)

  const samples = new Float32Array(numSamples)
  const audioView = new DataView(audioData.buffer, audioData.byteOffset, audioData.byteLength)

  for (let i = 0; i < numSamples; i++) {
    const offset = i * bytesPerSample * numChannels
    if (bitsPerSample === 16) {
      samples[i] = audioView.getInt16(offset, true) / 32768.0
    } else if (bitsPerSample === 32) {
      samples[i] = audioView.getFloat32(offset, true)
    }
  }

  return samples
}

function generateSyntheticReferenceAudio (durationSec = 1.0, sampleRate = 24000, frequency = 440) {
  const numSamples = Math.floor(sampleRate * durationSec)
  const samples = new Float32Array(numSamples)
  for (let i = 0; i < numSamples; i++) {
    samples[i] = Math.sin(2 * Math.PI * frequency * i / sampleRate) * 0.5
  }
  return samples
}

function generateModelKey (config) {
  return `chatterbox:${config.modelDir || 'default'}`
}

async function runChatterboxTTS (payload) {
  const { texts, config, includeSamples = false } = payload

  logger.info(`[Chatterbox] Processing ${texts.length} texts`)

  let modelDir = config.modelDir || DEFAULT_MODEL_DIR
  if (!path.isAbsolute(modelDir)) {
    modelDir = path.join(BENCHMARKS_DIR, modelDir)
  }

  const tokenizerPath = path.join(modelDir, 'tokenizer.json')
  const speechEncoderPath = path.join(modelDir, 'speech_encoder.onnx')
  const embedTokensPath = path.join(modelDir, 'embed_tokens.onnx')
  const conditionalDecoderPath = path.join(modelDir, 'conditional_decoder.onnx')
  const languageModelPath = path.join(modelDir, 'language_model.onnx')

  const modelKey = generateModelKey(config)

  if (!cachedModel || cachedModelKey !== modelKey) {
    const loadStart = process.hrtime()

    logger.info(`[Chatterbox] Loading model from: ${modelDir}`)

    let refAudioPath = config.referenceAudioPath
    if (refAudioPath && !path.isAbsolute(refAudioPath)) {
      refAudioPath = path.join(BENCHMARKS_DIR, refAudioPath)
    }
    if (!refAudioPath || !fs.existsSync(refAudioPath)) {
      refAudioPath = DEFAULT_REF_AUDIO_PATH
    }

    let referenceAudio
    if (fs.existsSync(refAudioPath)) {
      referenceAudio = loadReferenceAudioFromFile(refAudioPath)
      logger.info(`[Chatterbox] Using reference audio from: ${refAudioPath} (${referenceAudio.length} samples)`)
    } else {
      referenceAudio = generateSyntheticReferenceAudio(1.0, 24000, 440)
      logger.warn(`[Chatterbox] Reference audio not found, using synthetic audio (${referenceAudio.length} samples)`)
    }

    const args = {
      tokenizerPath,
      speechEncoderPath,
      embedTokensPath,
      conditionalDecoderPath,
      languageModelPath,
      referenceAudio,
      opts: { stats: true }
    }

    const modelConfig = {
      language: 'en',
      useGPU: config.useGPU !== undefined ? config.useGPU : false
    }

    cachedModel = new ONNXTTS(args, modelConfig)
    await cachedModel.load()

    const [loadSec, loadNano] = process.hrtime(loadStart)
    loadTimeMs = loadSec * 1e3 + loadNano / 1e6
    cachedModelKey = modelKey

    logger.info(`[Chatterbox] Model loaded in ${loadTimeMs.toFixed(2)}ms`)
  } else {
    logger.info('[Chatterbox] Using cached model')
  }

  const outputs = []
  const genStart = process.hrtime()

  for (let i = 0; i < texts.length; i++) {
    const text = texts[i]
    const textStart = process.hrtime()

    logger.debug(`[Chatterbox] Synthesizing text ${i + 1}/${texts.length}: "${text.substring(0, 50)}..."`)

    const response = await cachedModel.run({
      input: text,
      type: 'text'
    })

    let buffer = []
    let jobStats = null
    await response
      .onUpdate(data => {
        if (data && data.outputArray) {
          buffer = buffer.concat(Array.from(data.outputArray))
        }
        if (data.event === 'JobEnded') {
          jobStats = data
        }
      })
      .await()

    const [textSec, textNano] = process.hrtime(textStart)
    const textGenMs = textSec * 1e3 + textNano / 1e6

    const sampleRate = 24000
    const sampleCount = buffer.length
    const durationSec = sampleCount / sampleRate

    let rtf
    if (jobStats?.realTimeFactor) {
      rtf = jobStats.realTimeFactor
    } else if (response.stats?.realTimeFactor) {
      rtf = response.stats.realTimeFactor
    } else {
      rtf = (textGenMs / 1000) / durationSec
    }

    logger.info(`  Text: "${text.substring(0, 50)}"`)
    logger.info(`  Samples: ${sampleCount}, Sample Rate: ${sampleRate}`)
    logger.info(`  Duration: ${durationSec.toFixed(2)}s, Generation: ${textGenMs.toFixed(2)}ms`)
    logger.info(`  RTF: ${rtf.toFixed(4)} (${(1 / rtf).toFixed(1)}x real-time)`)

    const output = {
      text,
      sampleCount,
      sampleRate,
      durationSec,
      generationMs: textGenMs,
      rtf
    }

    if (includeSamples) {
      output.samples = buffer
    }

    outputs.push(output)
  }

  const [genSec, genNano] = process.hrtime(genStart)
  const totalGenMs = genSec * 1e3 + genNano / 1e6

  const avgRtf = outputs.reduce((sum, o) => sum + o.rtf, 0) / outputs.length

  logger.info(`[Chatterbox] Completed ${outputs.length} syntheses in ${totalGenMs.toFixed(2)}ms (avg RTF: ${avgRtf.toFixed(4)})`)

  let version = 'unknown'
  try {
    const pkg = require('@qvac/tts-onnx/package.json')
    version = pkg.version
  } catch (err) {
    logger.warn('Could not determine package version')
  }

  return {
    outputs,
    implementation: 'chatterbox-addon',
    version,
    time: {
      loadModelMs: loadTimeMs,
      totalGenerationMs: totalGenMs
    }
  }
}

module.exports = { runChatterboxTTS, generateSyntheticReferenceAudio }
