'use strict'

/**
 * Transcribe neural signal files using the BCI BrainWhisperer model.
 * Uses the native whisper.cpp GGML backend.
 *
 * Usage:
 *   bare examples/transcribe-neural.js <signal.bin> [model_path]
 *
 * Or batch mode (all test fixtures):
 *   bare examples/transcribe-neural.js --batch [model_path]
 */

const fs = require('bare-fs')
const path = require('bare-path')
const os = require('bare-os')
const BCIWhispercpp = require('../index')
const { flattenSegments } = require('../lib/util')

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

  // Single-signal mode: args[0]=signal, args[1]=optional model
  // Batch mode:         args[0]='--batch', args[1]=optional model
  const modelPath = args[1] || DEFAULT_MODEL
  if (!fs.existsSync(modelPath)) {
    console.error('Error: Model file not found: ' + modelPath)
    console.error('Set WHISPER_MODEL_PATH or pass as second argument.')
    return
  }

  if (isBatch) {
    const manifestPath = path.join(__dirname, '..', 'test', 'fixtures', 'manifest.json')
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))

    console.log('=== BCI Neural Signal Transcription (Batch: ' + manifest.samples.length + ' samples) ===\n')

    const startTime = Date.now()

    const byDay = new Map()
    for (const sample of manifest.samples) {
      const key = typeof sample.day_idx === 'number' ? sample.day_idx : -1
      if (!byDay.has(key)) byDay.set(key, [])
      byDay.get(key).push(sample)
    }

    let total = 0
    let sumWER = 0

    for (const [day, samples] of byDay) {
      const bci = new BCIWhispercpp({
        files: { model: modelPath }
      }, {
        whisperConfig: { language: 'en', temperature: 0.0 },
        miscConfig: { caption_enabled: false },
        bciConfig: day >= 0 ? { day_idx: day } : undefined
      })
      await bci.load()

      try {
        for (const sample of samples) {
          const samplePath = path.join(__dirname, '..', 'test', 'fixtures', sample.file)
          if (!fs.existsSync(samplePath)) {
            console.log('  [SKIP] ' + sample.file + ' (not found)')
            continue
          }

          const response = await bci.transcribeFile(samplePath)
          const output = await response.await()
          const segments = flattenSegments(output)
          const text = segments.map(s => s.text).join('').trim()
          const wer = BCIWhispercpp.computeWER(text, sample.expected_text)

          console.log('  [' + sample.file + '] day=' + day)
          console.log('    Got:      "' + text + '"')
          console.log('    Expected: "' + sample.expected_text + '"')
          console.log('    WER:      ' + (wer * 100).toFixed(1) + '%\n')

          total += 1
          sumWER += wer
        }
      } finally {
        await bci.destroy()
      }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2)
    const avgWER = total > 0 ? sumWER / total : 0
    console.log('Average WER: ' + (avgWER * 100).toFixed(1) + '% (n=' + total + ')')
    console.log('Time: ' + elapsed + 's')
  } else {
    const signalPath = args[0]
    if (!fs.existsSync(signalPath)) {
      console.error('Error: Signal file not found: ' + signalPath)
      return
    }

    const bci = new BCIWhispercpp({
      files: { model: modelPath }
    }, {
      whisperConfig: { language: 'en', temperature: 0.0 },
      miscConfig: { caption_enabled: false }
    })

    await bci.load()
    console.log('Model loaded.\n')

    const buf = fs.readFileSync(signalPath)
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
    const T = view.getUint32(0, true)
    const C = view.getUint32(4, true)

    console.log('=== BCI Neural Signal Transcription ===')
    console.log('Signal:     ' + signalPath)
    console.log('Timesteps:  ' + T + ', Channels: ' + C)
    console.log('Duration:   ~' + (T * 20 / 1000).toFixed(1) + 's\n')

    try {
      const startTime = Date.now()
      const response = await bci.transcribeFile(signalPath)
      const output = await response.await()
      const segments = flattenSegments(output)
      const text = segments.map(s => s.text).join('').trim()
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(2)

      console.log('Text: "' + text + '"')
      console.log('Time: ' + elapsed + 's')
    } finally {
      await bci.destroy()
    }
  }

  console.log('\nDone.')
}

main().catch((err) => {
  console.error('Error:', err.message || err)
})
