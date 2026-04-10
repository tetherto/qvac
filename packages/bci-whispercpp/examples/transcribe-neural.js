'use strict'

/**
 * Transcribe neural signal files using the BCI BrainWhisperer model.
 * Uses the native whisper.cpp GGML backend.
 *
 * Usage:
 *   node examples/transcribe-neural.js <signal.bin> [model_path]
 *
 * Or batch mode (all test fixtures):
 *   node examples/transcribe-neural.js --batch [model_path]
 */

const fs = require('bare-fs')
const path = require('bare-path')
const os = require('bare-os')
const BCIWhispercpp = require('../index')

const DEFAULT_MODEL = (os.hasEnv('WHISPER_MODEL_PATH') ? os.getEnv('WHISPER_MODEL_PATH') : null) ||
  path.join(__dirname, '..', 'models', 'ggml-bci-windowed.bin')

async function main () {
  const args = global.Bare ? global.Bare.argv.slice(2) : process.argv.slice(2)
  const isBatch = args[0] === '--batch'

  if (args.length < 1) {
    console.log('Usage:')
    console.log('  Single: bare examples/transcribe-neural.js <signal.bin> [model_path]')
    console.log('  Batch:  bare examples/transcribe-neural.js --batch [model_path]')
    return
  }

  const modelPath = (isBatch ? args[1] : args[1]) || DEFAULT_MODEL
  if (!fs.existsSync(modelPath)) {
    console.error(`Error: Model file not found: ${modelPath}`)
    console.error('Set WHISPER_MODEL_PATH or pass as second argument.')
    return
  }

  const bci = new BCIWhispercpp({ modelPath }, {
    whisperConfig: { language: 'en', temperature: 0.0 },
    miscConfig: { caption_enabled: false }
  })

  await bci.load()
  console.log('Model loaded.\n')

  if (isBatch) {
    const manifestPath = path.join(__dirname, '..', 'test', 'fixtures', 'manifest.json')
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))

    console.log(`=== BCI Neural Signal Transcription (Batch: ${manifest.samples.length} samples) ===\n`)

    const startTime = Date.now()

    for (const sample of manifest.samples) {
      const samplePath = path.join(__dirname, '..', 'test', 'fixtures', sample.file)
      if (!fs.existsSync(samplePath)) {
        console.log(`  [SKIP] ${sample.file} (not found)`)
        continue
      }

      const result = await bci.transcribeFile(samplePath)
      const wer = BCIWhispercpp.computeWER(result.text, sample.expected_text)

      console.log(`  [${sample.file}]`)
      console.log(`    Got:      "${result.text}"`)
      console.log(`    Expected: "${sample.expected_text}"`)
      console.log(`    WER:      ${(wer * 100).toFixed(1)}%\n`)
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2)
    console.log(`Time: ${elapsed}s`)
  } else {
    const signalPath = args[0]
    if (!fs.existsSync(signalPath)) {
      console.error(`Error: Signal file not found: ${signalPath}`)
      return
    }

    const buf = fs.readFileSync(signalPath)
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
    const T = view.getUint32(0, true)
    const C = view.getUint32(4, true)

    console.log('=== BCI Neural Signal Transcription ===')
    console.log(`Signal:     ${signalPath}`)
    console.log(`Timesteps:  ${T}, Channels: ${C}`)
    console.log(`Duration:   ~${(T * 20 / 1000).toFixed(1)}s\n`)

    const startTime = Date.now()
    const result = await bci.transcribeFile(signalPath)
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2)

    console.log(`Text: "${result.text}"`)
    console.log(`Time: ${elapsed}s`)
  }

  await bci.destroy()
  console.log('\nDone.')
}

main().catch((err) => {
  console.error('Error:', err.message || err)
})
