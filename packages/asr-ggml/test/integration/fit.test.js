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

const isVerdict = (fit) => fit.status === 'fits' || fit.status === 'does-not-fit'
const totalUsed = (fit) => fit.devices.reduce((sum, row) => sum + row.usedBytes, 0)

const APPLE_PLATFORMS = ['darwin', 'ios']
const QUANTIZATION_SUFFIX = /[.-](?:f16|f32|bf16|q[0-9]_[0-9k]|mxfp4|nvfp4)$/
// The smallest diarizer capacity's weights; a charged bundle costs more.
const SMALLEST_DIARIZER_BYTES = 190 * 1024 * 1024

function diarizerSidecarPattern(modelPath) {
  const stem = path.basename(modelPath, '.gguf').replace(QUANTIZATION_SUFFIX, '')
  const escaped = stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`^${escaped}-diarizer-[0-9]+\\.mlmodelc$`)
}

function hasDiarizerSidecar(modelPath) {
  const pattern = diarizerSidecarPattern(modelPath)
  return fs.readdirSync(path.dirname(modelPath)).some((name) => pattern.test(name))
}

test(
  'a whisper projection lists its device, the host last',
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    await ensureWhisperModel(modelPath)

    const fit = await ASRGgml.assessFit({ engine: 'whisper', modelPath, backendsDir })

    t.comment(`status=${fit.status} devices=${JSON.stringify(fit.devices)}`)
    t.ok(isVerdict(fit), 'a verdict')
    t.ok(fit.devices.length > 0, 'at least one row')
    t.is(fit.devices.at(-1).name, 'CPU', 'the host row is last')
    t.is(fit.devices.at(-1).unified, true, 'the host row is unified')
    t.alike(fit.stats, {})
    for (const row of fit.devices) {
      t.ok(row.id.length > 0, `${row.name} has an id`)
      t.ok(row.usedBytes > 0, `${row.name} has a usage`)
      t.ok(row.freeBytes <= row.totalBytes, `${row.name} has free within total`)
    }
    const ids = fit.devices.map((row) => row.id)
    t.is(new Set(ids).size, ids.length, 'one row per device')
  }
)

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

  t.ok(totalUsed(long) >= totalUsed(short), 'the longer window never costs less')
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

  t.ok(totalUsed(withVad) > totalUsed(bare), 'the VAD model costs memory')
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

    t.is(descriptions.status, files.status, 'the same verdict')
    t.alike(
      descriptions.devices.map((row) => [row.id, row.usedBytes]),
      files.devices.map((row) => [row.id, row.usedBytes]),
      'the same usage on the same devices'
    )
  }
)

test(
  'a Nemotron 3 Diarization projection charges its staged Core ML diarizers',
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const nemotronPath = process.env.QVAC_TEST_NEMOTRON_DIARIZATION_GGUF
    if (!nemotronPath || !fs.existsSync(nemotronPath)) {
      t.pass('Set QVAC_TEST_NEMOTRON_DIARIZATION_GGUF to run this model test')
      return
    }

    const request = { modelPath: nemotronPath, audioSeconds: 30, backendsDir }
    const fit = await ASRGgml.assessFit(request)
    const charged = APPLE_PLATFORMS.includes(process.platform) && hasDiarizerSidecar(nemotronPath)

    t.ok(isVerdict(fit), 'the model was projected')
    if (!charged) return

    process.env.PARAKEET_COREML_DIARIZER_DISABLE = '1'
    let withoutDiarizers
    try {
      withoutDiarizers = await ASRGgml.assessFit(request)
    } finally {
      delete process.env.PARAKEET_COREML_DIARIZER_DISABLE
    }
    t.ok(
      fit.devices.at(-1).usedBytes - withoutDiarizers.devices.at(-1).usedBytes >=
        SMALLEST_DIARIZER_BYTES,
      'the host row holds at least one diarizer bundle'
    )
  }
)

test('a model that cannot be read rejects', async (t) => {
  await t.exception(
    ASRGgml.assessFit({ engine: 'whisper', modelPath: '/nonexistent/model.bin' }),
    /model-unreadable/
  )
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
    t.ok(isVerdict(fit), 'every queued fit completed')
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

    const [a, b, c, d] = await Promise.allSettled([short, long, missing, parakeetMissing])
    t.is(a.status, 'fulfilled', 'the first call was projected')
    t.is(b.status, 'fulfilled', 'the second call was projected')
    t.ok(totalUsed(b.value) >= totalUsed(a.value), 'each call kept the duration it was given')
    t.is(c.status, 'rejected', 'a rejection does not strand queued callers')
    t.is(d.status, 'rejected', 'another engine queues behind the same lock')
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
    t.ok(isVerdict(result), 'unloading the instance did not disturb the fit')
    t.ok(result.devices.length > 0, 'the resolved device survives the unload')
  } finally {
    await model.unload()
  }
})
