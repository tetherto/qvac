'use strict'

const fs = require('bare-fs')
const os = require('bare-os')
const path = require('bare-path')
const proc = global.Bare ? require('bare-process') : process
const { detectOne } = require('@qvac/langdetect-text')
const ONNXTTS = require('../')
const { createWav, readWavAsFloat32, resampleLinear } = require('./wav-helper')
const { setLogger, releaseLogger } = require('../addonLogging')

const CHATTERBOX_SAMPLE_RATE = 24000
const DEFAULT_REFERENCE_WAV = path.join(__dirname, '..', 'test', 'reference-audio', 'jfk.wav')
const SUPPORTED_MULTILINGUAL_CODES = new Set([
  'ar', 'da', 'de', 'el', 'es', 'fi', 'fr', 'he', 'hi', 'it',
  'ko', 'ms', 'nl', 'no', 'pl', 'pt', 'ru', 'sv', 'sw', 'tr'
])

async function main () {
  const args = parseArgs(getArgv().slice(2))
  if (args.help) {
    printUsage()
    exitWithCode(0)
  }

  if (args.error) {
    console.error(args.error)
    console.error('')
    printUsage()
    exitWithCode(1)
  }

  if (!args.text) {
    console.error('Please provide the text to synthesize.')
    console.error('')
    printUsage()
    exitWithCode(1)
  }

  const detected = detectOne(args.text)
  const selection = selectChatterboxMode(detected.code)
  const modelFiles = resolveModelFiles(selection.mode)

  ensureModelFiles(modelFiles)

  const referenceAudio = loadReferenceAudio(args.refAudioPath || DEFAULT_REFERENCE_WAV)
  const outputFile = path.join(__dirname, `chatterbox-langdetect-${selection.language}.wav`)

  console.log(`Input text: "${args.text}"`)
  console.log(`Detected language: ${detected.language} (${detected.code})`)
  console.log(`Selected Chatterbox bundle: ${selection.mode}`)
  console.log(`Effective TTS language: ${selection.language}`)
  if (selection.fallbackReason) {
    console.warn(`Language fallback: ${selection.fallbackReason}`)
  }
  console.log(`Reference audio: ${path.relative(proc.cwd(), args.refAudioPath || DEFAULT_REFERENCE_WAV)}`)
  console.log(`Output file: ${outputFile}\n`)

  setLogger(function onAddonLog (priority, message) {
    if (priority > 1) return

    const priorityNames = {
      0: 'ERROR',
      1: 'WARNING',
      2: 'INFO',
      3: 'DEBUG',
      4: 'OFF'
    }
    const priorityName = priorityNames[priority] || 'UNKNOWN'
    const timestamp = new Date().toISOString()
    console.log(`[${timestamp}] [C++ log] [${priorityName}]: ${message}`)
  })

  const model = new ONNXTTS({
    files: {
      modelDir: modelFiles.modelDir,
      tokenizer: modelFiles.tokenizerPath,
      speechEncoder: modelFiles.speechEncoderPath,
      embedTokens: modelFiles.embedTokensPath,
      conditionalDecoder: modelFiles.conditionalDecoderPath,
      languageModel: modelFiles.languageModelPath
    },
    engine: 'chatterbox',
    referenceAudio,
    config: {
      language: selection.language
    },
    logger: console,
    opts: { stats: true }
  })

  try {
    console.log('Loading Chatterbox TTS model...')
    await model.load()
    console.log('Model loaded.')

    console.log(`Running TTS on detected language "${selection.language}"...`)
    const response = await model.run({
      input: args.text,
      type: 'text'
    })

    let buffer = []

    await response
      .onUpdate(function onUpdate (data) {
        if (data && data.outputArray) {
          buffer = buffer.concat(Array.from(data.outputArray))
        }
      })
      .await()

    console.log('TTS finished!')
    if (response.stats) {
      const stats = response.stats
      console.log(`Inference stats: totalTime=${stats.totalTime.toFixed(2)}s, tokensPerSecond=${stats.tokensPerSecond.toFixed(2)}, realTimeFactor=${stats.realTimeFactor.toFixed(2)}, audioDuration=${stats.audioDurationMs}ms, totalSamples=${stats.totalSamples}`)
    }

    console.log('\nWriting to .wav file...')
    createWav(buffer, CHATTERBOX_SAMPLE_RATE, outputFile)
    console.log(`Finished writing to ${outputFile}`)
  } catch (err) {
    console.error('Error during TTS processing:', err)
  } finally {
    console.log('Unloading model...')
    await model.unload()
    console.log('Model unloaded.')
    releaseLogger()
  }
}

