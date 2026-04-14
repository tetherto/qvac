'use strict'

const path = require('bare-path')
const ONNXTTS = require('..')
const { setLogger, releaseLogger } = require('../addonLogging')
const { canPlayPcmChunks, playInt16ChunkSync } = require('./pcm-chunk-player')
const { ensureSupertonicModels } = require('../test/utils/downloadModel')

const SUPERTONIC_SAMPLE_RATE = 44100

// Supertone supertonic-2 (HF Supertone/supertonic-2) — use npm run models:ensure or ensureSupertonicModels
const modelDir = path.join(__dirname, '..', 'models', 'supertonic')

/**
 * Same usage shape as Whisper `runStreaming()` (see examples/example.streaming-vad.js):
 * await `runStream`, attach `response.onUpdate`, then `await response.await()`.
 * Each audio chunk is played as it arrives (see pcm-chunk-player). For a WAV file example, use supertonic-tts.js.
 */

async function main () {
  await ensureSupertonicModels()

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

    const canPlay = canPlayPcmChunks()
    if (canPlay) {
      console.log('Streaming playback: each chunk will play as soon as it is synthesized.')
    } else {
      console.warn(
        'No supported player found (need macOS afplay, ffplay from ffmpeg, or Linux aplay). Chunks will be logged only.'
      )
    }

    const textToSynthesize = `The rolling hills of the willowed valley glimmered brilliantly under the mellowing autumn sun.
     The sun was setting in the west, casting a golden glow over the landscape.
     The sky was a canvas of hues, from deep reds to warm oranges and golden yellows.
     The leaves on the trees were a vibrant red, orange, and yellow.
     The air was crisp and cool, with a slight chill in the breeze.
     The sound of the leaves rustling in the wind was a soothing melody.
     The birds were singing a beautiful song, as if they were happy to be alive.
     The bees were buzzing around the flowers, collecting nectar.
     The butterflies were fluttering around the flowers, collecting nectar.`

    console.log('Starting runStream (chunked synthesis, onUpdate per chunk)...')

    const response = await model.runStream(textToSynthesize)

    let chunkCount = 0

    response.onUpdate(data => {
      if (data && data.outputArray) {
        const samples = Array.from(data.outputArray)
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

        if (canPlay) {
          playInt16ChunkSync(samples, SUPERTONIC_SAMPLE_RATE)
        }
      }
    })

    await response.await()

    console.log(`TTS finished (${chunkCount} audio update(s)).`)
    if (response.stats) {
      console.log(`Inference stats: ${JSON.stringify(response.stats)}`)
    }
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
