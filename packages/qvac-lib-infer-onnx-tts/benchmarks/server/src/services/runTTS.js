'use strict'

const ONNXTTS = require('@qvac/tts-onnx')
const path = require('bare-path')
const process = require('bare-process')
const logger = require('../utils/logger')

// Paths relative to benchmarks/ directory (server/ is in benchmarks/server/)
const BENCHMARKS_DIR = path.join(__dirname, '../../..')
const SHARED_DATA_DIR = path.join(BENCHMARKS_DIR, 'shared-data')
const ESPEAK_DATA_PATH = path.join(SHARED_DATA_DIR, 'espeak-ng-data')

let cachedModel = null
let cachedModelKey = null
let loadTimeMs = 0

/**
 * Determine model name based on language
 */
function getModelNameForLanguage (language) {
  const lang = (language || 'en-us').toLowerCase()

  switch (lang) {
    case 'en-us':
    case 'en':
      return 'en_US-lessac-medium'

    case 'es-es':
    case 'es':
      return 'es_ES-davefx-medium'

    case 'de-de':
    case 'de':
      return 'de_DE-thorsten-medium'

    case 'it-it':
    case 'it':
      return 'it_IT-paola-medium'

    case 'fr-fr':
    case 'fr':
      return 'fr_FR-siwis-medium'

    case 'hi-in':
    case 'hi':
      return 'hi_IN-rohan-medium'

    case 'ar-jo':
    case 'ar':
      return 'ar_JO-kareem-medium'

    case 'bg-bg':
    case 'bg':
      return 'bg_BG-dimitar-medium'

    case 'ca-es':
    case 'ca':
      return 'ca_ES-upc_ona-medium'

    case 'cs-cz':
    case 'cs':
      return 'cs_CZ-jirka-medium'

    case 'cy-gb':
    case 'cy':
      return 'cy_GB-gwryw_gogleddol-medium'

    case 'da-dk':
    case 'da':
      return 'da_DK-talesyntese-medium'

    case 'el-gr':
    case 'el':
      return 'el_GR-rapunzelina-medium'

    case 'fa-ir':
    case 'fa':
      return 'fa_IR-reza_ibrahim-medium'

    case 'fi-fi':
    case 'fi':
      return 'fi_FI-harri-medium'

    case 'hu-hu':
    case 'hu':
      return 'hu_HU-imre-medium'

    case 'id-id':
    case 'id':
      return 'id_ID-news_tts-medium'

    case 'is-is':
    case 'is':
      return 'is_IS-ugla-medium'

    case 'ka-ge':
    case 'ka':
      return 'ka_GE-natia-medium'

    case 'kk-kz':
    case 'kk':
      return 'kk_KZ-issai-high'

    case 'lb-lu':
    case 'lb':
      return 'lb_LU-marylux-medium'

    case 'lv-lv':
    case 'lv':
      return 'lv_LV-aivars-medium'

    case 'ml-in':
    case 'ml':
      return 'ml_IN-meera-medium'

    case 'ne-np':
    case 'ne':
      return 'ne_NP-chitwan-medium'

    case 'nl-be':
      return 'nl_BE-nathalie-medium'

    case 'nl-nl':
    case 'nl':
      return 'nl_NL-ronnie-medium'

    case 'no-no':
    case 'no':
    case 'nb-no':
    case 'nb':
      return 'no_NO-talesyntese-medium'

    case 'pl-pl':
    case 'pl':
      return 'pl_PL-gosia-medium'

    case 'pt-br':
    case 'pt':
      return 'pt_BR-jeff-medium'

    case 'pt-pt':
    case 'pt':
      return 'pt_PT-tugão-medium'

    case 'ro-ro':
    case 'ro':
      return 'ro_RO-mihai-medium'

    case 'ru-ru':
    case 'ru':
      return 'ru_RU-dmitri-medium'

    case 'sk-sk':
    case 'sk':
      return 'sk_SK-lili-medium'

    case 'sl-si':
    case 'sl':
      return 'sl_SI-artur-medium'

    case 'sr-rs':
    case 'sr':
      return 'sr_RS-serbski_institut-medium'

    case 'sv-se':
    case 'sv':
      return 'sv_SE-lisa-medium'

    case 'sw-cd':
    case 'sw':
      return 'sw_CD-lanfrica-medium'

    case 'te-in':
    case 'te':
      return 'te_IN-padmavathi-medium'

    case 'tr-tr':
    case 'tr':
      return 'tr_TR-dfki-medium'

    case 'uk-ua':
    case 'uk':
      return 'uk_UA-ukrainian_tts-medium'

    case 'vi-vn':
    case 'vi':
      return 'vi_VN-vais1000-medium'

    case 'zh-cn':
    case 'zh':
    case 'cmn':
      return 'zh_CN-huayan-medium'

    default:
      logger.warn(`Unknown language '${language}', defaulting to English model`)
      return 'en_US-lessac-medium'
  }
}

/**
 * Generate a cache key for model
 */
function generateModelKey (config) {
  return `${config.modelPath}:${config.language}`
}

/**
 * Run TTS synthesis on multiple texts
 */
