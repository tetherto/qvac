'use strict'

/**
 * Chatterbox (ggml) — sub-sentence chunk streaming.
 *
 * Input is a single string; the *C++ Engine* splits its own synthesis
 * into fixed `streamChunkTokens`-size chunks (~25 T3 tokens ~= 1 s of
 * audio) and emits each chunk's PCM to JS via `onUpdate` the moment
 * it's produced.  The Engine runs the chunked S3Gen+HiFT loop with
 * phase-continuous `hift_cache_source` across chunks, so the seams are
 * inaudible — listeners get sub-second audio latency inside a single
 * utterance (first-audio-out typically ~280 ms of synthesis wall time
 * after T3 finishes).
 *
 * Contrast with `chatterbox-sentence-stream-tts.js`, which streams
 * *sentences* in and emits *one audio chunk per sentence* out — that
 * one mirrors the API of @qvac/tts-onnx and works on any backend; this
 * one requires the Engine's streaming hook added in qvac-tts.cpp.
 *
 * Usage:
 *   bare examples/chatterbox-chunk-stream-tts.js [path/to/reference.wav]
 */

const fs = require('bare-fs')
const path = require('bare-path')
const TTSGgml = require('../')
const { createWav } = require('./wav-helper')
const { setLogger, releaseLogger } = require('../addonLogging')
const { canPlayPcmChunks, createStreamingPlayer } = require('./pcm-chunk-player')

const CHATTERBOX_SAMPLE_RATE = 24000

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

  const text =
    'Hello from native chatterbox streaming. This sentence should split into multiple chunks ' +
    'on the C++ side so audio starts flowing well before the full synthesis completes.'

  // streamChunkTokens activates the C++ chunked S3Gen+HiFT loop.
  //   streamFirstChunkTokens  keeps first-audio-out low (small first chunk).
  //   cfmSteps                1 halves CFM cost with minor quality cost;
  //                           2 matches Python's meanflow default.
  const model = new TTSGgml({
    files: { modelDir },
    ...(refAudioArg ? { referenceAudio: refAudioArg } : {}),
    streamChunkTokens: 25,
    streamFirstChunkTokens: 10,
    cfmSteps: 1,
    config: { language: 'en' },
    logger: console,
    opts: { stats: true }
  })

  const outputFile = path.join(__dirname, 'chatterbox-chunk-stream-output.wav')

  try {
    console.log('Loading Chatterbox TTS model (native streaming)...')
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

    console.log(`\nSynthesizing: "${text.slice(0, 80)}${text.length > 80 ? '…' : ''}"\n`)

    const t0 = Date.now()
    let firstChunkMs = -1
    let chunkCount = 0
    let pcmConcat = []

    const response = await model.run({ input: text, type: 'text' })

    await response
      .onUpdate(data => {
        if (data && data.outputArray) {
          if (firstChunkMs < 0) firstChunkMs = Date.now() - t0
          chunkCount += 1
          const samples = Array.from(data.outputArray)
          pcmConcat = pcmConcat.concat(samples)
          const chunkMs = (samples.length / CHATTERBOX_SAMPLE_RATE) * 1000
          console.log(
            `[native chunk ${chunkCount}] ${samples.length} samples (${chunkMs.toFixed(0)} ms of audio) at t+${Date.now() - t0} ms`
          )
          if (player) player.write(samples)
        }
      })
      .await()

    const totalMs = Date.now() - t0
    const audioMs = (pcmConcat.length / CHATTERBOX_SAMPLE_RATE) * 1000
    console.log(
      `\nSynthesis done: ${chunkCount} chunks, ${pcmConcat.length} samples (${audioMs.toFixed(0)} ms of audio), ` +
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
        `audio=${s.audioDurationMs}ms samples=${s.totalSamples}`
      )
    }

    if (pcmConcat.length > 0) {
      console.log(`\nWriting concatenated PCM to ${outputFile}`)
      createWav(pcmConcat, CHATTERBOX_SAMPLE_RATE, outputFile)
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
