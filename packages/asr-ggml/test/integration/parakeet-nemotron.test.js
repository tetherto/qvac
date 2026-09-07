'use strict'

const fs = require('bare-fs')
const path = require('bare-path')
const process = require('bare-process')
const test = require('brittle')
const { binding, ASRGgml, setupJsLogger, getTestPaths } = require('./parakeet-helpers.js')

const { samplesDir } = getTestPaths()
const modelPath = process.env.QVAC_TEST_GGUF_NEMOTRON || ''
const samplePath = path.join(samplesDir, 'sample.raw')

function loadAudioOrSkip(t) {
  if (!modelPath || !fs.existsSync(modelPath)) {
    t.pass('QVAC_TEST_GGUF_NEMOTRON is not available - skipping')
    return null
  }
  if (!fs.existsSync(samplePath)) {
    t.pass('sample.raw is not available - skipping')
    return null
  }

  const raw = fs.readFileSync(samplePath)
  const pcm = new Int16Array(raw.buffer, raw.byteOffset, raw.byteLength / 2)
  const audio = new Float32Array(pcm.length)
  for (let i = 0; i < pcm.length; i++) audio[i] = pcm[i] / 32768
  return audio
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
  return segments
}

test('Nemotron batch transcription accepts an explicit locale', { timeout: 600000 }, async (t) => {
  const audio = loadAudioOrSkip(t)
  if (!audio) return

  const logger = setupJsLogger(binding)
  const model = new ASRGgml({
    files: { model: modelPath },
    config: {
      engine: 'parakeet',
      parakeetConfig: { language: 'en-US', maxThreads: 4, useGPU: false }
    }
  })

  try {
    await model.load()
    const segments = await collect(await model.run(audio))
    t.ok(segments.length > 0, 'Nemotron produced batch transcript segments')
  } finally {
    await model.unload().catch(() => {})
    logger.releaseLogger()
  }
})

test(
  'Nemotron duplex streaming uses the implicit 320ms operating point',
  { timeout: 600000 },
  async (t) => {
    const audio = loadAudioOrSkip(t)
    if (!audio) return

    const logger = setupJsLogger(binding)
    const model = new ASRGgml({
      files: { model: modelPath },
      config: {
        engine: 'parakeet',
        parakeetConfig: {
          streaming: true,
          language: 'auto',
          maxThreads: 4,
          useGPU: false
        }
      }
    })

    async function* input() {
      const feedSamples = (16000 * 160) / 1000
      for (let offset = 0; offset < audio.length; offset += feedSamples) {
        yield audio.subarray(offset, Math.min(offset + feedSamples, audio.length))
      }
    }

    try {
      await model.load()
      const segments = await collect(await model.runStreaming(input()))
      t.ok(segments.length > 0, 'Nemotron produced streaming transcript segments')
    } finally {
      await model.unload().catch(() => {})
      logger.releaseLogger()
    }
  }
)

test('Nemotron rejects an unsupported locale', { timeout: 600000 }, async (t) => {
  if (!loadAudioOrSkip(t)) return

  const logger = setupJsLogger(binding)
  const model = new ASRGgml({
    files: { model: modelPath },
    config: {
      engine: 'parakeet',
      parakeetConfig: { language: 'not-a-locale' }
    }
  })

  try {
    await model.load()
    t.fail('unsupported locale should reject model loading')
  } catch (error) {
    t.ok(
      String(error.message).includes('unsupported Nemotron locale'),
      'speech-cpp locale error is preserved'
    )
  } finally {
    await model.unload().catch(() => {})
    logger.releaseLogger()
  }
})
