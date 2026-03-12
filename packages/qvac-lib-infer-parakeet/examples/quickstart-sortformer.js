'use strict'

/**
 * Parakeet Sortformer Quickstart Example
 *
 * Speaker diarization using the Sortformer model.
 * Identifies who is speaking when (up to 4 speakers).
 *
 * Usage: bare examples/quickstart-sortformer.js
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
  SORTFORMER_MODEL_FILES
} = require('./utils.js')

async function main () {
  console.log('=== Parakeet Sortformer (Speaker Diarization) ===\n')

  setupLogger(binding)
  const modelPath = path.join(__dirname, '..', 'models', 'sortformer-4spk-v2-onnx')
  const audioPath = path.join(__dirname, 'samples', 'sample-16k.wav')

  if (!validatePaths({ model: modelPath, audio: audioPath })) {
    binding.releaseLogger()
    return
  }

  console.log(`Model: ${modelPath}`)
  console.log(`Audio: ${audioPath}\n`)

  const tracker = createJobTracker()
  const config = { modelPath, modelType: 'sortformer', maxThreads: 4, useGPU: false }

  console.log('1. Creating Sortformer instance...')
  const parakeet = new ParakeetInterface(
    binding,
    config,
    createOutputCallback(tracker, { verbose: true }),
    (instance, state) => console.log(`   State: ${state}`)
  )

  console.log('\n2. Loading model weights...')
  await loadModelWeights(parakeet, modelPath, SORTFORMER_MODEL_FILES)

  console.log('\n3. Activating model...')
  await parakeet.activate()

  console.log('\n4. Processing audio...')
  const audioData = parseWavFile(audioPath)
  console.log(`   Audio: ${audioData.length} samples (${(audioData.length / 16000).toFixed(2)}s)`)

  console.log('\n5. Running diarization...')
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
