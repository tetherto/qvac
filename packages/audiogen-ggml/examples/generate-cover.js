'use strict'

const fs = require('bare-fs')
const process = require('bare-process')
const { AudioGen } = require('..')

const SAMPLE_RATE = 48000
const CHANNELS = 2
const FLOAT_BYTES = 4

function requiredEnv(name) {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

function readFloat32Pcm(file) {
  const bytes = fs.readFileSync(file)
  const frameBytes = FLOAT_BYTES * CHANNELS
  if (bytes.length === 0 || bytes.length % frameBytes !== 0) {
    throw new Error(`${file} must contain interleaved stereo ${SAMPLE_RATE} Hz Float32 PCM`)
  }

  const pcm = new Float32Array(bytes.length / FLOAT_BYTES)
  for (let index = 0; index < pcm.length; index++) {
    pcm[index] = bytes.readFloatLE(index * FLOAT_BYTES)
  }
  return pcm
}

async function collectGeneratedPcm(response) {
  const chunks = []
  let sampleRate = 0
  let channels = 0
  for await (const item of response.iterate()) {
    if (!item.outputArray) continue
    sampleRate = item.sampleRate
    channels = item.channels
    chunks.push(
      Buffer.from(
        item.outputArray.buffer.slice(
          item.outputArray.byteOffset,
          item.outputArray.byteOffset + item.outputArray.byteLength
        )
      )
    )
  }
  await response.await()
  return { pcm: Buffer.concat(chunks), sampleRate, channels }
}

function resolveOutputPath(extension) {
  const output = process.env.AUDIOGEN_OUT || 'audiogen-cover'
  return output.endsWith(`.${extension}`) ? output : `${output}.${extension}`
}

async function main() {
  const modelDir = requiredEnv('AUDIOGEN_MODEL_DIR')
  const sourceAudio = readFloat32Pcm(requiredEnv('AUDIOGEN_SOURCE_PCM'))
  const referenceAudio = process.env.AUDIOGEN_REFERENCE_PCM
    ? readFloat32Pcm(process.env.AUDIOGEN_REFERENCE_PCM)
    : undefined
  const caption =
    process.env.AUDIOGEN_CAPTION ||
    process.argv[2] ||
    'Orchestral arrangement with dramatic strings'
  const coverNoiseStrength = Number(process.env.AUDIOGEN_COVER_NOISE || 0.75)
  const useGPU = /^(1|true|yes|on)$/i.test(process.env.AUDIOGEN_GPU || '')
  const ditVariant = process.env.AUDIOGEN_DIT_VARIANT || 'turbo-q4'
  const gen = new AudioGen({
    files: { modelDir, ditVariant },
    config: { useGPU }
  })

  try {
    await gen.load()
    const response = await gen.run(caption, {
      lyrics: process.env.AUDIOGEN_LYRICS || '[Instrumental]',
      taskType: 'cover-nofsq',
      sourceAudio,
      referenceAudio,
      audioCoverStrength: 1,
      coverNoiseStrength,
      seed: Number(process.env.AUDIOGEN_SEED || 22886)
    })
    const result = await collectGeneratedPcm(response)
    const encoded = AudioGen.encode(result.pcm, 'wav', {
      sampleRate: result.sampleRate,
      channels: result.channels
    })
    const output = resolveOutputPath(encoded.extension)
    fs.writeFileSync(output, encoded.data)
    console.log(`[audiogen] cover written to ${output}`)
  } finally {
    await gen.destroy()
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
