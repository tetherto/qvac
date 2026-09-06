'use strict'

// Usage (Simple Mode: a one-sentence query becomes a full song):
//
//   bare examples/generate-simple-mode.js "a romantic modern salsa with male lead vocals for a wedding"
//
// Env:
//   AUDIOGEN_MODEL_DIR   required directory holding the ACE-Step GGUFs
//   AUDIOGEN_DIT_VARIANT named DiT variant: turbo-q4, turbo-q8, or sft
//   AUDIOGEN_DIT         explicit DiT model path; overrides AUDIOGEN_DIT_VARIANT
//   AUDIOGEN_CAPTION     query (overrides argv[2])
//   AUDIOGEN_LYRICS      "[Instrumental]" for a song without vocals; leave
//                        unset so the LM writes the lyrics
//   AUDIOGEN_DUR         target seconds (default 0 = the LM decides length)
//   AUDIOGEN_SEED        RNG seed
//   AUDIOGEN_FORMAT      output format: "wav" (default) or "pcm"
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
  await response.await()
  return { pcm: Buffer.concat(chunks), sampleRate, channels }
}

async function main() {
  const query =
    process.env.AUDIOGEN_CAPTION ||
    process.argv[2] ||
    'a romantic modern salsa with male lead vocals for a wedding'
  const modelDir = requiredEnv('AUDIOGEN_MODEL_DIR')
  const ditModel = process.env.AUDIOGEN_DIT || undefined
  const ditVariant = process.env.AUDIOGEN_DIT_VARIANT || undefined
  const useGPU = /^(1|true|yes|on)$/i.test(process.env.AUDIOGEN_GPU || '')
  const outFormat = (process.env.AUDIOGEN_FORMAT || 'wav').toLowerCase()
  const outFileRaw = process.env.AUDIOGEN_OUT || 'audiogen-simple-mode'

  const opts = {
    simpleMode: true,
    lyrics: process.env.AUDIOGEN_LYRICS || undefined,
    duration: numEnv('AUDIOGEN_DUR') ?? 0,
    seed: numEnv('AUDIOGEN_SEED')
  }

  console.log('[audiogen] query: ' + query)

  const gen = new AudioGen({
    files: { modelDir, ditModel, ditVariant },
    config: { useGPU }
  })
  try {
    await gen.load()
    const t0 = Date.now()
    const response = await gen.run(query, opts)
    const { pcm, sampleRate, channels } = await collectOutput(response)
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
    const { data, extension } = AudioGen.encode(pcm, outFormat, { sampleRate, channels })
    const outFile = outFileRaw.endsWith('.' + extension) ? outFileRaw : outFileRaw + '.' + extension
    fs.writeFileSync(outFile, data)

    const totalSamples = pcm.length / 2
    console.log('[audiogen] done in ' + elapsed + 's')
    console.log(
      '[audiogen] wrote ' +
        outFile +
        ' (' +
        (totalSamples / channels / sampleRate).toFixed(1) +
        's)'
    )
  } finally {
    await gen.destroy()
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
