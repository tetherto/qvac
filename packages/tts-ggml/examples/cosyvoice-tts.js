'use strict'

/**
 * CosyVoice3 TTS batch synthesis for @qvac/tts-ggml.
 *
 * Loads the Fun-CosyVoice3-0.5B model directory (Qwen2 speech LM + DiT flow +
 * CausalHiFT vocoder, plus the Qwen2 BPE tokenizer and a baked default voice)
 * and synthesizes a single utterance.  Native 24 kHz. CPU by default; pass
 * --gpu to opt into GPU offload (Metal on macOS/iOS, Vulkan on Linux/Windows,
 * OpenCL/Adreno on Android; other hosts fall back to CPU).
 *
 * `emotion` is the cross-engine conditioning option: the same spelling works on
 * Parler (see parler-tts.js).  CosyVoice3 supports anger, happy, neutral and
 * sad -- the emotions it was trained on -- and takes one instruction per
 * synthesis, so combining emotion with pace or instruct throws.
 *
 * Voice cloning: pass --reference-audio to speak in that recording's voice.
 * With --prompt-text (the recording's verbatim transcript) the engine runs
 * zero-shot; without it, cross-lingual (timbre only -- best when the text is
 * in a different language than the reference).  Cloning needs the add-on
 * GGUFs (cosyvoice3-s3tok*.gguf + cosyvoice3-campplus*.gguf) in the model
 * dir; without --reference-audio the baked default voice speaks.
 *
 * Usage:
 *   bare examples/cosyvoice-tts.js [--gpu] [--reference-audio REF.wav]
 *       [--prompt-text "transcript"] "text to synthesize" [emotion] [modelDir]
 *
 * Examples:
 *   bare examples/cosyvoice-tts.js "Hello from a fully on-device C++ pipeline."
 *   bare examples/cosyvoice-tts.js --gpu "Real time on Apple silicon."
 *   bare examples/cosyvoice-tts.js "What a wonderful day." happy
 *   bare examples/cosyvoice-tts.js "Peer to peer, local first." sad /path/to/cosyvoice3
 *   bare examples/cosyvoice-tts.js --reference-audio me.wav \
 *       --prompt-text "verbatim transcript of me.wav" "Same voice, new words."
 *   bare examples/cosyvoice-tts.js --reference-audio me.wav "任何其他语言。"
 *
 * The model directory is produced by
 * qvac-fabric-speech.cpp/engines/tts/scripts/assemble-cosyvoice3-model.py and
 * must contain:
 *   cosyvoice3-llm-*.gguf  cosyvoice3-flow-*.gguf  cosyvoice3-hift-*.gguf
 *   voice.gguf  vocab.json  merges.txt
 *   (+ cosyvoice3-s3tok-*.gguf  cosyvoice3-campplus-*.gguf for cloning)
 * Default location: models/cosyvoice3/ (override with the last arg or
 * COSYVOICE_MODEL_DIR).
 */

const fs = require('bare-fs')
const path = require('bare-path')
const proc = require('bare-process')
const TTSGgml = require('../')
const { createWav } = require('./wav-helper')
const { setLogger, releaseLogger } = require('../addonLogging')

const COSYVOICE_SAMPLE_RATE = 24000

const { parseCloneArgs } = require('./parse-clone-args')

const argv = global.Bare ? global.Bare.argv : process.argv
const env = proc.env || {}

function usageExit(reason) {
  if (reason) console.error(`cosyvoice-tts.js: ${reason}`)
  console.error(
    'Usage: cosyvoice-tts.js [--gpu] [--reference-audio REF.wav] ' +
      '[--prompt-text "transcript"] "<text to synthesize>" [emotion] [modelDir]'
  )
  if (global.Bare) global.Bare.exit(1)
  else process.exit(1)
}

let parsed
try {
  parsed = parseCloneArgs(argv.slice(2))
} catch (e) {
  usageExit(e.message)
}
const { useGPU, refAudio: refAudioArg, promptText: promptTextArg, positional } = parsed
const textArg = positional[0]
const emotionArg = positional[1]
const modelDirArg = positional[2]

if (!textArg || typeof textArg !== 'string' || textArg.trim().length === 0) {
  usageExit()
}

if (refAudioArg && !fs.existsSync(refAudioArg)) {
  console.error(`Missing reference audio: ${refAudioArg}`)
  if (global.Bare) global.Bare.exit(1)
  else process.exit(1)
}

const pkgRoot = path.join(__dirname, '..')
const cosyvoiceModelDir =
  modelDirArg || env.COSYVOICE_MODEL_DIR || path.join(pkgRoot, 'models', 'cosyvoice3')

if (!fs.existsSync(cosyvoiceModelDir)) {
  console.error(`Missing CosyVoice3 model directory: ${cosyvoiceModelDir}`)
  console.error(
    'Assemble one with tts-cpp/scripts/assemble-cosyvoice3-model.py, then pass it ' +
      'as the 2nd arg or set COSYVOICE_MODEL_DIR.'
  )
  if (global.Bare) global.Bare.exit(1)
  else process.exit(1)
}

async function main() {
  setLogger((priority, message) => {
    if (priority > 1) return
    const names = { 0: 'ERROR', 1: 'WARNING', 2: 'INFO', 3: 'DEBUG', 4: 'OFF' }
    const name = names[priority] || 'UNKNOWN'
    console.log(`[${new Date().toISOString()}] [C++ log] [${name}]: ${message}`)
  })

  const outputFile = path.join(__dirname, 'cosyvoice-output.wav')

  if (refAudioArg) {
    console.log(
      `Cloning from ${refAudioArg} (${promptTextArg ? 'zero-shot: transcript given' : 'cross-lingual: no transcript'})`
    )
  }

  const model = new TTSGgml({
    engine: TTSGgml.ENGINE_COSYVOICE3,
    files: { cosyvoiceModelDir },
    config: { language: 'en', useGPU },
    ...(refAudioArg ? { referenceAudio: refAudioArg } : {}),
    ...(promptTextArg ? { promptText: promptTextArg } : {}),
    ...(emotionArg ? { emotion: emotionArg } : {}),
    logger: console,
    opts: { stats: true }
  })

  try {
    console.log('Loading CosyVoice3 TTS model...')
    await model.load()
    console.log('Model loaded.')

    console.log(`Running TTS on: "${textArg}"`)

    const response = await model.run({ input: textArg, type: 'text' })

    let buffer = []
    await response
      .onUpdate((data) => {
        if (data && data.outputArray) {
          buffer = buffer.concat(Array.from(data.outputArray))
        }
      })
      .await()

    console.log('TTS finished!')
    if (response.stats) {
      const s = response.stats
      console.log(
        `Inference stats: totalTime=${s.totalTime.toFixed(2)}s, realTimeFactor=${s.realTimeFactor.toFixed(3)}, audioDuration=${s.audioDurationMs}ms, totalSamples=${s.totalSamples}, backendDevice=${s.backendDevice} backendId=${s.backendId}`
      )
    }

    console.log('\nWriting to .wav file...')
    createWav(buffer, COSYVOICE_SAMPLE_RATE, outputFile)
    console.log(`Finished writing to ${outputFile}`)
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

main().catch((err) => {
  console.error(err)
  if (global.Bare) global.Bare.exit(1)
  else process.exit(1)
})
