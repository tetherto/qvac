'use strict'

const fs = require('bare-fs')
const path = require('bare-path')
const os = require('bare-os')
const BCIWhispercpp = require('../index')
const { flattenSegments } = require('../lib/util')

const DEFAULT_MODEL = (os.hasEnv('WHISPER_MODEL_PATH') ? os.getEnv('WHISPER_MODEL_PATH') : null) ||
  path.join(__dirname, '..', 'models', 'ggml-bci-windowed.bin')

async function * chunkify (bytes, chunkSize) {
  for (let i = 0; i < bytes.byteLength; i += chunkSize) {
    yield bytes.subarray(i, Math.min(i + chunkSize, bytes.byteLength))
  }
}

async function main () {
  const args = global.Bare ? global.Bare.argv.slice(2) : process.argv.slice(2)

  if (args.length < 1) {
    console.log('Usage: bare examples/transcribe-stream-neural.js <signal.bin> [model_path]')
    return
  }

  const signalPath = args[0]
  const modelPath = args[1] || DEFAULT_MODEL

  if (!fs.existsSync(signalPath)) {
    console.error('Error: Signal file not found: ' + signalPath)
    return
  }
  if (!fs.existsSync(modelPath)) {
    console.error('Error: Model file not found: ' + modelPath)
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
  const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)

  console.log('=== BCI Streaming Transcription ===')
  console.log('Signal: ' + signalPath + ' (' + bytes.byteLength + ' bytes)')
  console.log('Feeding stream in 4 KB chunks...\n')

  try {
    const startedAt = Date.now()
    const response = await bci.transcribeStream(chunkify(bytes, 4096), {
      windowTimesteps: 1500,
      hopTimesteps: 500
    })

    response.onUpdate((out) => {
      const segs = flattenSegments(out)
      const piece = segs.map(s => s.text).join(' ').trim()
      if (piece.length > 0) {
        const elapsed = ((Date.now() - startedAt) / 1000).toFixed(2)
        console.log('[' + elapsed + 's] +' + piece)
      }
    })

    const output = await response.await()
    const segments = flattenSegments(output)
    const fullText = segments.map(s => s.text).join(' ').trim()
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(2)

    console.log('\nFinal: "' + fullText + '"')
    console.log('Time:  ' + elapsed + 's')
  } finally {
    await bci.destroy()
  }

  console.log('\nDone.')
}

main().catch((err) => {
  console.error('Error:', err.message || err)
})
