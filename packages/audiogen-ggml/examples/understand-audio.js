'use strict'

// Usage (Audio Understanding: generate a short clip, then ask the engine to
// describe it — metadata, caption, and the recovered semantic codes):
//
//   bare examples/understand-audio.js "lo-fi hip hop, mellow piano, rainy night"
//
// Env:
//   AUDIOGEN_MODEL_DIR   required directory holding the ACE-Step GGUFs
//   AUDIOGEN_DIT_VARIANT named DiT variant: turbo-q4, turbo-q8, or sft
//   AUDIOGEN_DIT         explicit DiT model path; overrides AUDIOGEN_DIT_VARIANT
//   AUDIOGEN_CAPTION     caption for the generated clip (overrides argv[2])
//   AUDIOGEN_DUR         generated clip length in seconds (default 8)
//   AUDIOGEN_SEED        RNG seed
//   AUDIOGEN_LANG        language hint forced into the description (e.g. "es")
//   AUDIOGEN_GPU         "1" to run the pipeline on GPU (Metal/Vulkan)

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

async function collectPcm(response) {
  const chunks = []
  for await (const item of response.iterate()) {
    if (item.progress) {
      console.log(`[audiogen] ${item.progress.stage}: ${item.progress.step}/${item.progress.total}`)
      continue
    }
    if (item.outputArray) chunks.push(item.outputArray)
  }
  await response.await()
  let samples = 0
  for (const chunk of chunks) samples += chunk.length
  const pcm = new Float32Array(samples)
  let offset = 0
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.length; i++) pcm[offset + i] = chunk[i] / 32768
    offset += chunk.length
  }
  return pcm
}

async function main() {
  const caption =
    process.env.AUDIOGEN_CAPTION || process.argv[2] || 'lo-fi hip hop, mellow piano, rainy night'
  const modelDir = requiredEnv('AUDIOGEN_MODEL_DIR')
  const ditModel = process.env.AUDIOGEN_DIT || undefined
  const ditVariant = process.env.AUDIOGEN_DIT_VARIANT || undefined
  const useGPU = /^(1|true|yes|on)$/i.test(process.env.AUDIOGEN_GPU || '')
  const duration = numEnv('AUDIOGEN_DUR') ?? 8
  const seed = numEnv('AUDIOGEN_SEED')

  const gen = new AudioGen({
    files: { modelDir, ditModel, ditVariant },
    config: { useGPU }
  })
  try {
    await gen.load()

    console.log('[audiogen] generating a clip to describe: ' + caption)
    const generated = await gen.run(caption, {
      lyrics: '[Instrumental]',
      duration,
      seed
    })
    const pcm = await collectPcm(generated)

    console.log('[audiogen] listening back...')
    const response = await gen.understand(pcm, {
      seed,
      vocalLanguage: process.env.AUDIOGEN_LANG || undefined
    })
    const stats = await response.await()
    const heard = stats.understand

    console.log('[audiogen] caption:       ' + heard.caption)
    console.log('[audiogen] bpm:           ' + heard.bpm)
    console.log('[audiogen] keyscale:      ' + heard.keyscale)
    console.log('[audiogen] timesignature: ' + heard.timesignature)
    console.log('[audiogen] language:      ' + heard.vocalLanguage)
    console.log('[audiogen] duration est.: ' + heard.duration + 's')
    console.log('[audiogen] codes:         ' + heard.audioCodes.length)
  } finally {
    await gen.destroy()
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
