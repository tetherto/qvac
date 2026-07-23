'use strict'

// Usage (the native addon links the ACE-Step engine from audiogen-cpp):
//
//   bare examples/generate-music.js "lo-fi hip hop, mellow piano, rainy night"
//
// Env:
//   AUDIOGEN_MODEL_DIR   directory holding the ACE-Step GGUFs
//   AUDIOGEN_CAPTION     prompt (overrides argv[2])
//   AUDIOGEN_LYRICS      lyrics text ("[Instrumental]" for no vocals)
//   AUDIOGEN_LANG        vocal language hint, e.g. "pt"
//   AUDIOGEN_BPM         beats per minute (integer)
//   AUDIOGEN_KEY         key/scale, e.g. "C minor"
//   AUDIOGEN_TSIG        time signature, e.g. "4/4"
//   AUDIOGEN_DUR         target seconds (omit => LM decides length)
//   AUDIOGEN_SEED        RNG seed
//   AUDIOGEN_FORMAT      output format: "wav" (default) or "pcm"
//   AUDIOGEN_GPU         "1" to run the whole pipeline (LM/DiT/encoders AND the
//                        VAE) on GPU (Metal/CUDA/Vulkan). Falls back to CPU if
//                        no GPU backend is available.
//   AUDIOGEN_OUT         output path (extension auto-added if missing)

const fs = require('bare-fs')
const process = require('bare-process')
const { AudioGen } = require('..')

function numEnv (name) {
  const v = process.env[name]
  return v === undefined || v === '' ? undefined : Number(v)
}

async function main () {
  const caption =
    process.env.AUDIOGEN_CAPTION ||
    process.argv[2] ||
    'Upbeat pop rock with driving electric guitars, punchy drums and a catchy hook'
  const modelDir = process.env.AUDIOGEN_MODEL_DIR
  const ditModel = process.env.AUDIOGEN_DIT || undefined
  // GPU (Metal/CUDA/Vulkan) for the whole pipeline including the VAE (its
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
    seed: numEnv('AUDIOGEN_SEED')
  }

  console.log('[audiogen] prompt: ' + caption)
  console.log('[audiogen] lyrics: ' + (opts.lyrics.split('\n')[0] || '').slice(0, 60))

  // PCM is delivered through the native output callback (interleaved stereo
  // Int16 + sampleRate/channels). runJob returns as soon as the job is queued,
  // so completion is signalled by the trailing stats event (audioDurationMs) or
  // an error string — gate on a promise that those resolve.
  const chunks = []
  let sampleRate = 48000
  let channels = 2
  let done
  const finished = new Promise((resolve, reject) => { done = { resolve, reject } })

  const outputCb = (_handle, _event, data, error) => {
    if (typeof error === 'string' && error.length > 0) {
      done.reject(new Error(error))
      return
    }
    if (data && data.outputArray) {
      if (data.sampleRate != null) sampleRate = data.sampleRate
      if (data.channels != null) channels = data.channels
      chunks.push(Buffer.from(data.outputArray.buffer.slice(
        data.outputArray.byteOffset,
        data.outputArray.byteOffset + data.outputArray.byteLength)))
      return
    }
    if (data && (typeof data.audioDurationMs === 'number' ||
                 typeof data.totalTimeMs === 'number')) {
      done.resolve()
    }
  }

  const gen = new AudioGen({ modelDir, ditModel, useGpu: useGPU }, outputCb)
  await gen.activate()

  const t0 = Date.now()
  await gen.generate(caption, opts)
  await finished
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1)

  const pcm = Buffer.concat(chunks)
  const { data, extension } = AudioGen.encode(pcm, outFormat, { sampleRate, channels })
  const outFile = outFileRaw.endsWith('.' + extension)
    ? outFileRaw
    : outFileRaw + '.' + extension
  fs.writeFileSync(outFile, data)

  const totalSamples = pcm.length / 2
  console.log('[audiogen] done in ' + elapsed + 's')
  console.log('[audiogen] samples:   ' + totalSamples + ' (' + (totalSamples / channels / sampleRate).toFixed(1) + 's)')
  console.log('[audiogen] rate:      ' + sampleRate + ' Hz, ' + channels + 'ch')
  console.log('[audiogen] ' + extension.toUpperCase() + ' ->      ' + outFile)

  await gen.destroy()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
