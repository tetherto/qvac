'use strict'

/* global Bare */
const path = require('bare-path')
const ASRGgml = require('../index.js')
const { parseWavFile, validatePaths } = require('./parakeet-utils.js')

function printProbabilities(segments) {
  for (const segment of segments) {
    const matrix = segment.speakerProbabilities
    console.log(
      JSON.stringify({
        ...segment,
        speakerProbabilities: {
          ...matrix,
          values: Array.from(matrix.values)
        }
      })
    )
  }
}

async function main() {
  const [modelPath, audioPath, backend] = Bare.argv.slice(2)
  if (!modelPath || !audioPath)
    throw new Error(
      'Usage: bare examples/parakeet-diarization-probabilities.js <diarizer.gguf> <16k-mono.wav> [backend]'
    )
  if (!validatePaths({ model: modelPath, audio: audioPath })) Bare.exit(1)
  const model = new ASRGgml({
    files: { model: path.resolve(modelPath) },
    config: { engine: 'parakeet', parakeetConfig: { backend } }
  })
  try {
    await model.load()
    const response = await model.run(parseWavFile(audioPath), { includeSpeakerProbabilities: true })
    await response.onUpdate(printProbabilities).await()
  } finally {
    await model.unload()
  }
}

main().catch((error) => {
  console.error(error)
  Bare.exit(1)
})
