'use strict'

/* global Bare */
const path = require('bare-path')
const process = require('bare-process')
const ASRGgml = require('../index.js')
const { parseWavFile, validatePaths } = require('./parakeet-utils.js')

async function* audioStream(audio) {
  yield audio
}

function printOutput(output) {
  for (const item of Array.isArray(output) ? output : [output]) console.log(JSON.stringify(item))
}

async function main() {
  const [modelPath, audioPath, backend] = Bare.argv.slice(2)
  if (!modelPath || !audioPath) {
    throw new Error(
      'Usage: bare examples/parakeet-streaming-metadata.js <model.gguf> <16k-mono.wav> [backend]'
    )
  }
  if (!validatePaths({ model: modelPath, audio: audioPath })) process.exit(1)
  const model = new ASRGgml({
    files: { model: path.resolve(modelPath) },
    config: { engine: 'parakeet', parakeetConfig: { backend } }
  })
  try {
    await model.load()
    console.log('Backend:', model.getBackendInfo())
    const response = await model.runStreaming(audioStream(parseWavFile(audioPath)))
    await response.onUpdate(printOutput).await()
  } finally {
    await model.unload()
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
