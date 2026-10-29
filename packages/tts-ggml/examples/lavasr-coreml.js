'use strict'

const proc = require('bare-process')
const TTSGgml = require('../')
const { createWav } = require('./wav-helper')

async function main() {
  const [
    modelPath,
    denoiserPath,
    enhancerPath,
    denoiserCoreml,
    enhancerCoreml,
    units,
    text,
    output
  ] = proc.argv.slice(2)
  if (
    !modelPath ||
    !denoiserPath ||
    !enhancerPath ||
    !denoiserCoreml ||
    !enhancerCoreml ||
    !units ||
    !text ||
    !output
  ) {
    throw new Error(
      'Usage: bare examples/lavasr-coreml.js <supertonic.gguf> <denoiser.gguf> <enhancer.gguf> <denoiser.mlmodelc> <enhancer.mlmodelc> <compute-units> "<text>" <output.wav>'
    )
  }
  const model = new TTSGgml({
    engine: TTSGgml.ENGINE_SUPERTONIC,
    files: { supertonicModel: modelPath },
    denoiser: {
      type: 'lavasr',
      denoiserPath,
      coremlModelPath: denoiserCoreml,
      coremlComputeUnits: units
    },
    enhancer: {
      type: 'lavasr',
      enhancerPath,
      coremlModelPath: enhancerCoreml,
      coremlComputeUnits: units
    },
    opts: { stats: true }
  })
  try {
    await model.load()
    const response = await model.run({ input: text, type: 'text' })
    const chunks = []
    let sampleRate
    const stats = await response
      .onUpdate((chunk) => {
        if (!chunk.outputArray) return
        chunks.push(chunk.outputArray)
        sampleRate = chunk.sampleRate
      })
      .await()
    createWav(
      chunks.flatMap((chunk) => Array.from(chunk)),
      sampleRate,
      output
    )
    console.log(output, stats)
  } finally {
    await model.unload()
  }
}

main().catch((error) => {
  console.error(error)
  if (global.Bare) global.Bare.exit(1)
  else process.exitCode = 1
})
