'use strict'

const fs = require('bare-fs')
const path = require('bare-path')
const process = require('bare-process')
const test = require('brittle')
const { binding, ASRGgml, setupJsLogger, getTestPaths } = require('./parakeet-helpers.js')

const { samplesDir } = getTestPaths()
const modelPath = process.env.QVAC_TEST_MOSS_TRANSCRIBE_GGUF || ''
const samplePath = path.join(samplesDir, 'LastQuestion_long_ES.raw')
const SAMPLE_RATE = 16000
const AUDIO_SECONDS = 20
const MAX_NEW_TOKENS = 256
const INT16_SCALE = 32768
const TEST_TIMEOUT_MS = 900000
const HOTWORDS = ['Multivac', 'Alexander Adell', 'Bertram Lupov']

function loadSpanishOrSkip(t) {
  if (!modelPath || !fs.existsSync(modelPath)) {
    t.pass('QVAC_TEST_MOSS_TRANSCRIBE_GGUF is not available - skipping')
    return null
  }
  if (!fs.existsSync(samplePath)) {
    t.pass('LastQuestion_long_ES.raw is not available - skipping')
    return null
  }
  const raw = fs.readFileSync(samplePath)
  const samples = Math.min(raw.byteLength / 2, AUDIO_SECONDS * SAMPLE_RATE)
  const pcm = new Int16Array(raw.buffer, raw.byteOffset, samples)
  return Float32Array.from(pcm, (value) => value / INT16_SCALE)
}

async function collect(response) {
  const segments = []
  await response
    .onUpdate((value) => {
      for (const segment of Array.isArray(value) ? value : [value]) {
        if (segment && segment.text) segments.push(segment)
      }
    })
    .await()
  return { segments, stats: response.stats }
}

function assertLabelledSegments(t, label, segments) {
  t.ok(segments.length > 0, `${label} produced segments`)
  t.ok(
    segments.every((segment) => /^S\d+$/.test(segment.speaker)),
    `${label} labels every segment with a speaker`
  )
  t.ok(
    segments.every((segment) => segment.speakerId === Number(segment.speaker.slice(1)) - 1),
    `${label} maps each label to a 0-based speakerId`
  )
  t.ok(
    segments.every((segment) => segment.start <= segment.end),
    `${label} keeps ordered timestamps`
  )
}

test(
  'MOSS-Transcribe-Diarize: Spanish speech gets speaker-labelled segments, with and without hotwords',
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const audio = loadSpanishOrSkip(t)
    if (!audio) return

    const logger = setupJsLogger(binding)
    const model = new ASRGgml({
      files: { model: modelPath },
      config: {
        engine: 'moss-transcribe',
        mossTranscribeConfig: { maxThreads: 4, useGPU: process.env.NO_GPU !== 'true' }
      }
    })

    try {
      await model.load()
      const plain = await collect(await model.run(audio, { maxNewTokens: MAX_NEW_TOKENS }))
      assertLabelledSegments(t, 'default prompt', plain.segments)

      const biased = await collect(
        await model.run(audio, { hotwords: HOTWORDS, maxNewTokens: MAX_NEW_TOKENS })
      )
      assertLabelledSegments(t, 'hotword prompt', biased.segments)
      t.ok(model.getBackendInfo(), 'backend info is available')
    } finally {
      await model.unload().catch(() => {})
      logger.releaseLogger()
    }
  }
)
