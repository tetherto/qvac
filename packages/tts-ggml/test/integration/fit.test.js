'use strict'

const fs = require('bare-fs')
const os = require('bare-os')
const path = require('bare-path')
const test = require('brittle')

const TTSGgml = require('@qvac/tts-ggml')
const { ensureSupertonicModel } = require('../utils/downloadModel')

const TEST_TIMEOUT_MS = 900000

let modelPath = null

async function supertonicPath(t) {
  if (modelPath === null) {
    const resolved = await ensureSupertonicModel()
    modelPath = resolved.success ? resolved.path : ''
  }
  if (modelPath === '') {
    t.pass('Supertonic GGUF unavailable on this runner')
    return null
  }
  return modelPath
}

/**
 * The supertonic fitter covers the fused graph path: a validated GPU, or a CPU
 * without the Accelerate pointwise kernels. A runner outside that answers
 * `unknown`, and it carries no rows.
 */
function projected(t, fit) {
  if (fit.status === 'unknown') {
    t.is(fit.devices.length, 0, 'an unknown carries no rows')
    return false
  }
  return true
}

function hostRow(fit) {
  return fit.devices[fit.devices.length - 1]
}

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-fit-'))
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

/**
 * The registry's weightless copy of a GGUF: the header and tensor table as
 * written, and a hole where the tensor data was. The file keeps its length so
 * every offset in the header still resolves.
 */
function weightlessCopy(dir, sourcePath, headerBytes) {
  const target = path.join(dir, 'weightless.gguf')
  const source = fs.openSync(sourcePath, 'r')
  const header = Buffer.alloc(headerBytes)
  fs.readSync(source, header, 0, headerBytes, 0)
  fs.closeSync(source)

  fs.writeFileSync(target, header)
  fs.truncateSync(target, fs.statSync(sourcePath).size)
  return target
}

test('a projection is internally consistent', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const model = await supertonicPath(t)
  if (model === null) return

  const fit = await TTSGgml.assessFit({
    engineType: 'supertonic',
    supertonicModelPath: model,
    useGPU: true
  })

  t.comment(JSON.stringify(fit))
  if (!projected(t, fit)) return
  t.ok(fit.status === 'fits' || fit.status === 'does-not-fit', 'a verdict')
  t.ok(fit.devices.length >= 1, 'at least the device the load resolves to')
  for (const row of fit.devices) {
    t.ok(row.id.length > 0 && row.name.length > 0, `${row.name} is named`)
    t.ok(row.totalBytes > 0, `${row.name} reported its capacity`)
    t.ok(row.freeBytes <= row.totalBytes, `${row.name} free never exceeds total`)
  }
  t.ok(fit.devices[0].usedBytes > 0, 'the device demand was measured')
  t.is(hostRow(fit).name, 'CPU', 'the host row is last')
  t.ok(hostRow(fit).unified, 'the host row is unified')
  t.alike(fit.stats, {})
})

test('a weightless copy projects the same', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const model = await supertonicPath(t)
  if (model === null) return

  const full = await TTSGgml.assessFit({
    engineType: 'supertonic',
    supertonicModelPath: model,
    useGPU: true
  })
  if (!projected(t, full)) return
  const stub = await TTSGgml.assessFit({
    engineType: 'supertonic',
    supertonicModelPath: weightlessCopy(tempDir(t), model, 1024 * 1024),
    useGPU: true
  })

  t.is(stub.status, full.status, 'the same verdict')
  t.alike(
    stub.devices.map((row) => [row.id, row.usedBytes]),
    full.devices.map((row) => [row.id, row.usedBytes]),
    'the same demand on the same devices'
  )
})

test('the load’s offload keys reach the projection', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const model = await supertonicPath(t)
  if (model === null) return

  const cpu = await TTSGgml.assessFit({
    engineType: 'supertonic',
    supertonicModelPath: model,
    useGPU: false
  })
  const pinned = await TTSGgml.assessFit({
    engineType: 'supertonic',
    supertonicModelPath: model,
    nGpuLayers: 0
  })

  t.is(pinned.status, cpu.status, 'nGpuLayers 0 agrees with useGPU false')
  if (!projected(t, cpu)) return
  t.is(cpu.devices.length, 1, 'useGPU false projects on the CPU alone')
  t.ok(cpu.devices[0].unified, 'the CPU row is the host')
  // Free memory is read again by each call, so only the placement and the
  // demand are compared.
  const placement = (fit) => fit.devices.map(({ freeBytes, ...row }) => row)
  t.alike(placement(pinned), placement(cpu), 'the same row')
})

