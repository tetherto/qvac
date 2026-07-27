'use strict'

const fs = require('bare-fs')
const path = require('bare-path')
const process = require('bare-process')
const { FFmpegDecoder } = require('@qvac/decoder-audio')

// ---------------------------------------------------------------------------
// Audio -> raw PCM for LAM audio2expression.
//
// LamAudio2Expression.run() takes a Float32Array of 16kHz mono samples. This
// turns any container ffmpeg can demux (wav, mp3, m4a, ogg, ...) into a headless
// little-endian float32 file that examples and fixtures can mmap straight into
// a Float32Array.
//
//   bare scripts/wav-to-pcm.js input.wav
//   bare scripts/wav-to-pcm.js input.wav -o fixtures/speech.pcm
// ---------------------------------------------------------------------------

const SAMPLE_RATE = 16000
const AUDIO_FORMAT = 'f32le'
const BYTES_PER_SAMPLE = 4

function usage() {
  console.log(`Usage: bare scripts/wav-to-pcm.js <input> [options]

Decodes <input> to raw mono little-endian float32 PCM at ${SAMPLE_RATE}Hz —
the exact layout LamAudio2Expression.run() expects.

Options:
  -o, --out <file>        Output path (default: <input> with a .pcm extension)
      --sample-rate <hz>  Output sample rate (default: ${SAMPLE_RATE})
  -h, --help              Show this message
`)
}

function parseArgs(argv) {
  const opts = { input: '', out: '', sampleRate: SAMPLE_RATE }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    switch (arg) {
      case '-h':
      case '--help':
        return null
      case '-o':
      case '--out':
        opts.out = argv[++i]
        break
      case '--sample-rate':
        opts.sampleRate = Number(argv[++i])
        break
      default:
        if (arg.startsWith('-')) throw new Error(`unknown option: ${arg}`)
        if (opts.input) throw new Error(`unexpected extra argument: ${arg}`)
        opts.input = arg
    }
  }

  if (!opts.input) throw new Error('missing <input>')
  if (!Number.isInteger(opts.sampleRate) || opts.sampleRate <= 0) {
    throw new Error(`--sample-rate must be a positive integer, got: ${opts.sampleRate}`)
  }
  if (!opts.out) {
    const ext = path.extname(opts.input)
    opts.out = `${opts.input.slice(0, opts.input.length - ext.length)}.pcm`
  }

  return opts
}

async function decodeToPcm(inputPath, sampleRate) {
  // audioFormat must be passed explicitly: the FFmpegDecoder constructor
  // defaults to 's16le' even though its JSDoc advertises 'f32le'.
  const decoder = new FFmpegDecoder({
    config: { audioFormat: AUDIO_FORMAT, sampleRate }
  })

  await decoder.load()

  try {
    const chunks = []
    let totalBytes = 0

    const response = await decoder.run(fs.createReadStream(inputPath))
    await response
      .onUpdate((output) => {
        if (!output || !output.outputArray) return
        const bytes = new Uint8Array(output.outputArray)
        chunks.push(bytes)
        totalBytes += bytes.byteLength
      })
      .await()

    return { chunks, totalBytes, stats: decoder.runtimeStats() }
  } finally {
    await decoder.unload()
  }
}

async function main() {
  let opts
  try {
    opts = parseArgs(process.argv.slice(2))
  } catch (err) {
    console.error(`Error: ${err.message}\n`)
    usage()
    process.exit(1)
  }

  if (opts === null) {
    usage()
    return
  }

  if (!fs.existsSync(opts.input)) {
    console.error(`Error: input file not found: ${opts.input}`)
    process.exit(1)
  }

  console.log(`Decoding ${opts.input} -> ${opts.out}`)

  const { chunks, totalBytes, stats } = await decodeToPcm(opts.input, opts.sampleRate)

  if (totalBytes === 0) {
    console.error('Error: decoded 0 bytes — does the input contain an audio stream?')
    process.exit(1)
  }

  const outDir = path.dirname(opts.out)
  if (outDir && !fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true })
  fs.writeFileSync(opts.out, Buffer.concat(chunks))

  const sampleCount = totalBytes / BYTES_PER_SAMPLE
  console.log(`Codec       : ${stats.codecName} @ ${stats.inputSampleRate}Hz`)
  console.log(`Output      : ${AUDIO_FORMAT} mono @ ${opts.sampleRate}Hz`)
  console.log(`Samples     : ${sampleCount} (${(sampleCount / opts.sampleRate).toFixed(2)}s)`)
  console.log(`Wrote       : ${totalBytes} bytes to ${opts.out}`)
  console.log(`\nRun it with:\n  AUDIO_PCM_PATH=${opts.out} bare examples/lam-a2e.js`)
}

main().catch((err) => {
  console.error('Fatal:', err.message || err)
  process.exit(1)
})
