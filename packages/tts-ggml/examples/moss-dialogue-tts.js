'use strict'

/**
 * MOSS-TTSD multi-speaker dialogue for @qvac/tts-ggml.
 *
 * Pass one 24 kHz reference recording per speaker, in the order the text tags
 * them with [S1], [S2], and so on.  The model continues the references, so the
 * text must open with what each recording says, under its tag, followed by the
 * lines to generate; only the new lines come out as audio.  The dialogue
 * backbone (moss-ttsd-f16.gguf)
 * and the codec's analysis half (moss-codec-encoder-f16.gguf) must sit next to
 * the codec decoder under models/.
 *
 * Usage:
 *   bare examples/moss-dialogue-tts.js "<[S1] ... [S2] ...>" speaker1.wav speaker2.wav [...]
 *
 * Example:
 *   bare examples/moss-dialogue-tts.js "[S1] What alice.wav says. [S2] What bob.wav says. [S1] Did the build finish? [S2] Yes, every test passed." alice.wav bob.wav
 */

const path = require('bare-path')
const proc = require('bare-process')
const TTSGgml = require('../')
const { createWav } = require('./wav-helper')

const MOSS_SAMPLE_RATE = 24000
const DEFAULT_LANGUAGE = 'en'
const MIN_SPEAKERS = 2

const argv = global.Bare ? global.Bare.argv : process.argv
const textArg = argv[2]
const referenceArgs = argv.slice(3)

function fail(message) {
  console.error(message)
  if (global.Bare) global.Bare.exit(1)
  else process.exit(1)
}

if (!textArg || referenceArgs.length < MIN_SPEAKERS) {
  fail('Usage: moss-dialogue-tts.js "<[S1] ... [S2] ...>" speaker1.wav speaker2.wav [...]')
}

const modelDir = path.join(__dirname, '..', 'models')

function buildModel() {
  return new TTSGgml({
    engine: TTSGgml.ENGINE_MOSS,
    files: { modelDir },
    dialogueReferences: referenceArgs.map((file) => path.resolve(file)),
    config: { language: DEFAULT_LANGUAGE, useGPU: proc.env.QVAC_TTS_MOSS_GPU === '1' },
    logger: console,
    opts: { stats: true }
  })
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
  const outputFile = path.join(__dirname, 'moss-dialogue-output.wav')
  const model = buildModel()
  try {
    await model.load()
    console.log(`Synthesizing a ${referenceArgs.length}-speaker dialogue...`)
    const response = await model.run({ input: textArg, type: 'text' })
    const buffer = await collectPcm(response)
    createWav(buffer, MOSS_SAMPLE_RATE, outputFile)
    console.log(`Finished writing to ${outputFile}`)
  } finally {
    await model.unload()
  }
}

main().catch((err) => {
  console.error(err)
  if (global.Bare) global.Bare.exit(1)
  else process.exit(1)
})