test('fitting keeps the event loop responsive', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const model = await supertonicPath(t)
  if (model === null) return

  const request = { engineType: 'supertonic', supertonicModelPath: model, useGPU: true }

  let pending = true
  let turns = 0
  const spin = () => {
    if (!pending) return
    turns++
    setImmediate(spin)
  }
  setImmediate(spin)

  const first = TTSGgml.assessFit(request)
  t.ok(first instanceof Promise, 'the call returns before the projection')
  const fits = await Promise.all([
    first,
    ...Array.from({ length: 15 }, () => TTSGgml.assessFit(request))
  ])
  pending = false

  t.comment(`${turns} loop turns before the fits settled`)
  t.ok(turns > 0, 'the loop turned while the fitter ran')
  t.is(new Set(fits.map((fit) => fit.status)).size, 1, 'every queued projection agrees')
})

test(
  'concurrent fits keep their own requests and all settle',
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const model = await supertonicPath(t)
    if (model === null) return

    const request = { engineType: 'supertonic', supertonicModelPath: model, useGPU: true }
    const first = TTSGgml.assessFit(request)
    request.supertonicModelPath = '/nonexistent/model.gguf'
    const second = TTSGgml.assessFit(request)
    const third = TTSGgml.assessFit({ ...request, supertonicModelPath: model })
    const [a, b, c] = await Promise.allSettled([first, second, third])

    t.is(a.status, 'fulfilled', 'the first call owns its original request')
    t.is(b.status, 'rejected', 'the second call owns its changed request')
    t.is(c.status, 'fulfilled', 'a rejection does not strand queued callers')
  }
)

test('a fit settles while a loaded model unloads', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const model = await supertonicPath(t)
  if (model === null) return

  const voice = new TTSGgml({
    engine: TTSGgml.ENGINE_SUPERTONIC,
    files: { supertonicModel: model },
    voice: 'F1',
    config: { language: 'en', useGPU: false }
  })
  await voice.load()
  try {
    const fit = TTSGgml.assessFit({
      engineType: 'supertonic',
      supertonicModelPath: model,
      useGPU: true
    })
    await voice.unload()
    const result = await fit
    t.ok(['fits', 'does-not-fit', 'unknown'].includes(result.status), 'the fit settled')
  } finally {
    try {
      await voice.unload()
    } catch (_e) {}
  }
})

test('MOSS routes to its fitter when a model cannot be read', async (t) => {
  await t.exception(
    TTSGgml.assessFit({
      engineType: 'moss',
      mossBackbonePath: '/models/moss-tts-delay.gguf',
      mossCodecDecoderPath: '/models/moss-codec-decoder.gguf',
      promptRows: 128,
      referenceSamples: 0,
      streaming: false
    }),
    /model-unreadable/
  )
})

test('a model that cannot be read rejects', async (t) => {
  await t.exception(
    TTSGgml.assessFit({
      engineType: 'supertonic',
      supertonicModelPath: '/nonexistent/model.gguf'
    }),
    /model-unreadable/
  )
})

test('a voice with no fitter rejects', async (t) => {
  await t.exception(
    TTSGgml.assessFit({ engineType: 'moss-speech', mossSpeechModelPath: '/models/speech.gguf' }),
    /has no fitter/
  )
})

test('a count that is not a count is refused', async (t) => {
  await t.exception(
    TTSGgml.assessFit({
      engineType: 'supertonic',
      supertonicModelPath: '/models/supertonic.gguf',
      textTokens: -1
    }),
    /non-negative count/
  )
})

test('a broken request rejects', async (t) => {
  let promise
  t.execution(() => {
    promise = TTSGgml.assessFit({})
  }, 'the call itself does not throw')
  t.ok(promise instanceof Promise)
  await t.exception(promise, /engineType is required/)
})
