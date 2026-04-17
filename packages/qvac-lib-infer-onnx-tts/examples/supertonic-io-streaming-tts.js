'use strict'

/**
 * Streaming **input** + streaming **output**: text arrives as an **LLM-like token stream**
 * (tiny pseudo-token yields with short delays). Uses `runStreaming()` — for `AsyncIterable` inputs,
 * **`accumulateSentences` defaults to true**, so fragments concatenate until a sentence end, max
 * buffer size, or idle timeout (see `RunStreamingOptions` in `index.d.ts`). Tune `flushAfterMs` /
 * `maxBufferScalars` / `sentenceDelimiterPreset` if needed.
 *
 * Contrast with `supertonic-streaming-tts.js`: full script known up front, `run({ streamOutput: true })`.
 */

const fs = require('bare-fs')
const path = require('bare-path')
const ONNXTTS = require('../')
const { setLogger, releaseLogger } = require('../addonLogging')
const { canPlayPcmChunks, playInt16Chunk, createChunkQueue } = require('./pcm-chunk-player')

const SUPERTONIC_SAMPLE_RATE = 44100

const TOKEN_DELAY_MS = 22

function delay (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Pseudo–BPE-style slices (not a real tokenizer) — simulates an upstream LLM token stream.
 *
 * @param {string} fullText
 * @param {number} pauseMs
 */
async function * simulateLlmTokenStream (fullText, pauseMs) {
  let i = 0
  let tokenIndex = 0
  while (i < fullText.length) {
    const take = Math.min(1 + (Math.abs((i * 7 + tokenIndex * 3) % 11) % 5), fullText.length - i)
    const piece = fullText.slice(i, i + take)
    i += take
    tokenIndex += 1
    const shown = piece.length > 24 ? `${piece.slice(0, 24)}…` : piece
    console.log(`[stream in] token ${tokenIndex}: ${JSON.stringify(shown)}`)
    if (pauseMs > 0) {
      await delay(pauseMs)
    }
    yield piece
  }
}

const modeArg = global.Bare ? global.Bare.argv[2] : process.argv[2]
if (!modeArg || !['english', 'multilingual'].includes(modeArg)) {
  console.error('Usage: supertonic-io-streaming-tts.js <english|multilingual>')
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
  const streamedPhrases = isMultilingual
    ? [
        'Primera frase que llega desde el flujo de texto.',
        'Una breve pausa simula latencia de red.',
        'Cada entrega se sintetiza como un trabajo aparte.'
      ]
    : [
        'First phrase arrives from the upstream text stream.',
        'A short pause simulates network latency between chunks.',
        'Each yield becomes one TTS job and one audio chunk on onUpdate.'
      ]

  const fullScript = streamedPhrases.join(' ')

  console.log(`Mode: ${modeArg}, language: ${language}, models: ${modelsDir}`)
  console.log(
    `LLM-style token stream (${TOKEN_DELAY_MS}ms between pseudo-tokens), script length ${fullScript.length} chars.\n`
  )

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
      console.log('Streaming playback: chunks play as each text slice is synthesized.')
    } else {
      console.warn(
        'No supported player found (need macOS afplay, ffplay from ffmpeg, or Linux aplay). Chunks will be logged only.'
      )
    }

    const playbackQueue = createChunkQueue()
    const playbackDone = (async () => {
      if (!canPlay) return
      for await (const { samples, sampleRate } of playbackQueue.drain()) {
        await playInt16Chunk(samples, sampleRate)
      }
    })()

    const tokenStream = simulateLlmTokenStream(fullScript, TOKEN_DELAY_MS)

    const response = await model.runStreaming(tokenStream, {
      flushAfterMs: 500
    })

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
              `[stream out] chunk ${idx}: ${samples.length} samples; text: "${preview}${preview.length >= 80 ? '…' : ''}"`
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