async function runTTS (payload) {
  const { texts, config, includeSamples = false } = payload

  logger.info(`Processing ${texts.length} texts`)

  // Resolve paths relative to benchmarks directory if not absolute
  let modelPath = config.modelPath
  let configPath = config.configPath
  let eSpeakDataPath = config.eSpeakDataPath || ESPEAK_DATA_PATH

  // If using generic model paths, construct actual paths based on language
  const language = config.language || 'en-us'
  const modelName = getModelNameForLanguage(language)

  // Check if we're using the generic paths and replace them with actual model names
  if (modelPath && (modelPath.endsWith('model.onnx') || modelPath.endsWith('models/model.onnx'))) {
    modelPath = path.join('shared-data/models', `${modelName}.onnx`)
    logger.info(`Using model for language '${language}': ${modelName}.onnx`)
  }
  if (configPath && (configPath.endsWith('config.json') || configPath.endsWith('models/config.json'))) {
    configPath = path.join('shared-data/models', `${modelName}.onnx.json`)
    logger.info(`Using config for language '${language}': ${modelName}.onnx.json`)
  }

  if (!path.isAbsolute(modelPath)) {
    modelPath = path.join(BENCHMARKS_DIR, modelPath)
  }
  if (!path.isAbsolute(configPath)) {
    configPath = path.join(BENCHMARKS_DIR, configPath)
  }
  if (!path.isAbsolute(eSpeakDataPath)) {
    eSpeakDataPath = path.join(BENCHMARKS_DIR, eSpeakDataPath)
  }

  const modelKey = generateModelKey(config)

  // Load model if not cached or if different model requested
  if (!cachedModel || cachedModelKey !== modelKey) {
    const loadStart = process.hrtime()

    logger.info(`Loading model: ${modelPath}`)
    logger.info(`eSpeak data path: ${eSpeakDataPath}`)

    // When no loader, pass full paths directly to mainModelUrl and configJsonPath
    const args = {
      mainModelUrl: modelPath, // Full path to model file
      configJsonPath: configPath, // Full path to config file
      opts: { stats: true },
      eSpeakDataPath
    }

    const modelConfig = {
      language: config.language || 'en',
      useGPU: config.useGPU !== undefined ? config.useGPU : false
    }

    cachedModel = new ONNXTTS(args, modelConfig)
    await cachedModel.load()

    const [loadSec, loadNano] = process.hrtime(loadStart)
    loadTimeMs = loadSec * 1e3 + loadNano / 1e6
    cachedModelKey = modelKey

    logger.info(`Model loaded in ${loadTimeMs.toFixed(2)}ms`)
  } else {
    logger.info('Using cached model')
  }

  const outputs = []
  const genStart = process.hrtime()

  for (let i = 0; i < texts.length; i++) {
    const text = texts[i]
    const textStart = process.hrtime()

    logger.debug(`Synthesizing text ${i + 1}/${texts.length}: "${text.substring(0, 50)}..."`)

    const response = await cachedModel.run({
      input: text,
      type: 'text'
    })

    let buffer = []
    await response
      .onUpdate(data => {
        if (data && data.outputArray) {
          buffer = buffer.concat(Array.from(data.outputArray))
        }
      })
      .await()

    const [textSec, textNano] = process.hrtime(textStart)
    const textGenMs = textSec * 1e3 + textNano / 1e6

    const sampleRate = config.sampleRate || 22050
    const sampleCount = buffer.length
    const durationSec = sampleCount / sampleRate
    const rtf = (textGenMs / 1000) / durationSec

    logger.info(`  Text: "${text.substring(0, 50)}"`)
    logger.info(`  Samples: ${sampleCount}, Sample Rate: ${sampleRate}`)
    logger.info(`  Duration: ${durationSec.toFixed(2)}s, Generation: ${textGenMs.toFixed(2)}ms`)
    logger.info(`  RTF: ${rtf.toFixed(4)} (${(1 / rtf).toFixed(1)}x real-time)`)
    logger.debug(`  First 10 samples: ${buffer.slice(0, 10).join(', ')}`)

    const output = {
      text,
      sampleCount,
      sampleRate,
      durationSec,
      generationMs: textGenMs,
      rtf
    }

    // Include samples if requested (for comparison)
    if (includeSamples) {
      output.samples = buffer
    }

    outputs.push(output)
  }

  const [genSec, genNano] = process.hrtime(genStart)
  const totalGenMs = genSec * 1e3 + genNano / 1e6

  const avgRtf = outputs.reduce((sum, o) => sum + o.rtf, 0) / outputs.length

  logger.info(`Completed ${outputs.length} syntheses in ${totalGenMs.toFixed(2)}ms (avg RTF: ${avgRtf.toFixed(4)})`)

  // Get package version
  let version = 'unknown'
  try {
    const pkg = require('@qvac/tts-onnx/package.json')
    version = pkg.version
  } catch (err) {
    logger.warn('Could not determine package version')
  }

  return {
    outputs,
    implementation: 'addon',
    version,
    time: {
      loadModelMs: loadTimeMs,
      totalGenerationMs: totalGenMs
    }
  }
}

module.exports = { runTTS }
