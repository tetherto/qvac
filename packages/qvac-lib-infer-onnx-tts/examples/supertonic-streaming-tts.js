'use strict'

const fs = require('bare-fs')
const path = require('bare-path')
const ONNXTTS = require('../')
const { setLogger, releaseLogger } = require('../addonLogging')
const { canPlayPcmChunks, playInt16Chunk, createChunkQueue } = require('./pcm-chunk-player')

const SUPERTONIC_SAMPLE_RATE = 44100

const modeArg = global.Bare ? global.Bare.argv[2] : process.argv[2]
if (!modeArg || !['english', 'multilingual'].includes(modeArg)) {
  console.error('Usage: supertonic-streaming-tts.js <english|multilingual>')
  if (global.Bare) global.Bare.exit(1)
  else process.exit(1)
}

const isMultilingual = modeArg === 'multilingual'
const pkgRoot = path.join(__dirname, '..')
const modelsDir = isMultilingual ? 'models/supertonic-multilingual' : 'models/supertonic'
const modelDir = path.join(pkgRoot, modelsDir)

if (!fs.existsSync(modelDir)) {
  const ensureCmd = isMultilingual
    ? 'TTS_LANGUAGE=multilingual npm run models:ensure:supertonic'
    : 'npm run models:ensure:supertonic'
  console.error(`Missing model directory: ${modelDir}`)
  console.error(`Run "${ensureCmd}" to download the required models.`)
  if (global.Bare) global.Bare.exit(1)
  else process.exit(1)
}

async function main () {
  setLogger((priority, message) => {
    if (priority > 1) return
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

  const language = isMultilingual ? 'es' : 'en'
  const textToSynthesize = isMultilingual
    ? 'Hola mundo. Esta es una demostración de síntesis por fragmentos. Cada oración puede reproducirse al estar lista. El modelo Supertonic procesa el texto en español.'
    : `The rolling hills of the willowed valley glimmered brilliantly under the mellowing autumn sun.
     The sun was setting in the west, casting a golden glow over the landscape.
     The sky was a canvas of hues, from deep reds to warm oranges and golden yellows.
     The leaves on the trees were a vibrant red, orange, and yellow.
     The air was crisp and cool, with a slight chill in the breeze.
     The sound of the leaves rustling in the wind was a soothing melody.
     The birds were singing a beautiful song, as if they were happy to be alive.
     The bees were buzzing around the flowers, collecting nectar.
     The butterflies were fluttering around the flowers, collecting nectar.`

  console.log(`Mode: ${modeArg}, language: ${language}, models: ${modelsDir}\n`)

  const model = new ONNXTTS({
    files: {
      modelDir
    },
    engine: 'supertonic',
    voiceName: 'F1',
    speed: 1.05,
    numInferenceSteps: 5,
    supertonicMultilingual: isMultilingual,
    config: {
      language
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
      console.log('Streaming playback: chunks play asynchronously while inference continues.')
    } else {
      console.warn(
        'No supported player found (need macOS afplay, ffplay from ffmpeg, or Linux aplay). Chunks will be logged only.'
      )
    }

    console.log(`Running streaming TTS on: "${textToSynthesize.substring(0, 80)}${textToSynthesize.length > 80 ? '…' : ''}"`)

    const playbackQueue = createChunkQueue()
    const playbackDone = (async () => {
      if (!canPlay) return
      for await (const { samples, sampleRate } of playbackQueue.drain()) {
        await playInt16Chunk(samples, sampleRate)
      }
    })()

    const response = await model.runStream(textToSynthesize)

    let chunkCount = 0

    await response
      .onUpdate(data => {
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

          playbackQueue.push({ samples, sampleRate: SUPERTONIC_SAMPLE_RATE })
        }
      })
      .await()

    console.log(`Inference finished! (${chunkCount} chunk(s)), waiting for playback...`)
    playbackQueue.end()
    await playbackDone

    console.log('Playback finished!')
    if (response.stats) {
      const s = response.stats
      console.log(`Inference stats: totalTime=${s.totalTime.toFixed(2)}s, tokensPerSecond=${s.tokensPerSecond.toFixed(2)}, realTimeFactor=${s.realTimeFactor.toFixed(2)}, audioDuration=${s.audioDurationMs}ms, totalSamples=${s.totalSamples}`)
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

