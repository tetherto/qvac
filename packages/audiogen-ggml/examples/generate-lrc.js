'use strict'

// Usage (LRC generation: a song plus karaoke-style synchronized lyrics):
//
//   bare examples/generate-lrc.js "romantic salsa with warm male vocals"
//
// Env:
//   AUDIOGEN_MODEL_DIR   required directory holding the ACE-Step GGUFs
//   AUDIOGEN_DIT_VARIANT named DiT variant: turbo-q4, turbo-q8, or sft
//   AUDIOGEN_DIT         explicit DiT model path; overrides AUDIOGEN_DIT_VARIANT
//   AUDIOGEN_CAPTION     prompt (overrides argv[2])
//   AUDIOGEN_LYRICS      lyrics to sing and align (a default verse otherwise)
//   AUDIOGEN_DUR         target seconds (default 24)
//   AUDIOGEN_SEED        RNG seed
//   AUDIOGEN_GPU         "1" to run the pipeline on GPU (Metal/Vulkan)
//   AUDIOGEN_OUT         output base path: writes <out>.wav and <out>.lrc

const fs = require('bare-fs')
const process = require('bare-process')
const { AudioGen } = require('..')

const DEFAULT_LYRICS =
  '[verse]\nDancing with you under the moonlight\nyour laughter carries me through the night'

function requiredEnv(name) {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

function numEnv(name) {
  const v = process.env[name]
  return v === undefined || v === '' ? undefined : Number(v)
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
    process.env.AUDIOGEN_CAPTION || process.argv[2] || 'romantic salsa with warm male vocals'
  const modelDir = requiredEnv('AUDIOGEN_MODEL_DIR')
  const ditModel = process.env.AUDIOGEN_DIT || undefined
  const ditVariant = process.env.AUDIOGEN_DIT_VARIANT || undefined
  const useGPU = /^(1|true|yes|on)$/i.test(process.env.AUDIOGEN_GPU || '')
  const outBase = process.env.AUDIOGEN_OUT || 'audiogen-lrc'

  const opts = {
    generateLrc: true,
    lyrics: process.env.AUDIOGEN_LYRICS || DEFAULT_LYRICS,
    duration: numEnv('AUDIOGEN_DUR') ?? 24,
    seed: numEnv('AUDIOGEN_SEED')
  }

  console.log('[audiogen] prompt: ' + caption)

  const gen = new AudioGen({
    files: { modelDir, ditModel, ditVariant },
    config: { useGPU }
  })
  try {
    await gen.load()
    const response = await gen.run(caption, opts)
    const { pcm, sampleRate, channels, stats } = await collectOutput(response)
    const { data } = AudioGen.encode(pcm, 'wav', { sampleRate, channels })
    fs.writeFileSync(outBase + '.wav', data)
    fs.writeFileSync(outBase + '.lrc', stats.lrc ?? '')
    console.log(
      `[audiogen] wrote ${outBase}.wav and ${outBase}.lrc ` +
        `(lyrics score ${stats.lyricsScore?.toFixed(4) ?? 'n/a'})`
    )
    console.log(stats.lrc ?? '(no lrc)')
  } finally {
    await gen.destroy()
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
