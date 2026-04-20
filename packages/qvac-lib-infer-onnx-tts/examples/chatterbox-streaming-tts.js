'use strict'

/**
 * Chatterbox: full script is known as an **array of sentences**; each sentence is yielded in order
 * (with a short pause between yields). **`runStreaming()`** still delivers **streaming PCM** on
 * `onUpdate` — only the **audio output** is in stream form, not the text input.
 *
 * Requires reference audio (voice cloning). Usage matches `chatterbox-tts.js`.
 *
 * Contrast: `chatterbox-tts.js` — batch `run({ input })`; `supertonic-io-streaming-tts.js` — Supertonic
 * with LLM-like token simulation on the text input.
 */

const fs = require('bare-fs')
const path = require('bare-path')
const ONNXTTS = require('../')
const { createWav, readWavAsFloat32, resampleLinear } = require('./wav-helper')
const { setLogger, releaseLogger } = require('../addonLogging')
const { canPlayPcmChunks, playInt16Chunk, createChunkQueue } = require('./pcm-chunk-player')

const CHATTERBOX_SAMPLE_RATE = 24000

const BETWEEN_SENTENCE_MS = 200

function delay (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

const argv = global.Bare ? global.Bare.argv : process.argv
const modeArg = argv[2]
const refAudioArg = argv[3]

if (!modeArg || !['english', 'multilingual'].includes(modeArg)) {
  console.error('Usage: chatterbox-streaming-tts.js <english|multilingual> [path/to/reference.wav]')
  if (global.Bare) global.Bare.exit(1)
  else process.exit(1)
}

const os = require('bare-os')
const variant = os.getEnv('CHATTERBOX_VARIANT') || 'q4'

const isMultilingual = modeArg === 'multilingual'
const pkgRoot = path.join(__dirname, '..')
const modelsDir = isMultilingual ? 'models/chatterbox-multilingual' : 'models/chatterbox'
const modelDir = path.join(pkgRoot, modelsDir)

const suffix = variant === 'fp32' ? '' : `_${variant}`
const nonLmSuffix = isMultilingual ? '' : suffix

const tokenizerPath = path.join(modelDir, 'tokenizer.json')
const speechEncoderPath = path.join(modelDir, `speech_encoder${nonLmSuffix}.onnx`)
const embedTokensPath = path.join(modelDir, `embed_tokens${nonLmSuffix}.onnx`)
const conditionalDecoderPath = path.join(modelDir, `conditional_decoder${nonLmSuffix}.onnx`)
const languageModelPath = path.join(modelDir, `language_model${suffix}.onnx`)

const requiredFiles = [tokenizerPath, speechEncoderPath, embedTokensPath, conditionalDecoderPath, languageModelPath]
for (const f of requiredFiles) {
  if (!fs.existsSync(f)) {
    const ensureCmd = isMultilingual
      ? 'TTS_LANGUAGE=multilingual npm run models:ensure:chatterbox'
      : 'npm run models:ensure:chatterbox'
    console.error(`Missing model file: ${f}`)
    console.error(`Run "${ensureCmd}" to download the required models.`)
    if (global.Bare) global.Bare.exit(1)
    else process.exit(1)
  }
}

const defaultRefWavPath = path.join(__dirname, '..', 'test', 'reference-audio', 'jfk.wav')
const refWavPath = refAudioArg || defaultRefWavPath

if (!refAudioArg) {
  const proc = require('bare-process')
  const relPath = path.relative(proc.cwd(), defaultRefWavPath)
  console.warn(`\x1b[33mNo reference audio provided, using default: ${relPath}\x1b[0m`)
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

  let referenceAudio
  try {
    const { samples, sampleRate } = readWavAsFloat32(refWavPath)
    if (sampleRate !== CHATTERBOX_SAMPLE_RATE) {
      console.log(`Resampling reference audio from ${sampleRate}Hz to ${CHATTERBOX_SAMPLE_RATE}Hz`)
      referenceAudio = resampleLinear(samples, sampleRate, CHATTERBOX_SAMPLE_RATE)
    } else {
      referenceAudio = samples
    }
    console.log(`Loaded reference audio: ${refWavPath} (${referenceAudio.length} samples @ ${CHATTERBOX_SAMPLE_RATE}Hz)`)
  } catch (err) {
    console.error('Could not load reference audio:', err.message)
    throw err
  }

  const language = isMultilingual ? 'es' : 'en'
  const sentences = isMultilingual
    ? [
        'Primera frase del guion.',
        'La segunda llega después de una breve pausa.',
        'La salida de audio sigue llegando en trozos por onUpdate.'
      ]
    : [
        'First sentence of the script.',
        'The second arrives after a short pause.',
        'Audio output still streams in chunks on each update.'
      ]

  console.log(`Mode: ${modeArg}, language: ${language}, models: ${modelsDir}`)
  console.log(`Sentence-by-sentence input (${sentences.length} sentences), streaming PCM output.\n`)

  const model = new ONNXTTS({
    files: {
      modelDir,
      tokenizer: tokenizerPath,
      speechEncoder: speechEncoderPath,
      embedTokens: embedTokensPath,
      conditionalDecoder: conditionalDecoderPath,
      languageModel: languageModelPath
    },
    engine: 'chatterbox',
    referenceAudio,
    config: {
      language
    },
    logger: console,
    opts: { stats: true }
  })

  const outputFile = path.join(
    __dirname,
    isMultilingual ? 'chatterbox-multilingual-stream-output.wav' : 'chatterbox-stream-output.wav'
  )

  try {
    console.log('Loading Chatterbox TTS model...')
    await model.load()
    console.log('Model loaded.')

    const canPlay = canPlayPcmChunks()
    if (canPlay) {
      console.log('Streaming playback: 24 kHz chunks as each accumulated sentence is synthesized.')
    } else {
      console.warn(
        'No supported player found (need macOS afplay, ffplay from ffmpeg, or Linux aplay). Chunks will be logged only.'
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

    const playbackQueue = createChunkQueue()
    const playbackDone = (async () => {
      if (!canPlay) return
      for await (const { samples, sampleRate } of playbackQueue.drain()) {
        await playInt16Chunk(samples, sampleRate)
      }
    })()

    let pcmConcat = []

    const response = await model.runStreaming(sentencesOverTime(), {
      flushAfterMs: 500
    })

    let chunkCount = 0

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

          playbackQueue.push({ samples, sampleRate: CHATTERBOX_SAMPLE_RATE })
        }
      })
      .await()

    console.log(`Inference finished! (${chunkCount} synthesis chunk(s)), waiting for playback...`)
    playbackQueue.end()
    await playbackDone

    console.log('Playback finished!')
    if (response.stats) {
      const s = response.stats
      console.log(`Inference stats: totalTime=${s.totalTime.toFixed(2)}s, tokensPerSecond=${s.tokensPerSecond.toFixed(2)}, realTimeFactor=${s.realTimeFactor.toFixed(2)}, audioDuration=${s.audioDurationMs}ms, totalSamples=${s.totalSamples}`)
    }

    if (pcmConcat.length > 0) {
      console.log(`\nWriting concatenated PCM to ${outputFile}`)
      createWav(pcmConcat, CHATTERBOX_SAMPLE_RATE, outputFile)
      console.log('Done.')
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
