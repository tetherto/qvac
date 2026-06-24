'use strict'

/**
 * Chatterbox (ggml) — sentence-granularity streaming.
 *
 * Streams *sentences in* and emits *one audio chunk per sentence out*.
 * The chunking lives in the JS layer (TTSGgml.runStreaming): each
 * yielded sentence triggers a full batch synthesize on the C++ side and
 * the resulting PCM is published as a single `onUpdate` event.
 *
 * For sub-sentence native chunk streaming (one utterance split into
 * many PCM events as the C++ engine produces them), see
 * `chatterbox-chunk-stream-tts.js`.
 *
 * Usage:
 *   bare examples/chatterbox-sentence-stream-tts.js [path/to/reference.wav]
 *
 * Expects the two Chatterbox GGUF files at:
 *   models/chatterbox-t3-turbo.gguf
 *   models/chatterbox-s3gen.gguf
 *
 * Reference audio is optional; when omitted the built-in voice embedded
 * in the S3Gen GGUF is used.
 */

const fs = require('bare-fs')
const path = require('bare-path')
const TTSGgml = require('../')
const { createWav } = require('./wav-helper')
const { setLogger, releaseLogger } = require('../addonLogging')
const { canPlayPcmChunks, createStreamingPlayer } = require('./pcm-chunk-player')

const CHATTERBOX_SAMPLE_RATE = 24000
const BETWEEN_SENTENCE_MS = 200

function delay (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

const argv = global.Bare ? global.Bare.argv : process.argv
const refAudioArg = argv[2]

const pkgRoot = path.join(__dirname, '..')
const modelDir = path.join(pkgRoot, 'models')
const t3Model = path.join(modelDir, 'chatterbox-t3-turbo.gguf')
const s3genModel = path.join(modelDir, 'chatterbox-s3gen.gguf')

for (const f of [t3Model, s3genModel]) {
  if (!fs.existsSync(f)) {
    console.error(`Missing model file: ${f}`)
    console.error('Run "npm run setup-models" to set up the venv + convert the Resemble Chatterbox checkpoint to GGUF.')
    if (global.Bare) global.Bare.exit(1)
    else process.exit(1)
  }
}

if (refAudioArg && !fs.existsSync(refAudioArg)) {
  console.error(`Reference audio not found: ${refAudioArg}`)
  if (global.Bare) global.Bare.exit(1)
  else process.exit(1)
}

if (!refAudioArg) {
  console.log('No reference audio provided, using the voice baked into the S3Gen GGUF.')
}

async function main () {
  setLogger((priority, message) => {
    if (priority > 1) return
    const names = { 0: 'ERROR', 1: 'WARNING', 2: 'INFO', 3: 'DEBUG', 4: 'OFF' }
    const name = names[priority] || 'UNKNOWN'
    console.log(`[${new Date().toISOString()}] [C++ log] [${name}]: ${message}`)
  })

  const sentences = [
    'First sentence of the script.',
    'The second arrives after a short pause.',
    'Audio output still streams in chunks on each update.'
  ]

  console.log(`Sentence-by-sentence input (${sentences.length} sentences), streaming PCM output.\n`)

  const model = new TTSGgml({
    files: { modelDir },
    ...(refAudioArg ? { referenceAudio: refAudioArg } : {}),
    config: { language: 'en' },
    logger: console,
    opts: { stats: true }
  })

  const outputFile = path.join(__dirname, 'chatterbox-sentence-stream-output.wav')

  try {
    console.log('Loading Chatterbox TTS model...')
    await model.load()
    console.log('Model loaded.')

    const player = canPlayPcmChunks()
      ? createStreamingPlayer({ sampleRate: CHATTERBOX_SAMPLE_RATE })
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
              `[stream out] synthesis ${idx}: ${samples.length} samples; accumulated text: "${preview}${preview.length >= 80 ? '…' : ''}"`
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
      console.log(`Inference stats: totalTime=${s.totalTime?.toFixed(2)}s, tokensPerSecond=${s.tokensPerSecond?.toFixed(2)}, realTimeFactor=${s.realTimeFactor?.toFixed(2)}, audioDuration=${s.audioDurationMs}ms, totalSamples=${s.totalSamples}`)
    }

    if (pcmConcat.length > 0) {
      console.log(`\nWriting concatenated PCM to ${outputFile}`)
      createWav(pcmConcat, CHATTERBOX_SAMPLE_RATE, outputFile)
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
