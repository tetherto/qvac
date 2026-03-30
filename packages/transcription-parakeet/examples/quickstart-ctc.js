'use strict'

/**
 * Parakeet CTC Quickstart Example
 *
 * Transcribe a WAV file using the Parakeet CTC model.
 *
 * Usage: bare examples/quickstart-ctc.js
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
  printResults,
  CTC_MODEL_FILES
} = require('./utils.js')

async function main () {
  console.log('=== Parakeet CTC Quickstart ===\n')

  setupLogger(binding)
  const modelPath = path.join(__dirname, '..', 'models', 'parakeet-ctc-0.6b-onnx')
  const audioPath = path.join(__dirname, 'samples', 'sample-16k.wav')

  if (!validatePaths({ model: modelPath, audio: audioPath })) {
    binding.releaseLogger()
    return
  }

  console.log(`Model: ${modelPath}`)
  console.log(`Audio: ${audioPath}\n`)

  const tracker = createJobTracker()
  const config = { modelPath, modelType: 'ctc', maxThreads: 4, useGPU: false }

  console.log('1. Creating Parakeet CTC instance...')
  const parakeet = new ParakeetInterface(
    binding,
    config,
    createOutputCallback(tracker, { verbose: true }),
    (instance, state) => console.log(`   State: ${state}`)
  )

  console.log('\n2. Loading model weights...')
  await loadModelWeights(parakeet, modelPath, CTC_MODEL_FILES)

  console.log('\n3. Activating model...')
  await parakeet.activate()

  console.log('\n4. Processing audio...')
  const audioData = parseWavFile(audioPath)
  console.log(`   Audio: ${audioData.length} samples (${(audioData.length / 16000).toFixed(2)}s)`)

  console.log('\n5. Transcribing...')
  await parakeet.append({ type: 'audio', data: audioData.buffer })
  await parakeet.append({ type: 'end of job' })

  const timeout = setTimeout(() => tracker.resolve(), 60000)
  await tracker.promise
  clearTimeout(timeout)

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
