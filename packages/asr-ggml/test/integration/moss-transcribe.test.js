'use strict'

const fs = require('bare-fs')
const path = require('bare-path')
const process = require('bare-process')
const test = require('brittle')
const { binding, ASRGgml, setupJsLogger, getTestPaths } = require('./parakeet-helpers.js')

const { samplesDir } = getTestPaths()
const modelPath = process.env.QVAC_TEST_MOSS_TRANSCRIBE_GGUF || ''
const backend = process.env.QVAC_TEST_MOSS_TRANSCRIBE_BACKEND || 'auto'
const samplePath = path.join(samplesDir, 'LastQuestion_long_ES.raw')
const SAMPLE_RATE = 16000
const AUDIO_SECONDS = 20
const MAX_NEW_TOKENS = 256
const INT16_SCALE = 32768
const TEST_TIMEOUT_MS = 900000
const HOTWORDS = ['Multivac', 'Alexander Adell', 'Bertram Lupov']

function missingFixture(t, message) {
  if (backend !== 'auto') {
    t.fail(`${message}; explicit backend validation requires all fixtures`)
  } else {
    t.pass(`${message} - skipping`)
  }
}

function loadSpanishOrSkip(t) {
  if (!modelPath || !fs.existsSync(modelPath)) {
    missingFixture(t, 'QVAC_TEST_MOSS_TRANSCRIBE_GGUF is not available')
    return null
  }
  if (!fs.existsSync(samplePath)) {
    missingFixture(t, 'LastQuestion_long_ES.raw is not available')
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
        mossTranscribeConfig: { maxThreads: 4, useGPU: process.env.NO_GPU !== 'true', backend }
      }
    })

    try {
      await model.load()
      const info = model.getBackendInfo()
      t.ok(info, 'backend info is available')
      if (backend !== 'auto') {
        const expectedId = { cpu: 0, cuda: 2, vulkan: 3 }[backend]
        if (expectedId !== undefined) {
          t.is(info.backendId, expectedId, 'requested backend is active')
        } else {
          t.is(info.backendName, backend, 'requested device is active')
        }
      }
      const plain = await collect(await model.run(audio, { maxNewTokens: MAX_NEW_TOKENS }))
      assertLabelledSegments(t, 'default prompt', plain.segments)

      const biased = await collect(
        await model.run(audio, { hotwords: HOTWORDS, maxNewTokens: MAX_NEW_TOKENS })
      )
      assertLabelledSegments(t, 'hotword prompt', biased.segments)
    } finally {
      await model.unload().catch(() => {})
      logger.releaseLogger()
    }
  }
)
