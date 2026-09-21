'use strict'

// Usage (best-of-N: generate several takes, keep the highest quality score):
//
//   bare examples/generate-best-of.js "lo-fi hip hop, mellow piano, rainy night"
//
// Env:
//   AUDIOGEN_MODEL_DIR   required directory holding the ACE-Step GGUFs
//   AUDIOGEN_DIT_VARIANT named DiT variant: turbo-q4, turbo-q8, or sft
//   AUDIOGEN_DIT         explicit DiT model path; overrides AUDIOGEN_DIT_VARIANT
//   AUDIOGEN_CAPTION     prompt (overrides argv[2])
//   AUDIOGEN_LYRICS      lyrics text ("[Instrumental]" for no vocals)
//   AUDIOGEN_TAKES       takes to generate and rank (default 3)
//   AUDIOGEN_DUR         target seconds (omit => LM decides length)
//   AUDIOGEN_SEED        seed of the first take; take N uses seed + N
//   AUDIOGEN_GPU         "1" to run the pipeline on GPU (Metal/Vulkan)
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
    if (item.progress) continue
    if (item.outputArray) {
      sampleRate = item.sampleRate
      channels = item.channels
      chunks.push(pcmBytes(item.outputArray))
    }
  }
  const stats = await response.await()
  return { pcm: Buffer.concat(chunks), sampleRate, channels, stats }
}

async function generateTake(gen, caption, opts, seed) {
  const response = await gen.run(caption, { ...opts, seed })
  const take = await collectOutput(response)
  console.log(`[audiogen] seed ${seed}: quality ${take.stats.qualityScore?.toFixed(4) ?? 'n/a'}`)
  return { ...take, seed }
}

function betterTake(best, candidate) {
  if (best === null) return candidate
  return (candidate.stats.qualityScore ?? 0) > (best.stats.qualityScore ?? 0) ? candidate : best
}

async function main() {
  const caption =
    process.env.AUDIOGEN_CAPTION || process.argv[2] || 'lo-fi hip hop, mellow piano, rainy night'
  const modelDir = requiredEnv('AUDIOGEN_MODEL_DIR')
  const ditModel = process.env.AUDIOGEN_DIT || undefined
  const ditVariant = process.env.AUDIOGEN_DIT_VARIANT || undefined
  const useGPU = /^(1|true|yes|on)$/i.test(process.env.AUDIOGEN_GPU || '')
  const takes = numEnv('AUDIOGEN_TAKES') ?? 3
  const firstSeed = numEnv('AUDIOGEN_SEED') ?? 1
  const outFileRaw = process.env.AUDIOGEN_OUT || 'audiogen-best-of'

  const opts = {
    computeQualityScore: true,
    lyrics: process.env.AUDIOGEN_LYRICS || '[Instrumental]',
    duration: numEnv('AUDIOGEN_DUR')
  }

  console.log(`[audiogen] prompt: ${caption} (${takes} takes)`)

  const gen = new AudioGen({
    files: { modelDir, ditModel, ditVariant },
    config: { useGPU }
  })
  try {
    await gen.load()
    let best = null
    for (let take = 0; take < takes; take++) {
      best = betterTake(best, await generateTake(gen, caption, opts, firstSeed + take))
    }
    const { data, extension } = AudioGen.encode(best.pcm, 'wav', {
      sampleRate: best.sampleRate,
      channels: best.channels
    })
    const outFile = outFileRaw.endsWith('.' + extension) ? outFileRaw : outFileRaw + '.' + extension
    fs.writeFileSync(outFile, data)
    console.log(
      `[audiogen] kept seed ${best.seed} (quality ${best.stats.qualityScore?.toFixed(4) ?? 'n/a'}) -> ${outFile}`
    )
  } finally {
    await gen.destroy()
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
