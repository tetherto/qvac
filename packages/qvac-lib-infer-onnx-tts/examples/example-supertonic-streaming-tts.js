'use strict'

const path = require('bare-path')
const ONNXTTS = require('../')
const { createWav } = require('./wav-helper')
const { setLogger, releaseLogger } = require('../addonLogging')

const SUPERTONIC_SAMPLE_RATE = 44100

// Supertone supertonic-2 (HF Supertone/supertonic-2) — use npm run models:ensure or ensureSupertonicModels
const modelDir = path.join(__dirname, '..', 'models', 'supertonic')

/**
 * Same usage shape as Whisper `runStreaming()` (see examples/example.streaming-vad.js):
 * await `runSentenceStream`, attach `response.onUpdate`, then `await response.await()`.
 */

async function main () {
  setLogger((priority, message) => {
    const priorityNames = {
      0: 'ERROR',
      1: 'WARNING',
      2: 'INFO',
      3: 'DEBUG',
      4: 'OFF'
    }
    const priorityName = priorityNames[priority] || 'UNKNOWN'
    const timestamp = new Date().toISOString()
    console.log(`[${timestamp}] [C++ log] [${priorityName}]: ${message}`)
  })

  const model = new ONNXTTS({
    files: {
      modelDir
    },
    engine: 'supertonic',
    voiceName: 'F1',
    speed: 1.05,
    numInferenceSteps: 5,
    supertonicMultilingual: false,
    config: {
      language: 'en'
    },
    logger: console,
    opts: { stats: true }
  })

  try {
    console.log('Loading Supertonic TTS model...')
    await model.load()
    console.log('Model loaded.')

    const textToSynthesize = `The rolling hills of the willowed valley glimmered brilliantly under the mellowing autumn sun.
     The sun was setting in the west, casting a golden glow over the landscape.
     The sky was a canvas of hues, from deep reds to warm oranges and golden yellows.
     The leaves on the trees were a vibrant red, orange, and yellow.
     The air was crisp and cool, with a slight chill in the breeze.
     The sound of the leaves rustling in the wind was a soothing melody.
     The birds were singing a beautiful song, as if they were happy to be alive.
     The bees were buzzing around the flowers, collecting nectar.
     The butterflies were fluttering around the flowers, collecting nectar.`

    console.log('Starting runSentenceStream (chunked synthesis, onUpdate per chunk)...')

    const response = await model.runSentenceStream(textToSynthesize)

    let buffer = []
    let chunkCount = 0

    response.onUpdate(data => {
      if (data && data.outputArray) {
        const samples = Array.from(data.outputArray)
        buffer = buffer.concat(samples)
        chunkCount += 1

        const idx = data.chunkIndex
        const preview =
          typeof data.sentenceChunk === 'string'
            ? data.sentenceChunk.slice(0, 80).replace(/\s+/g, ' ')
            : ''
        if (idx !== undefined) {
          console.log(
            `Chunk ${idx}: ${samples.length} samples; text preview: "${preview}${preview.length >= 80 ? '…' : ''}"`
          )
        } else {
          console.log(`Audio update: ${samples.length} samples (no chunk metadata)`)
        }
      }
    })

    await response.await()

    console.log(`TTS finished (${chunkCount} audio update(s)).`)
    if (response.stats) {
      console.log(`Inference stats: ${JSON.stringify(response.stats)}`)
    }

    const outPath = 'supertonic-streaming-output.wav'
    console.log(`Writing concatenated PCM to ${outPath}...`)
    createWav(buffer, SUPERTONIC_SAMPLE_RATE, outPath)
    console.log(`Done. Wrote ${buffer.length} samples at ${SUPERTONIC_SAMPLE_RATE} Hz.`)
  } catch (err) {
    console.error('Error during TTS processing:', err)
  } finally {
    console.log('Unloading model...')
    await model.unload()
    console.log('Model unloaded.')
    releaseLogger()
  }
}

main().catch(console.error)
