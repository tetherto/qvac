'use strict'

/**
 * Multilingual Transcription Example
 *
 * Transcribe audio from a WAV or raw PCM file using the Parakeet TDT model.
 * Supports multiple languages with automatic detection.
 *
 * Usage:
 *   bare examples/transcribe.js --file <audio-file> [--model <model-path>]
 *
 * Options:
 *   --file, -f    Path to audio file (WAV or raw PCM, required)
 *   --model, -m   Path to model directory (optional, defaults to TDT model)
 *   --help, -h    Show help
 *
 * Examples:
 *   bare examples/transcribe.js --file examples/samples/French.raw
 *   bare examples/transcribe.js -f examples/samples/croatian.raw -m models/parakeet-tdt-0.6b-v3-onnx-int8-full
 *   bare examples/transcribe.js --file examples/samples/sample-16k.wav
 */

/* global Bare */
const path = require('bare-path')
const process = require('bare-process')
const binding = require('../binding.js')
const { ParakeetInterface } = require('../parakeet.js')
const {
  setupLogger,
  convertRawToFloat32,
  parseWavFile,
  loadModelWeights,
  validatePaths,
  createJobTracker,
  createOutputCallback,
  printResults,
  readFileAsStream
} = require('./utils.js')

/**
 * Parse command line arguments
 * @returns {Object} parsed arguments
 */
function parseArgs () {
  const args = {
    file: null,
    model: null,
    help: false
  }

  const argv = Bare.argv.slice(2)
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    switch (arg) {
      case '--file':
      case '-f':
        args.file = argv[++i]
        break
      case '--model':
      case '-m':
        args.model = argv[++i]
        break
      case '--help':
      case '-h':
        args.help = true
        break
    }
  }

  return args
}

/**
 * Print usage information
 */
function printUsage () {
  console.log(`
Usage: bare examples/transcribe.js --file <audio-file> [--model <model-path>]

Options:
  --file, -f    Path to audio file (WAV or raw PCM, required)
  --model, -m   Path to model directory (optional)
                Defaults to: models/parakeet-tdt-0.6b-v3-onnx
  --help, -h    Show this help message

Examples:
  # Transcribe French audio
  bare examples/transcribe.js --file examples/samples/French.raw

  # Transcribe Croatian audio with INT8 model
  bare examples/transcribe.js -f examples/samples/croatian.raw -m models/parakeet-tdt-0.6b-v3-onnx-int8-full

  # Transcribe Spanish audio
  bare examples/transcribe.js --file examples/samples/LastQuestion_long_ES.raw

  # Transcribe English WAV file
  bare examples/transcribe.js --file examples/samples/sample-16k.wav

Available sample files:
  examples/samples/sample-16k.wav      - English WAV
  examples/samples/sample.raw          - English raw PCM
  examples/samples/French.raw          - French raw PCM
  examples/samples/croatian.raw        - Croatian raw PCM
  examples/samples/LastQuestion_long_ES.raw - Spanish raw PCM
`)
}

/**
 * Determine if file is WAV or raw PCM based on extension
 * @param {string} filePath - path to audio file
 * @returns {string} 'wav' or 'raw'
 */
function getAudioFormat (filePath) {
  const ext = path.extname(filePath).toLowerCase()
  return ext === '.wav' ? 'wav' : 'raw'
}

async function main () {
  const args = parseArgs()

  if (args.help) {
    printUsage()
    return
  }

  if (!args.file) {
    console.error('Error: --file argument is required\n')
    printUsage()
    process.exit(1)
  }

  // Resolve paths
  const audioPath = path.resolve(args.file)
  const modelPath = args.model
    ? path.resolve(args.model)
    : path.join(__dirname, '..', 'models', 'parakeet-tdt-0.6b-v3-onnx')

  const audioName = path.basename(audioPath)

  console.log('=== Parakeet Transcription ===\n')

  // Setup
  setupLogger(binding)

  if (!validatePaths({ model: modelPath, audio: audioPath })) {
    binding.releaseLogger()
    process.exit(1)
  }

  console.log(`Model: ${modelPath}`)
  console.log(`Audio: ${audioPath}\n`)

  // Create instance with job tracking
  const tracker = createJobTracker()
  const config = { modelPath, modelType: 'tdt', maxThreads: 4, useGPU: false }

  console.log('1. Creating instance...')
  const parakeet = new ParakeetInterface(
    binding,
    config,
    createOutputCallback(tracker, { verbose: true }),
    (instance, state) => console.log(`   State: ${state}`)
  )

  // Load and activate
  console.log('\n2. Loading model weights...')
  await loadModelWeights(parakeet, modelPath)

  console.log('\n3. Activating model...')
  await parakeet.activate()

  // Load audio based on format
  console.log('\n4. Loading audio...')
  const audioFormat = getAudioFormat(audioPath)
  let audioData

  if (audioFormat === 'wav') {
    audioData = parseWavFile(audioPath)
  } else {
    const rawBuffer = await readFileAsStream(audioPath)
    audioData = convertRawToFloat32(rawBuffer)
  }

  console.log(`   File: ${audioName}`)
  console.log(`   Format: ${audioFormat.toUpperCase()}`)
  console.log(`   Duration: ${(audioData.length / 16000).toFixed(2)}s`)

  // Transcribe
  console.log('\n5. Transcribing...')
  await parakeet.append({ type: 'audio', data: audioData.buffer })
  await parakeet.append({ type: 'end of job' })

  // Wait for completion
  const timeoutMs = Math.max(30000, (audioData.length / 16000) * 2000)
  const timeout = setTimeout(() => tracker.resolve(), timeoutMs)
  await tracker.promise
  clearTimeout(timeout)

  // Results and cleanup
  printResults(tracker.transcriptions)

  console.log('\n6. Cleaning up...')
  await parakeet.destroyInstance()
  binding.releaseLogger()
  console.log('\nDone!')
}

main().catch(err => {
  console.error('Error:', err)
  binding.releaseLogger()
  process.exit(1)
})
