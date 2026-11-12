'use strict'

/* global Bare */
const path = require('bare-path')
const ASRGgml = require('../index.js')
const { parseWavFile, validatePaths } = require('./parakeet-utils.js')

function printProgress(progress) {
  console.log(`Generated ${progress.generatedTokens} / ${progress.maxNewTokens} tokens`)
}

function printSegments(segments) {
  for (const segment of segments) console.log(JSON.stringify(segment))
}

async function main() {
  const [modelPath, audioPath, backend] = Bare.argv.slice(2)
  if (!modelPath || !audioPath)
    throw new Error(
      'Usage: bare examples/moss-transcribe-progress.js <model.gguf> <16k-mono.wav> [backend]'
    )
  if (!validatePaths({ model: modelPath, audio: audioPath })) Bare.exit(1)
  const model = new ASRGgml({
    files: { model: path.resolve(modelPath) },
    config: { engine: 'moss-transcribe', mossTranscribeConfig: { backend } }
  })
  try {
    await model.load()
    console.log('Backend:', model.getBackendInfo())
    const response = await model.run(parseWavFile(audioPath), { onProgress: printProgress })
    await response.onUpdate(printSegments).await()
    console.log('Stats:', response.stats)
  } finally {
    await model.unload()
  }
}

main().catch((error) => {
  console.error(error)
  Bare.exit(1)
})
