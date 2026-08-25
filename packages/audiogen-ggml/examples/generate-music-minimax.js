'use strict'

const fs = require('bare-fs')
const process = require('bare-process')
const { AudioGen, ENGINE_MINIMAX } = require('..')

const DEFAULT_CAPTION = 'Warm cinematic piano with gentle strings'
const DEFAULT_OUTPUT = 'minimax-music3-output.wav'

function requiredModelDir() {
  const modelDir = process.env.AUDIOGEN_TEST_MINIMAX_MODELS_DIR
  if (!modelDir) throw new Error('AUDIOGEN_TEST_MINIMAX_MODELS_DIR is required')
  return modelDir
}

function numberFromEnv(name) {
  const value = process.env[name]
  return value ? Number(value) : undefined
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
      console.log(`${item.progress.stage}: ${item.progress.step}/${item.progress.total}`)
    } else if (item.outputArray) {
      chunks.push(pcmBytes(item.outputArray))
      sampleRate = item.sampleRate
      channels = item.channels
    }
  }
  const stats = await response.await()
  return { pcm: Buffer.concat(chunks), sampleRate, channels, stats }
}

async function main() {
  const generator = new AudioGen({
    engine: ENGINE_MINIMAX,
    files: { modelDir: requiredModelDir() },
    config: { threads: numberFromEnv('AUDIOGEN_THREADS') }
  })
  try {
    await generator.load()
    const response = await generator.run(process.argv[2] || DEFAULT_CAPTION, {
      lyrics: process.env.AUDIOGEN_LYRICS || '[Instrumental]',
      duration: numberFromEnv('AUDIOGEN_DUR'),
      seed: numberFromEnv('AUDIOGEN_SEED'),
      inferenceSteps: numberFromEnv('AUDIOGEN_STEPS'),
      cfgScale: numberFromEnv('AUDIOGEN_CFG_SCALE')
    })
    const result = await collectOutput(response)
    const wav = AudioGen.encode(result.pcm, 'wav', {
      sampleRate: result.sampleRate,
      channels: result.channels
    })
    const outputPath = process.env.AUDIOGEN_OUT || DEFAULT_OUTPUT
    fs.writeFileSync(outputPath, wav.data)
    console.log(`WAV written to ${outputPath}`)
    console.log(JSON.stringify(result.stats))
  } finally {
    await generator.destroy()
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
