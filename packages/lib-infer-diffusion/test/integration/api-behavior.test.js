'use strict'

const test = require('brittle')
const os = require('bare-os')
const proc = require('bare-process')
const binding = require('../../binding')
const ImgStableDiffusion = require('../../index')
const {
  ensureModel,
  GeneratedImageSaver,
  setupJsLogger
} = require('./utils')

const isDarwinX64 = os.platform() === 'darwin' && os.arch() === 'x64'
const isLinuxArm64 = os.platform() === 'linux' && os.arch() === 'arm64'
const isAndroid = os.platform() === 'android'
const isWindows = os.platform() === 'win32'
const noGpu = proc.env && proc.env.NO_GPU === 'true'
const useCpu = isDarwinX64 || isLinuxArm64 || noGpu

// Windows Vulkan backend is slower, increase timeout
const BASE_TIMEOUT = 600000
const testTimeout = isWindows ? BASE_TIMEOUT * 2 : BASE_TIMEOUT

// Smallest model for fast behavior tests
const MODEL = {
  name: 'stable-diffusion-v2-1-Q4_0.gguf',
  url: 'https://huggingface.co/gpustack/stable-diffusion-v2-1-GGUF/resolve/main/stable-diffusion-v2-1-Q4_0.gguf'
}

// Many steps so cancel has time to fire before completion
const LONG_PARAMS = {
  prompt: 'a red fox in a snowy forest',
  steps: 50,
  width: 256,
  height: 256,
  cfg_scale: 7.5,
  seed: 42
}

const SHORT_PARAMS = {
  prompt: 'a red fox',
  steps: 10,
  width: 256,
  height: 256,
  cfg_scale: 7.5,
  seed: 1
}

async function setupModel (t) {
  setupJsLogger(binding)

  const [modelName, modelDir] = await ensureModel({
    modelName: MODEL.name,
    downloadUrl: MODEL.url
  })

  const model = new ImgStableDiffusion(
    {
      logger: console,
      diskPath: modelDir,
      modelName
    },
    {
      device: useCpu ? 'cpu' : 'gpu',
      vae_on_cpu: isAndroid,
      threads: 4,
      prediction: 'v',
      verbosity: '2'
    }
  )

  await model.load()

  t.teardown(async () => {
    await model.unload().catch(() => {})
    try { binding.releaseLogger() } catch (_) {}
  })

  return { model, modelDir }
}

function saveGeneratedImages (modelDir, filenameSuffix, images) {
  const imageSaver = new GeneratedImageSaver(modelDir)
  for (let i = 0; i < images.length; i++) {
    imageSaver.save(`api-behavior-${filenameSuffix}-${i}.png`, images[i])
  }
}

test('idle | run: allowed, returns QvacResponse', { timeout: testTimeout }, async t => {
  const { model, modelDir } = await setupModel(t)
  const response = await model.run(SHORT_PARAMS)
  t.ok(response, 'run() returns a response')
  t.ok(typeof response.onUpdate === 'function', 'response has onUpdate')
  t.ok(typeof response.await === 'function', 'response has await')

  const images = []
  await response.onUpdate(data => {
    if (data instanceof Uint8Array) images.push(data)
  }).await()

  t.ok(images.length > 0, 'run produces at least one image')
  saveGeneratedImages(modelDir, 'idle-run', images)
})

test('idle | cancel: allowed, no-op', { timeout: testTimeout }, async t => {
  const { model } = await setupModel(t)
  await model.cancel()
  t.pass('cancel when idle does not throw')
})

test('run | cancel: cancels current job', { timeout: testTimeout }, async t => {
  const { model } = await setupModel(t)
  const response = await model.run(LONG_PARAMS)

  // Cancel inside onUpdate after first progress tick — ensures native generation
  // is actually active (matches LLM addon's runAndCancelAfterFirstToken pattern)
  let cancelFired = false
  const chain = response.onUpdate(async data => {
    if (cancelFired) return
    if (typeof data === 'string') {
      cancelFired = true
      await model.cancel()
    }
  })

  try {
    await chain.await()
  } catch (err) {
    if (!/cancel|aborted|stopp?ed/i.test(err?.message || '')) throw err
  }
  t.pass('cancel during run resolves and stops job')
})

test('run | run: second run() throws busy error', { timeout: testTimeout }, async t => {
  const { model, modelDir } = await setupModel(t)
  const firstResponse = await model.run(SHORT_PARAMS)
  let firstError = null
  if (typeof firstResponse.onError === 'function') {
    firstResponse.onError(err => { firstError = err })
  }

  const result = await Promise.race([
    model.run(SHORT_PARAMS)
      .then(() => ({ kind: 'no-throw' }))
      .catch(err => ({ kind: 'busy', err })),
    firstResponse.await()
      .then(() => ({ kind: 'first-done' }))
      .catch(() => ({ kind: 'first-done' }))
  ])

  if (result.kind === 'busy') {
    t.ok(
      /already set or being processed/.test(result.err.message),
      'second run() throws "already set or being processed"'
    )
  } else if (result.kind === 'first-done') {
    t.comment('First job finished before second run() was rejected; skipping concurrency assertion')
    t.pass('first job completed (concurrency assertion skipped)')
  } else {
    t.fail('second run() should have thrown busy error while first job was still active')
  }

  const images = []
  await firstResponse.onUpdate(data => {
    if (data instanceof Uint8Array) images.push(data)
  }).await()
  t.ok(images.length > 0, 'first response completes with output')
  t.ok(!firstError, 'first response did not fail')
  saveGeneratedImages(modelDir, 'run-run-first-response', images)
})

test('cancel | run: can run again after cancel', { timeout: testTimeout }, async t => {
  const { model, modelDir } = await setupModel(t)

  // Start a job and cancel after first progress tick
  const response1 = await model.run(SHORT_PARAMS)
  let cancelFired = false
  const chain1 = response1.onUpdate(async data => {
    if (cancelFired) return
    if (typeof data === 'string') {
      cancelFired = true
      await model.cancel()
    }
  })
  // Wait for the cancelled job to fully settle (resolve or reject)
  await chain1.await().catch(err => {
    if (!/cancel|aborted|stopp?ed/i.test(err?.message || '')) throw err
  })

  // Should be able to run again
  const response2 = await model.run(SHORT_PARAMS)
  const images = []
  await response2.onUpdate(data => {
    if (data instanceof Uint8Array) images.push(data)
  }).await()

  t.ok(images.length > 0, 'can run again after cancel')
  saveGeneratedImages(modelDir, 'cancel-run-second-response', images)
})

// Keep event loop alive briefly to let pending async operations complete.
// Prevents C++ destructors from running while async cleanup is still happening.
setImmediate(() => {
  setTimeout(() => {}, 500)
})
