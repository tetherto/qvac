'use strict'

/**
 * Parakeet Quickstart Example
 *
 * Transcribe a WAV file using the Parakeet TDT model.
 *
 * Usage: bare examples/quickstart.js
 */

const path = require('bare-path')
const binding = require('../binding.js')
const { ParakeetInterface } = require('../parakeet.js')
const {
  setupLogger,
  parseWavFile,
  loadModelWeights,
  validatePaths,
  createJobTracker,
  createOutputCallback,
  printResults
} = require('./utils.js')

async function main () {
  console.log('=== Parakeet Quickstart ===\n')

  // Setup
  setupLogger(binding)
  const modelPath = path.join(__dirname, '..', 'models', 'parakeet-tdt-0.6b-v3-onnx')
  const audioPath = path.join(__dirname, 'samples', 'sample-16k.wav')

  if (!validatePaths({ model: modelPath, audio: audioPath })) {
    binding.releaseLogger()
    return
  }

  console.log(`Model: ${modelPath}`)
  console.log(`Audio: ${audioPath}\n`)

  // Create instance with job tracking
  const tracker = createJobTracker()
  const config = { modelPath, modelType: 'tdt', maxThreads: 4, useGPU: false }

  console.log('1. Creating Parakeet instance...')
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

  // Process audio
  console.log('\n4. Processing audio...')
  const audioData = parseWavFile(audioPath)
  console.log(`   Audio: ${audioData.length} samples (${(audioData.length / 16000).toFixed(2)}s)`)

  console.log('\n5. Transcribing...')
  await parakeet.append({ type: 'audio', data: audioData.buffer })
  await parakeet.append({ type: 'end of job' })

  // Wait for completion (with timeout)
  const timeout = setTimeout(() => tracker.resolve(), 30000)
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
})
