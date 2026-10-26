'use strict'

const fs = require('bare-fs')
const path = require('bare-path')
const process = require('bare-process')
const test = require('brittle')

const ASRGgml = require('../../index.js')
const { ensureWhisperModel, ensureVADModel, getTestPaths, getBackendsDir } = require('./helpers.js')

const TEST_TIMEOUT_MS = 900000
const { modelPath, vadModelPath } = getTestPaths()
const backendsDir = getBackendsDir()

const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures')
const MODEL_DESCRIPTION_PATH = path.join(FIXTURES_DIR, 'ggml-tiny.fit.gguf')
const VAD_DESCRIPTION_PATH = path.join(FIXTURES_DIR, 'ggml-silero-v5.1.2.fit.gguf')
const PROJECTED_FIELDS = [
  'status',
  'modelType',
  'deviceName',
  'deviceTotalBytes',
  'deviceBytes',
  'weightsBytes',
  'kvBytes',
  'computeBytes',
  'vadBytes',
  'hostOverflowBytes',
  'hostBytes'
]

const APPLE_PLATFORMS = ['darwin', 'ios']
const QUANTIZATION_SUFFIX = /[.-](?:f16|f32|bf16|q[0-9]_[0-9k]|mxfp4|nvfp4)$/

function sumRows(fit) {
  return fit.deviceBytes + fit.hostBytes
}

function diarizerSidecarPattern(modelPath) {
  const stem = path.basename(modelPath, '.gguf').replace(QUANTIZATION_SUFFIX, '')
  const escaped = stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`^${escaped}-diarizer-[0-9]+\\.mlmodelc$`)
}

function hasDiarizerSidecar(modelPath) {
  const pattern = diarizerSidecarPattern(modelPath)
  return fs.readdirSync(path.dirname(modelPath)).some((name) => pattern.test(name))
}

test('a whisper projection is internally consistent', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  await ensureWhisperModel(modelPath)

  const fit = await ASRGgml.assessFit({ engine: 'whisper', modelPath, backendsDir })

  t.comment(`status=${fit.status} reason=${fit.reason} device=${fit.deviceName}`)
  t.ok(fit.status === 'fits' || fit.status === 'does-not-fit', 'a verdict, not an error')
  t.ok(fit.deviceName.length > 0, 'a device was resolved')
  t.ok(fit.deviceTotalBytes > 0, 'the device reported its capacity')
  t.ok(fit.deviceFreeBytes <= fit.deviceTotalBytes, 'free never exceeds total')
  t.ok(fit.weightsBytes > 0, 'the weights were measured')
  t.ok(sumRows(fit) >= fit.weightsBytes, 'the weights are part of the demand')
  t.is(fit.modelType.length > 0, true, 'the model type was read')
})

test('the backends root resolves a device', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  await ensureWhisperModel(modelPath)

  const fit = await ASRGgml.assessFit({ engine: 'whisper', modelPath, backendsDir })

  // The registry is built once per process, so a root that resolves to nothing
  // would leave every later load in this process without a device too.
  t.not(fit.reason, 'no-backend-device', 'the prebuilds root reached the backends')
})

test('a longer transcribe costs more', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  await ensureWhisperModel(modelPath)

  const short = await ASRGgml.assessFit({
    engine: 'whisper',
    modelPath,
    backendsDir,
    audioSeconds: 30
  })
  const long = await ASRGgml.assessFit({
    engine: 'whisper',
    modelPath,
    backendsDir,
    audioSeconds: 600
  })

  if (short.status === 'error' || long.status === 'error') {
    t.pass('this runner could not project the model')
    return
  }
  t.ok(sumRows(long) >= sumRows(short), 'the longer window never costs less')
})

test('a VAD model is added to the projection', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  await ensureWhisperModel(modelPath)
  const vad = await ensureVADModel(vadModelPath)
  if (!vad || vad.success === false) {
    t.pass('no VAD model on this runner')
    return
  }

  const bare = await ASRGgml.assessFit({ engine: 'whisper', modelPath, backendsDir })
  const withVad = await ASRGgml.assessFit({
    engine: 'whisper',
    modelPath,
    backendsDir,
    vadModelPath
  })

  if (bare.status === 'error' || withVad.status === 'error') {
    t.pass('this runner could not project the model')
    return
  }
  t.is(bare.vadBytes, 0, 'no VAD model was named')
  t.ok(withVad.vadBytes > 0, 'the VAD model was measured')
})

