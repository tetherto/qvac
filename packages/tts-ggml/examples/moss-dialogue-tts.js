'use strict'

/**
 * MOSS-TTSD multi-speaker dialogue for @qvac/tts-ggml.
 *
 * Pass one reference recording per speaker, sampled at 24 kHz, in the order
 * the text tags them with [S1], [S2], and so on.  The model continues the
 * references, so the text must open with what each recording says, under its
 * tag, followed by the lines to generate; only the new lines come out as audio.
 *
 * Usage:
 *   bare examples/moss-dialogue-tts.js "<[S1] ... [S2] ...>" speaker1.wav [speaker2.wav ...]
 *
 * Examples:
 *   bare examples/moss-dialogue-tts.js "[S1] What alice.wav says. [S2] What bob.wav says. [S1] Did the build finish? [S2] Yes, every test passed." alice.wav bob.wav
 *   QVAC_TTS_MOSS_GPU=1 bare examples/moss-dialogue-tts.js "..." alice.wav bob.wav
 *
 * Expects the MOSS-TTSD backbone (moss-ttsd-f16.gguf) and both codec halves
 * (moss-codec-decoder-f16.gguf, moss-codec-encoder-f16.gguf) under:
 *   models/
 * Produce them with the converters in qvac-fabric-speech.cpp
 * (engines/tts/scripts/convert-moss-delay-to-gguf.py and
 * convert-moss-codec-to-gguf.py) until they are published to the model
 * registry.
 */

const path = require('bare-path')
const proc = require('bare-process')
const TTSGgml = require('../')
const { createWav } = require('./wav-helper')
const { setLogger, releaseLogger } = require('../addonLogging')

const MOSS_SAMPLE_RATE = 24000
const DEFAULT_LANGUAGE = 'en'

const argv = global.Bare ? global.Bare.argv : process.argv
const textArg = argv[2]
const referenceArgs = argv.slice(3)

function fail(message) {
  console.error(message)
  if (global.Bare) global.Bare.exit(1)
  else process.exit(1)
}

if (!textArg || typeof textArg !== 'string' || referenceArgs.length === 0) {
  fail('Usage: moss-dialogue-tts.js "<[S1] ... [S2] ...>" speaker1.wav [speaker2.wav ...]')
}

const modelDir = path.join(__dirname, '..', 'models')

function buildModel() {
  return new TTSGgml({
    engine: TTSGgml.ENGINE_MOSS,
    files: { modelDir },
    dialogueReferences: referenceArgs.map((file) => path.resolve(file)),
    config: {
      language: DEFAULT_LANGUAGE,
      useGPU: proc.env.QVAC_TTS_MOSS_GPU === '1'
    },
    logger: console,
    opts: { stats: true }
  })
}

function reportStats(stats) {
  if (!stats) return
  console.log(
    `Inference stats: totalTime=${stats.totalTime.toFixed(2)}s, ` +
      `framesPerSecond=${stats.tokensPerSecond.toFixed(2)}, ` +
      `realTimeFactor=${stats.realTimeFactor.toFixed(3)}, ` +
      `audioDuration=${stats.audioDurationMs}ms, ` +
      `backendDevice=${stats.backendDevice}, backendId=${stats.backendId}`
  )
}

async function collectPcm(response) {
  let buffer = []
  await response
    .onUpdate((data) => {
      if (data && data.outputArray) buffer = buffer.concat(Array.from(data.outputArray))
    })
    .await()
  return buffer
}

async function main() {
  setLogger((priority, message) => {
    if (priority > 1) return
    const names = { 0: 'ERROR', 1: 'WARNING', 2: 'INFO', 3: 'DEBUG', 4: 'OFF' }
    const name = names[priority] || 'UNKNOWN'
    console.log(`[${new Date().toISOString()}] [C++ log] [${name}]: ${message}`)
  })

  const outputFile = path.join(__dirname, 'moss-dialogue-output.wav')
  const model = buildModel()

  try {
    console.log('Loading MOSS-TTSD model...')
    await model.load()
    console.log(`Synthesizing a ${referenceArgs.length}-speaker dialogue...`)
    const response = await model.run({ input: textArg, type: 'text' })
    const buffer = await collectPcm(response)
    reportStats(response.stats)
    createWav(buffer, MOSS_SAMPLE_RATE, outputFile)
    console.log(`Finished writing to ${outputFile}`)
  } finally {
    await model.unload()
    releaseLogger()
  }
}

main().catch((err) => fail(err))
