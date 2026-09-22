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
 * `compute-path-not-supported`. That is a refusal, and it carries no figures.
 */
function projected(t, fit) {
  if (fit.reason === 'compute-path-not-supported') {
    t.pass('this runner’s compute path is not modelled')
    return false
  }
  return true
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

  const fit = TTSGgml.assessFit({
    engineType: 'supertonic',
    supertonicModelPath: model,
    useGPU: true
  })

  t.comment(`status=${fit.status} reason=${fit.reason} device=${fit.deviceName}`)
  if (!projected(t, fit)) return
  t.ok(fit.status === 'fits' || fit.status === 'does-not-fit', 'a verdict, not an error')
  t.ok(fit.deviceTotalBytes > 0, 'the device reported its capacity')
  t.ok(fit.deviceFreeBytes <= fit.deviceTotalBytes, 'free never exceeds total')
  t.ok(fit.weightsBytes > 0, 'the weights were measured')
  t.ok(fit.deviceBytes >= fit.weightsBytes, 'weights are part of the device demand')
  t.is(fit.lavasrFileBytes, 0, 'no LavaSR stage was named')
})

test('a weightless copy projects the same', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const model = await supertonicPath(t)
  if (model === null) return

  const full = TTSGgml.assessFit({
    engineType: 'supertonic',
    supertonicModelPath: model,
    useGPU: true
  })
  if (!projected(t, full)) return
  const stub = TTSGgml.assessFit({
    engineType: 'supertonic',
    supertonicModelPath: weightlessCopy(tempDir(t), model, 1024 * 1024),
    useGPU: true
  })

  t.is(stub.status, full.status, 'the same verdict')
  t.is(stub.weightsBytes, full.weightsBytes, 'the same weight footprint')
  t.is(stub.deviceBytes, full.deviceBytes, 'the same device demand')
  t.is(stub.hostBytes, full.hostBytes, 'the same host demand')
})

test('the load’s offload keys reach the projection', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const model = await supertonicPath(t)
  if (model === null) return

  const cpu = TTSGgml.assessFit({
    engineType: 'supertonic',
    supertonicModelPath: model,
    useGPU: false
  })
  const pinned = TTSGgml.assessFit({
    engineType: 'supertonic',
    supertonicModelPath: model,
    nGpuLayers: 0
  })

  t.ok(cpu.deviceIsCpu, 'useGPU false projects on the CPU device')
  t.is(pinned.deviceIsCpu, cpu.deviceIsCpu, 'nGpuLayers 0 agrees with useGPU false')
})

test('a LavaSR stage is sized beside the projection', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const model = await supertonicPath(t)
  if (model === null) return

  const dir = tempDir(t)
  const enhancer = path.join(dir, 'enhancer.gguf')
  fs.writeFileSync(enhancer, Buffer.alloc(4096, 1))

  const fit = TTSGgml.assessFit({
    engineType: 'supertonic',
    supertonicModelPath: model,
    useGPU: true,
    lavasrEnhancerPath: enhancer
  })

  t.is(fit.lavasrFileBytes, 4096, 'the enhancer is reported at its size on disk')
  if (!projected(t, fit)) return
  t.ok(fit.lavasrFileBytes < fit.deviceBytes, 'reported beside the projection')
})

test('a voice with no fitter is an outcome, not a throw', (t) => {
  const fit = TTSGgml.assessFit({
    engineType: 'moss',
    mossBackbonePath: '/models/moss-tts-delay.gguf'
  })

  t.is(fit.status, 'error')
  t.is(fit.reason, 'unsupported-engine')
  t.is(fit.modelVariant, 'moss')
})

test('a model that cannot be read is an outcome, not a throw', (t) => {
  const fit = TTSGgml.assessFit({
    engineType: 'supertonic',
    supertonicModelPath: '/nonexistent/model.gguf'
  })

  t.is(fit.status, 'error')
})

test('a count that is not a count is refused', (t) => {
  t.exception(
    () =>
      TTSGgml.assessFit({
        engineType: 'supertonic',
        supertonicModelPath: '/models/supertonic.gguf',
        textTokens: -1
      }),
    /non-negative count/
  )
})