test(
  'the registry descriptions project like the model and VAD model they describe',
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    await ensureWhisperModel(modelPath)
    const vad = await ensureVADModel(vadModelPath)
    if (!vad || vad.success === false) {
      t.pass('no VAD model on this runner')
      return
    }

    const files = await ASRGgml.assessFit({
      engine: 'whisper',
      modelPath,
      vadModelPath,
      backendsDir
    })
    const descriptions = await ASRGgml.assessFit({
      engine: 'whisper',
      modelPath: MODEL_DESCRIPTION_PATH,
      vadModelPath: VAD_DESCRIPTION_PATH,
      backendsDir
    })

    t.not(files.status, 'error', 'the model itself was projected')
    for (const field of PROJECTED_FIELDS) {
      t.is(descriptions[field], files[field], `${field} matches`)
    }
  }
)

test(
  'a Nemotron 3 Diarization projection charges its staged Core ML diarizers',
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const modelPath = process.env.QVAC_TEST_NEMOTRON_DIARIZATION_GGUF
    if (!modelPath || !fs.existsSync(modelPath)) {
      t.pass('Set QVAC_TEST_NEMOTRON_DIARIZATION_GGUF to run this model test')
      return
    }

    const fit = await ASRGgml.assessFit({ modelPath, audioSeconds: 30, backendsDir })
    const charged = APPLE_PLATFORMS.includes(process.platform) && hasDiarizerSidecar(modelPath)

    t.not(fit.status, 'error', 'the model was projected')
    t.is(fit.coremlBytes > 0, charged, 'sidecars are charged exactly when Core ML can load them')
  }
)

test('a model that cannot be read is an outcome, not a rejection', async (t) => {
  const fit = await ASRGgml.assessFit({ engine: 'whisper', modelPath: '/nonexistent/model.bin' })

  t.is(fit.status, 'error')
  t.is(fit.reason, 'model-unreadable')
})

test('an unrecognised engine is refused', async (t) => {
  await t.exception(
    ASRGgml.assessFit({ engine: 'nonexistent', modelPath: '/models/model.gguf' }),
    /engine/
  )
})

test('a count that is not a count is refused', async (t) => {
  await t.exception(
    ASRGgml.assessFit({
      engine: 'whisper',
      modelPath: '/models/model.bin',
      decoders: -1
    }),
    /non-negative count/
  )
})

test('a broken request rejects', async (t) => {
  let promise
  t.execution(() => {
    promise = ASRGgml.assessFit({ engine: 'nonexistent', modelPath: '/models/model.gguf' })
  }, 'the call itself returns')
  t.ok(promise instanceof Promise)
  await t.exception(promise)
})

test('fitting keeps the event loop responsive', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  await ensureWhisperModel(modelPath)

  let pending = true
  let turns = 0
  const spin = () => {
    if (!pending) return
    turns++
    setImmediate(spin)
  }
  setImmediate(spin)

  const fits = await Promise.all(
    [30, 60, 120, 300].map((audioSeconds) =>
      ASRGgml.assessFit({ engine: 'whisper', modelPath, backendsDir, audioSeconds })
    )
  )
  pending = false

  t.comment(`${turns} loop turns before the fits settled`)
  t.ok(turns > 0, 'the loop turned while the fitter ran')
  for (const fit of fits) {
    t.not(fit.status, 'error', 'every queued fit completed')
  }
})

test(
  'queued fits keep their own requests and all settle',
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    await ensureWhisperModel(modelPath)

    const request = { engine: 'whisper', modelPath, backendsDir, audioSeconds: 30 }
    const short = ASRGgml.assessFit(request)
    request.audioSeconds = 600
    const long = ASRGgml.assessFit(request)
    const missing = ASRGgml.assessFit({ engine: 'whisper', modelPath: '/nonexistent/model.bin' })
    const parakeetMissing = ASRGgml.assessFit({ modelPath: '/nonexistent/model.gguf' })

    const [a, b, c, d] = await Promise.all([short, long, missing, parakeetMissing])
    t.not(a.status, 'error', 'the first call was projected')
    t.not(b.status, 'error', 'the second call was projected')
    t.ok(sumRows(b) >= sumRows(a), 'each call kept the duration it was given')
    t.is(c.reason, 'model-unreadable', 'an error outcome does not strand queued callers')
    t.is(d.status, 'error', 'another engine queues behind the same lock')
  }
)

test('a fit in flight survives an instance unload', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  await ensureWhisperModel(modelPath)

  const model = new ASRGgml({
    files: { model: modelPath },
    config: { engine: 'whisper', whisperConfig: { language: 'en' } }
  })
  try {
    await model.load()
    const fit = ASRGgml.assessFit({ engine: 'whisper', modelPath, backendsDir })
    await model.unload()
    const result = await fit
    t.not(result.status, 'error', 'unloading the instance did not disturb the fit')
    t.ok(result.deviceName.length > 0, 'the resolved device survives the unload')
  } finally {
    await model.unload()
  }
})