function getArgv () {
  return global.Bare ? global.Bare.argv : process.argv
}

function parseArgs (args) {
  const parsed = {
    help: false,
    refAudioPath: '',
    text: '',
    error: ''
  }
  const textParts = []

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--help' || arg === '-h') {
      parsed.help = true
      return parsed
    }

    if (arg === '--ref' || arg === '-r') {
      const nextValue = args[i + 1]
      if (!nextValue) {
        parsed.error = 'Missing value for --ref.'
        return parsed
      }
      parsed.refAudioPath = nextValue
      i += 1
      continue
    }

    textParts.push(arg)
  }

  parsed.text = textParts.join(' ').trim()
  return parsed
}

function printUsage () {
  console.log('Usage: chatterbox-langdetect-tts.js [--ref path/to/reference.wav] "<text to synthesize>"')
  console.log('')
  console.log('Examples:')
  console.log('  bare examples/chatterbox-langdetect-tts.js "Hello world. This should use the English model."')
  console.log('  bare examples/chatterbox-langdetect-tts.js "Hola mundo. Esta demo detecta espanol automaticamente."')
  console.log('  bare examples/chatterbox-langdetect-tts.js --ref ./my-voice.wav "Bonjour tout le monde."')
}

function exitWithCode (code) {
  if (global.Bare) {
    global.Bare.exit(code)
    return
  }
  process.exit(code)
}

function selectChatterboxMode (detectedCode) {
  const normalizedCode = typeof detectedCode === 'string' ? detectedCode.toLowerCase() : 'und'

  if (normalizedCode === 'en') {
    return {
      mode: 'english',
      language: 'en',
      fallbackReason: ''
    }
  }

  if (SUPPORTED_MULTILINGUAL_CODES.has(normalizedCode)) {
    return {
      mode: 'multilingual',
      language: normalizedCode,
      fallbackReason: ''
    }
  }

  const fallbackReason = normalizedCode === 'und'
    ? 'language detection was undetermined, so the example fell back to English'
    : `language "${normalizedCode}" is not supported by the current Chatterbox example, so it fell back to English`

  return {
    mode: 'english',
    language: 'en',
    fallbackReason
  }
}

function resolveModelFiles (mode) {
  const isMultilingual = mode === 'multilingual'
  const variant = os.getEnv('CHATTERBOX_VARIANT') || 'q4'
  const suffix = variant === 'fp32' ? '' : `_${variant}`
  const nonLmSuffix = isMultilingual ? '' : suffix
  const modelDir = path.join(
    __dirname,
    '..',
    'models',
    isMultilingual ? 'chatterbox-multilingual' : 'chatterbox'
  )

  return {
    mode,
    modelDir,
    tokenizerPath: path.join(modelDir, 'tokenizer.json'),
    speechEncoderPath: path.join(modelDir, `speech_encoder${nonLmSuffix}.onnx`),
    embedTokensPath: path.join(modelDir, `embed_tokens${nonLmSuffix}.onnx`),
    conditionalDecoderPath: path.join(modelDir, `conditional_decoder${nonLmSuffix}.onnx`),
    languageModelPath: path.join(modelDir, `language_model${suffix}.onnx`)
  }
}

function ensureModelFiles (modelFiles) {
  const requiredFiles = [
    modelFiles.tokenizerPath,
    modelFiles.speechEncoderPath,
    modelFiles.embedTokensPath,
    modelFiles.conditionalDecoderPath,
    modelFiles.languageModelPath
  ]

  for (const filePath of requiredFiles) {
    if (fs.existsSync(filePath)) continue

    const ensureCmd = modelFiles.mode === 'multilingual'
      ? 'TTS_LANGUAGE=multilingual npm run models:ensure:chatterbox'
      : 'npm run models:ensure:chatterbox'
    console.error(`Missing model file: ${filePath}`)
    console.error(`Run "${ensureCmd}" to download the required models.`)
    exitWithCode(1)
  }
}

function loadReferenceAudio (refWavPath) {
  const { samples, sampleRate } = readWavAsFloat32(refWavPath)
  if (sampleRate !== CHATTERBOX_SAMPLE_RATE) {
    console.log(`Resampling reference audio from ${sampleRate}Hz to ${CHATTERBOX_SAMPLE_RATE}Hz`)
    return resampleLinear(samples, sampleRate, CHATTERBOX_SAMPLE_RATE)
  }

  return samples
}

main().catch(console.error)
