'use strict'

/**
 * Supertonic — sentence-granularity streaming.
 *
 * Streams *sentences in* (async iterator) and emits *one audio chunk
 * per sentence out* via `runStreaming`.  Same engine-agnostic JS-layer
 * orchestrator that chatterbox-sentence-stream-tts.js uses; the addon
 * dispatches each `runJob` call to whichever engine the model was
 * constructed with.
 *
 * Sub-sentence native streaming (`streamChunkTokens`) is Chatterbox-
 * only at the C++ engine level; the constructor rejects those knobs
 * for Supertonic with a clear error.  Use this sentence-level path
 * for low-latency Supertonic streaming.
 *
 * Usage:
 *   bare examples/supertonic-sentence-stream-tts.js [voice]
 *
 * Expects the Supertonic GGUF at:
 *   models/supertonic.gguf
 *
 * NOTE: Supertonic supports GPU on capable hosts, including Android via
 * tts-cpp's per-vendor allowlist; this example keeps useGPU=false. See
 * supertonic-tts.js for the full GPU opt-in context.
 */

const fs = require('bare-fs')
const path = require('bare-path')
const TTSGgml = require('../')
const { createWav } = require('./wav-helper')
const { setLogger, releaseLogger } = require('../addonLogging')
const { canPlayPcmChunks, createStreamingPlayer } = require('./pcm-chunk-player')

const SUPERTONIC_SAMPLE_RATE = 44100
const BETWEEN_SENTENCE_MS = 200

function delay (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

const argv = global.Bare ? global.Bare.argv : process.argv
const voiceArg = argv[2]

const pkgRoot = path.join(__dirname, '..')
const modelDir = path.join(pkgRoot, 'models')
const supertonicModel = path.join(modelDir, 'supertonic.gguf')

if (!fs.existsSync(supertonicModel)) {
  console.error(`Missing model file: ${supertonicModel}`)
  console.error('Run "npm run setup-models" to set up the venv and convert the Supertone Supertonic-2 ONNX bundle to GGUF.')
  if (global.Bare) global.Bare.exit(1)
  else process.exit(1)
}

async function main () {
  setLogger((priority, message) => {
    if (priority > 1) return
    const names = { 0: 'ERROR', 1: 'WARNING', 2: 'INFO', 3: 'DEBUG', 4: 'OFF' }
    const name = names[priority] || 'UNKNOWN'
    console.log(`[${new Date().toISOString()}] [C++ log] [${name}]: ${message}`)
  })

  const sentences = [
    'First sentence of the supertonic stream.',
    'The second arrives after a short pause.',
    'Audio output streams in chunks on each update, one chunk per sentence.'
  ]

  console.log(`Sentence-by-sentence input (${sentences.length} sentences), streaming PCM output.\n`)

  const model = new TTSGgml({
    engine: TTSGgml.ENGINE_SUPERTONIC,
    files: { supertonicModel },
    voice: voiceArg || 'F1',
    config: { language: 'en', useGPU: false },
    logger: console,
    opts: { stats: true }
  })

  const outputFile = path.join(__dirname, 'supertonic-sentence-stream-output.wav')

  try {
    console.log('Loading Supertonic TTS model...')
    await model.load()
    console.log('Model loaded.')

    const player = canPlayPcmChunks()
      ? createStreamingPlayer({ sampleRate: SUPERTONIC_SAMPLE_RATE })
      : null
    if (player) {
      console.log(`Streaming playback via ${player.backend}: chunks flow to stdin as they arrive.`)
    } else {
      console.warn(
        'No supported player found (install ffmpeg / sox / alsa-utils). Chunks will be logged only.'
      )
    }

    async function * sentencesOverTime () {
      for (let i = 0; i < sentences.length; i++) {
        if (i > 0) {
          await delay(BETWEEN_SENTENCE_MS)
        }
        const s = sentences[i]
        const preview = s.length > 60 ? `${s.slice(0, 60)}…` : s
        console.log(`[stream in] sentence ${i}: "${preview}"`)
        yield s
      }
    }

    let pcmConcat = []
    let chunkCount = 0

    const response = await model.runStreaming(sentencesOverTime(), {
      flushAfterMs: 500
    })

    await response
      .onUpdate(data => {
        if (data && data.outputArray) {
          const samples = Array.from(data.outputArray)
          pcmConcat = pcmConcat.concat(samples)
          chunkCount += 1

          const idx = data.chunkIndex
          const preview =
            typeof data.sentenceChunk === 'string'
              ? data.sentenceChunk.slice(0, 80).replace(/\s+/g, ' ')
              : ''
          if (idx !== undefined) {
            console.log(
              `[stream out] synthesis ${idx}: ${samples.length} samples; sentence: "${preview}${preview.length >= 80 ? '…' : ''}"`
            )
          } else {
            console.log(`Audio update: ${samples.length} samples (no chunk metadata)`)
          }

          if (player) player.write(samples)
        }
      })
      .await()

    console.log(`Inference finished! (${chunkCount} synthesis chunk(s))`)
    if (player) {
      console.log('Waiting for playback to finish...')
      await player.end()
      console.log('Playback finished!')
    }

    if (response.stats) {
      const s = response.stats
      console.log(`Inference stats: totalTime=${s.totalTime?.toFixed(2)}s, tokensPerSecond=${s.tokensPerSecond?.toFixed(2)}, realTimeFactor=${s.realTimeFactor?.toFixed(3)}, audioDuration=${s.audioDurationMs}ms, totalSamples=${s.totalSamples}`)
    }

    if (pcmConcat.length > 0) {
      console.log(`\nWriting concatenated PCM to ${outputFile}`)
      createWav(pcmConcat, SUPERTONIC_SAMPLE_RATE, outputFile)
      console.log('Done.')
    }
  } catch (err) {
    console.error('Error during TTS processing:', err)
    throw err
  } finally {
    console.log('Unloading model...')
    await model.unload()
    console.log('Model unloaded.')
    releaseLogger()
  }
}

main().catch(err => {
  console.error(err)
  if (global.Bare) global.Bare.exit(1)
  else process.exit(1)
})
