'use strict'

const ONNXTTS = require('@qvac/tts-onnx')
const path = require('bare-path')
const process = require('bare-process')
const logger = require('../utils/logger')

const BENCHMARKS_DIR = path.join(__dirname, '../../..')
const SHARED_DATA_DIR = path.join(BENCHMARKS_DIR, 'shared-data')
const DEFAULT_MODEL_DIR = path.join(SHARED_DATA_DIR, 'models', 'supertonic')

let cachedModel = null
let cachedModelKey = null
let loadTimeMs = 0

function generateModelKey (config) {
  return `supertonic:${config.modelDir || 'default'}:${config.voiceName || 'F1'}`
}

async function runSupertonicTTS (payload) {
  const { texts, config, includeSamples = false } = payload

  logger.info(`[Supertonic] Processing ${texts.length} texts`)

  let modelDir = config.modelDir || DEFAULT_MODEL_DIR
  if (!path.isAbsolute(modelDir)) {
    modelDir = path.join(BENCHMARKS_DIR, modelDir)
  }

  const voiceName = config.voiceName || 'F1'
  const speed = config.speed != null ? config.speed : 1
  const numInferenceSteps = config.numInferenceSteps != null ? config.numInferenceSteps : 5

  const modelKey = generateModelKey(config)

  if (!cachedModel || cachedModelKey !== modelKey) {
    const loadStart = process.hrtime()
    logger.info(`[Supertonic] Loading model from: ${modelDir} (voice: ${voiceName})`)

    const args = {
      modelDir,
      voiceName,
      speed,
      numInferenceSteps,
      opts: { stats: true }
    }

    const modelConfig = {
      language: config.language || 'en',
      useGPU: config.useGPU === true
    }

    cachedModel = new ONNXTTS(args, modelConfig)
    await cachedModel.load()

    const [loadSec, loadNano] = process.hrtime(loadStart)
    loadTimeMs = loadSec * 1e3 + loadNano / 1e6
    cachedModelKey = modelKey
    logger.info(`[Supertonic] Model loaded in ${loadTimeMs.toFixed(2)}ms`)
  } else {
    logger.info('[Supertonic] Using cached model')
  }

  const SUPERTONIC_SAMPLE_RATE = 44100
  const outputs = []
  const genStart = process.hrtime()

  for (let i = 0; i < texts.length; i++) {
    const text = texts[i]
    const textStart = process.hrtime()

    logger.debug(`[Supertonic] Synthesizing text ${i + 1}/${texts.length}: "${text.substring(0, 50)}..."`)

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
    const sampleCount = buffer.length
    const durationSec = sampleCount / SUPERTONIC_SAMPLE_RATE

    let rtf
    if (jobStats?.realTimeFactor != null) {
      rtf = jobStats.realTimeFactor
    } else if (response.stats?.realTimeFactor != null) {
      rtf = response.stats.realTimeFactor
    } else {
      rtf = durationSec > 0 ? (textGenMs / 1000) / durationSec : 0
    }

    logger.info(`  Text: "${text.substring(0, 50)}"`)
    logger.info(`  Samples: ${sampleCount}, Sample Rate: ${SUPERTONIC_SAMPLE_RATE}`)
    logger.info(`  Duration: ${durationSec.toFixed(2)}s, Generation: ${textGenMs.toFixed(2)}ms`)
    logger.info(`  RTF: ${rtf.toFixed(4)} (${rtf > 0 ? (1 / rtf).toFixed(1) : 0}x real-time)`)

    const output = {
      text,
      sampleCount,
      sampleRate: SUPERTONIC_SAMPLE_RATE,
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
  const avgRtf = outputs.length ? outputs.reduce((sum, o) => sum + o.rtf, 0) / outputs.length : 0

  logger.info(`[Supertonic] Completed ${outputs.length} syntheses in ${totalGenMs.toFixed(2)}ms (avg RTF: ${avgRtf.toFixed(4)})`)

  let version = 'unknown'
  try {
    const pkg = require('@qvac/tts-onnx/package.json')
    version = pkg.version
  } catch (err) {
    logger.warn('Could not determine package version')
  }

  return {
    outputs,
    implementation: 'supertonic-addon',
    version,
    time: {
      loadModelMs: loadTimeMs,
      totalGenerationMs: totalGenMs
    }
  }
}

module.exports = { runSupertonicTTS }
