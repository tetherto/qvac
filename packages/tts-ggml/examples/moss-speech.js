'use strict'

/**
 * MOSS-Speech speech-to-speech for @qvac/tts-ggml.
 *
 * MOSS-Speech answers a spoken question with speech, with no text step in
 * between: a 9B language model with separate text and audio branches reads
 * the question's speech tokens and writes the reply's, and the codec speaks
 * them in a 24 kHz voice (the codec's default voice, or a reference WAV).
 *
 * Usage:
 *   bare examples/moss-speech.js question.wav [reply-voice.wav]
 *
 * Examples:
 *   bare examples/moss-speech.js test/reference-audio/jfk.wav
 *   QVAC_TTS_MOSS_SPEECH_GPU=1 bare examples/moss-speech.js question.wav my-voice.wav
 *   QVAC_TTS_MOSS_SPEECH_TEXT=1 bare examples/moss-speech.js question.wav
 *
 * Expects the MOSS-Speech language model (moss-speech-q8_0.gguf or
 * moss-speech-bf16.gguf) and its codec (moss-speech-codec-f16.gguf) under:
 *   models/
 * Produce them with engines/tts/scripts/convert-moss-speech-to-gguf.py and
 * convert-moss-speech-codec-to-gguf.py in qvac-fabric-speech.cpp until they
 * are published to the model registry. Desktop only; use a GPU.
 */

const path = require('bare-path')
const proc = require('bare-process')
const TTSGgml = require('../')
const { createWav, readWavAsFloat32 } = require('./wav-helper')
const { setLogger, releaseLogger } = require('../addonLogging')

const SPEECH_SAMPLE_RATE = 24000

const argv = global.Bare ? global.Bare.argv : process.argv
const questionArg = argv[2]
const voiceArg = argv[3]
const textReply = proc.env.QVAC_TTS_MOSS_SPEECH_TEXT === '1'

function fail(message) {
  console.error(message)
  if (global.Bare) global.Bare.exit(1)
  else process.exit(1)
}

if (!questionArg) {
  fail('Usage: moss-speech.js <question.wav> [reply-voice.wav]')
}

const pkgRoot = path.join(__dirname, '..')
const modelDir = path.join(pkgRoot, 'models')

function buildModel() {
  return new TTSGgml({
    engine: TTSGgml.ENGINE_MOSS_SPEECH,
    files: { modelDir },
    config: { useGPU: proc.env.QVAC_TTS_MOSS_SPEECH_GPU === '1' },
    logger: console,
    opts: { stats: true }
  })
}

function replyVoiceFields() {
  if (!voiceArg) return {}
  const voice = readWavAsFloat32(path.resolve(voiceArg))
  return { replyVoice: voice.samples, replyVoiceSampleRate: voice.sampleRate }
}

function reportStats(stats) {
  if (!stats) return
  console.log(
    `Reply stats: totalTime=${stats.totalTime.toFixed(2)}s, ` +
      `audioDuration=${stats.audioDurationMs}ms, promptTokens=${stats.promptTokens}, ` +
      `replyTokens=${stats.replyTokens}, truncated=${stats.truncated}, ` +
      `backendDevice=${stats.backendDevice}, backendId=${stats.backendId}`
  )
}

async function collectReply(response) {
  const reply = { pcm: [], text: '' }
  await response
    .onUpdate((data) => {
      if (data && data.outputArray) reply.pcm = reply.pcm.concat(Array.from(data.outputArray))
      if (data && typeof data.text === 'string') reply.text += data.text
    })
    .await()
  return reply
}

async function main() {
  setLogger((priority, message) => {
    if (priority > 1) return
    const names = { 0: 'ERROR', 1: 'WARNING', 2: 'INFO', 3: 'DEBUG', 4: 'OFF' }
    const name = names[priority] || 'UNKNOWN'
    console.log(`[${new Date().toISOString()}] [C++ log] [${name}]: ${message}`)
  })

  const outputFile = path.join(__dirname, 'moss-speech-reply.wav')
  const question = readWavAsFloat32(path.resolve(questionArg))
  const model = buildModel()

  try {
    console.log('Loading MOSS-Speech model...')
    await model.load()
    console.log('Model loaded.')

    console.log(`Answering ${questionArg} (${(question.samples.length / question.sampleRate).toFixed(1)} s)`)
    const response = await model.run({
      type: 'text',
      input: '',
      audio: question.samples,
      sampleRate: question.sampleRate,
      textReply,
      ...replyVoiceFields()
    })
    const reply = await collectReply(response)

    console.log('Reply finished!')
    if (reply.text) console.log(`Reply text: ${reply.text}`)
    reportStats(response.stats)

    if (reply.pcm.length > 0) {
      createWav(reply.pcm, SPEECH_SAMPLE_RATE, outputFile)
      console.log(`Finished writing to ${outputFile}`)
    }
  } finally {
    await model.unload()
    releaseLogger()
  }
}

main().catch((err) => {
  console.error(err)
  if (global.Bare) global.Bare.exit(1)
  else process.exit(1)
})
