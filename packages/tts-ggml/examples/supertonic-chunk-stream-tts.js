'use strict'

/**
 * Supertonic (ggml) — native chunk streaming.
 *
 * Input is a single string; the *C++ Engine* splits it into chunks of about
 * `streamChunkTokens` text tokens (Unicode code points), snapping each boundary
 * to a sentence end, clause or space, synthesizes them one after another and
 * emits each chunk's PCM to JS via `onUpdate` as soon as it is ready. Seams get
 * a short raised-cosine fade, so audio can start playing before the whole
 * paragraph has been rendered.
 *
 * Contrast with `supertonic-sentence-stream-tts.js`, which streams *sentences*
 * in and runs one engine job per sentence; that path also works with the LavaSR
 * enhancer / denoiser, which native streaming rejects.
 *
 * Usage:
 *   bare examples/supertonic-chunk-stream-tts.js [voice]
 *
 * Expects the Supertonic GGUF at:
 *   models/supertonic.gguf
 */

const fs = require('bare-fs')
const path = require('bare-path')
const TTSGgml = require('../')
const { createWav } = require('./wav-helper')
const { setLogger, releaseLogger } = require('../addonLogging')
const { canPlayPcmChunks, createStreamingPlayer } = require('./pcm-chunk-player')

const SUPERTONIC_SAMPLE_RATE = 44100

const argv = global.Bare ? global.Bare.argv : process.argv
const voiceArg = argv[2]

const pkgRoot = path.join(__dirname, '..')
const modelDir = path.join(pkgRoot, 'models')
const supertonicModel = path.join(modelDir, 'supertonic.gguf')

if (!fs.existsSync(supertonicModel)) {
  console.error(`Missing model file: ${supertonicModel}`)
  console.error('Run "npm run download-models:registry" to fetch the Supertonic GGUF.')
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

  const text =
    'Native streaming splits one request inside the engine. Each chunk is ' +
    'synthesized and emitted as soon as it is ready, so playback can start ' +
    'well before the whole paragraph has been rendered.'

  // streamChunkTokens turns on native streaming (text tokens per chunk; about
  // 50 suits English, 25-30 CJK). streamFirstChunkTokens keeps the first chunk
  // small for a quick first audio; streamMinChunkTokens (engine default 30) is
  // the floor below which the model starts dropping phonemes.
  const model = new TTSGgml({
    files: { supertonicModel },
    voice: voiceArg || 'F1',
    streamChunkTokens: 50,
    streamFirstChunkTokens: 30,
    config: { language: 'en' },
    logger: console,
    opts: { stats: true }
  })

  const outputFile = path.join(__dirname, 'supertonic-chunk-stream-output.wav')

  try {
    console.log('Loading Supertonic TTS model (native streaming)...')
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

    console.log(`\nSynthesizing: "${text.slice(0, 80)}${text.length > 80 ? '…' : ''}"\n`)

    const t0 = Date.now()
    let firstChunkMs = -1
    let pcmConcat = []

    const response = await model.run({ input: text, type: 'text' })

    await response
      .onUpdate(data => {
        if (data && data.outputArray) {
          if (firstChunkMs < 0) firstChunkMs = Date.now() - t0
          const samples = Array.from(data.outputArray)
          pcmConcat = pcmConcat.concat(samples)
          const chunkMs = (samples.length / SUPERTONIC_SAMPLE_RATE) * 1000
          console.log(
            `[native chunk ${data.chunkIndex}${data.isLast ? ', last' : ''}] ${samples.length} samples ` +
            `(${chunkMs.toFixed(0)} ms of audio) at t+${Date.now() - t0} ms`
          )
          if (player) player.write(samples)
        }
      })
      .await()

    const totalMs = Date.now() - t0
    const audioMs = (pcmConcat.length / SUPERTONIC_SAMPLE_RATE) * 1000
    console.log(
      `\nSynthesis done: ${pcmConcat.length} samples (${audioMs.toFixed(0)} ms of audio), ` +
      `first-audio-out ${firstChunkMs} ms, total ${totalMs} ms, RTF ${(totalMs / audioMs).toFixed(3)}`
    )

    if (player) {
      console.log('Waiting for playback to finish...')
      await player.end()
      console.log('Playback finished!')
    }

    if (response.stats) {
      const s = response.stats
      console.log(
        `Stats: totalTime=${s.totalTime?.toFixed(2)}s rtf=${s.realTimeFactor?.toFixed(2)} ` +
        `audio=${s.audioDurationMs?.toFixed(0)}ms samples=${s.totalSamples}`
      )
    }

    if (pcmConcat.length > 0) {
      console.log(`\nWriting concatenated PCM to ${outputFile}`)
      createWav(pcmConcat, SUPERTONIC_SAMPLE_RATE, outputFile)
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
