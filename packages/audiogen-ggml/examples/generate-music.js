'use strict'

// Usage (the native addon links the ACE-Step engine from audiogen-cpp):
//
//   bare examples/generate-music.js "lo-fi hip hop, mellow piano, rainy night"
//
// Env:
//   AUDIOGEN_MODEL_DIR   required directory holding the ACE-Step GGUFs
//   AUDIOGEN_DIT_VARIANT named DiT variant: turbo-q4, turbo-q8, or sft
//   AUDIOGEN_DIT         explicit DiT model path; overrides AUDIOGEN_DIT_VARIANT
//   AUDIOGEN_CAPTION     prompt (overrides argv[2])
//   AUDIOGEN_LYRICS      lyrics text ("[Instrumental]" for no vocals)
//   AUDIOGEN_LANG        vocal language hint, e.g. "pt"
//   AUDIOGEN_BPM         beats per minute (integer)
//   AUDIOGEN_KEY         key/scale, e.g. "C minor"
//   AUDIOGEN_TSIG        time signature, e.g. "4/4"
//   AUDIOGEN_DUR         target seconds (omit => LM decides length)
//   AUDIOGEN_SEED        RNG seed
//   AUDIOGEN_CODES       JSON file containing `audio_codes` as CSV or an array;
//                        skips the LM for deterministic synthesis comparisons
//   AUDIOGEN_DCW         "0" to disable Haar DCW (enabled by default)
//   AUDIOGEN_DCW_LOW     low-band DCW strength (default 0.05)
//   AUDIOGEN_DCW_HIGH    high-band DCW strength (default 0.02)
//   AUDIOGEN_FORMAT      output format: "wav" (default) or "pcm"
//   AUDIOGEN_GPU         "1" to run the whole pipeline (LM/DiT/encoders AND the
//                        VAE) on GPU (Metal/Vulkan). Falls back to CPU if
//                        no GPU backend is available.
//   AUDIOGEN_OUT         output path (extension auto-added if missing)

const fs = require('bare-fs')
const process = require('bare-process')
const { AudioGen } = require('..')

function requiredEnv(name) {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

function numEnv(name) {
  const v = process.env[name]
  return v === undefined || v === '' ? undefined : Number(v)
}

function audioCodesEnv() {
  const file = process.env.AUDIOGEN_CODES
  if (!file) return undefined
  const value = JSON.parse(fs.readFileSync(file, 'utf8')).audio_codes
  const codes = Array.isArray(value) ? value : String(value).split(',').filter(Boolean).map(Number)
  return Int32Array.from(codes)
}

function boolEnv(name) {
  const v = process.env[name]
  if (v === undefined || v === '') return undefined
  return /^(1|true|yes|on)$/i.test(v)
}

function pcmBytes(outputArray) {
  return Buffer.from(
    outputArray.buffer.slice(
      outputArray.byteOffset,
      outputArray.byteOffset + outputArray.byteLength
    )
  )
}

async function collectOutput(response) {
  const chunks = []
  let sampleRate = 0
  let channels = 0
  for await (const item of response.iterate()) {
    if (item.progress) {
      console.log(`[audiogen] ${item.progress.stage}: ${item.progress.step}/${item.progress.total}`)
      continue
    }
    if (item.outputArray) {
      sampleRate = item.sampleRate
      channels = item.channels
      chunks.push(pcmBytes(item.outputArray))
    }
  }
  const stats = await response.await()
  return { pcm: Buffer.concat(chunks), sampleRate, channels, stats }
}

async function main() {
  const caption =
    process.env.AUDIOGEN_CAPTION ||
    process.argv[2] ||
    'Upbeat pop rock with driving electric guitars, punchy drums and a catchy hook'
  const modelDir = requiredEnv('AUDIOGEN_MODEL_DIR')
  const ditModel = process.env.AUDIOGEN_DIT || undefined
  const ditVariant = process.env.AUDIOGEN_DIT_VARIANT || undefined
  // GPU (Metal/Vulkan) for the whole pipeline including the VAE (its
  // snake/col2im_1d ops now have Metal kernels). Falls back to CPU if no GPU.
  const useGPU = /^(1|true|yes|on)$/i.test(process.env.AUDIOGEN_GPU || '')
  const outFormat = (process.env.AUDIOGEN_FORMAT || 'wav').toLowerCase()
  const outFileRaw = process.env.AUDIOGEN_OUT || 'audiogen-output'

  const opts = {
    lyrics: process.env.AUDIOGEN_LYRICS || '[Instrumental]',
    vocalLanguage: process.env.AUDIOGEN_LANG || undefined,
    bpm: numEnv('AUDIOGEN_BPM'),
    keyscale: process.env.AUDIOGEN_KEY || undefined,
    timesignature: process.env.AUDIOGEN_TSIG || undefined,
    duration: numEnv('AUDIOGEN_DUR'),
    seed: numEnv('AUDIOGEN_SEED'),
    dcwEnabled: boolEnv('AUDIOGEN_DCW'),
    dcwScaler: numEnv('AUDIOGEN_DCW_LOW'),
    dcwHighScaler: numEnv('AUDIOGEN_DCW_HIGH'),
    audioCodes: audioCodesEnv()
  }

  console.log('[audiogen] prompt: ' + caption)
  console.log('[audiogen] lyrics: ' + (opts.lyrics.split('\n')[0] || '').slice(0, 60))

  const gen = new AudioGen({
    files: { modelDir, ditModel, ditVariant },
    config: { useGPU }
  })
  try {
    await gen.load()
    const t0 = Date.now()
    const response = await gen.run(caption, opts)
    const { pcm, sampleRate, channels, stats } = await collectOutput(response)
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
    const { data, extension } = AudioGen.encode(pcm, outFormat, { sampleRate, channels })
    const outFile = outFileRaw.endsWith('.' + extension) ? outFileRaw : outFileRaw + '.' + extension
    fs.writeFileSync(outFile, data)

    const totalSamples = pcm.length / 2
    console.log('[audiogen] done in ' + elapsed + 's')
    console.log(
      '[audiogen] samples:   ' +
        totalSamples +
        ' (' +
        (totalSamples / channels / sampleRate).toFixed(1) +
        's)'
    )
    console.log('[audiogen] rate:      ' + sampleRate + ' Hz, ' + channels + 'ch')
    console.log('[audiogen] stats:     ' + JSON.stringify(stats))
    console.log('[audiogen] ' + extension.toUpperCase() + ' ->      ' + outFile)
  } finally {
    await gen.destroy()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
