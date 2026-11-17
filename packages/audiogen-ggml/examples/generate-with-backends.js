'use strict'

const fs = require('bare-fs')
const proc = require('bare-process')
const { AudioGen, assessFit } = require('@qvac/audiogen-ggml')

async function collectAudio(response) {
  const chunks = []
  let sampleRate = 0
  let channels = 0
  for await (const chunk of response.iterate()) {
    if (!chunk.outputArray) continue
    chunks.push(
      Buffer.from(
        chunk.outputArray.buffer,
        chunk.outputArray.byteOffset,
        chunk.outputArray.byteLength
      )
    )
    sampleRate = chunk.sampleRate
    channels = chunk.channels
  }
  return { pcm: Buffer.concat(chunks), sampleRate, channels, stats: await response.await() }
}

async function main() {
  const [modelDir, backend, lmBackend, dumpStagesDir, outputPath] = proc.argv.slice(2)
  if (!modelDir || !backend || !lmBackend || !dumpStagesDir || !outputPath) {
    throw new Error(
      'Usage: bare examples/generate-with-backends.js MODEL_DIR BACKEND LM_BACKEND EXISTING_DUMP_DIR OUTPUT.wav'
    )
  }

  console.log(await assessFit({ modelsDir: modelDir, backend, lmBackend }))
  const generator = new AudioGen({
    files: { modelDir },
    config: { backend, lmBackend, dumpStagesDir }
  })
  try {
    await generator.load()
    const response = await generator.run('A warm acoustic instrumental with gentle guitar', {
      lyrics: '[Instrumental]',
      duration: 6,
      seed: 7
    })
    const { pcm, sampleRate, channels, stats } = await collectAudio(response)
    const encoded = AudioGen.encode(pcm, 'wav', { sampleRate, channels })
    fs.writeFileSync(outputPath, encoded.data)
    console.log(stats)
  } finally {
    await generator.destroy()
  }
}

main().catch((error) => {
  console.error(error)
  proc.exitCode = 1
})
