'use strict'

// Tests must match the behavior described in README section "API behavior by state".

const test = require('brittle')
const FilesystemDL = require('@qvac/dl-filesystem')
const LlmLlamacpp = require('../../index.js')
const { ensureModel } = require('./utils')
const { attachSpecLogger } = require('./spec-logger')
const os = require('bare-os')

const isDarwinX64 = os.platform() === 'darwin' && os.arch() === 'x64'
const isLinuxArm64 = os.platform() === 'linux' && os.arch() === 'arm64'
const useCpu = isDarwinX64 || isLinuxArm64

// Smallest model for fast run/cancel behavior tests
const MODEL = {
  name: 'Qwen3-0.6B-Q8_0.gguf',
  url: 'https://huggingface.co/unsloth/Qwen3-0.6B-GGUF/resolve/main/Qwen3-0.6B-Q8_0.gguf'
}

const BASE_PROMPT = [
  { role: 'system', content: 'You are a helpful assistant.' },
  { role: 'user', content: 'Say hello in one word.' }
]

const LONG_PROMPT = [
  { role: 'system', content: 'You are a helpful assistant.' },
  { role: 'user', content: 'Tell me a long story about a dragon.' }
]

async function setupModel (t, configOverrides = {}) {
  const [modelName, dirPath] = await ensureModel({
    modelName: MODEL.name,
    downloadUrl: MODEL.url
  })

  const loader = new FilesystemDL({ dirPath })
  const config = {
    device: useCpu ? 'cpu' : 'gpu',
    gpu_layers: '999',
    ctx_size: '1024',
    n_predict: '32',
    verbosity: '2',
    ...configOverrides
  }

  const specLogger = attachSpecLogger({ forwardToConsole: true })
  const model = new LlmLlamacpp({
    loader,
    modelName,
    diskPath: dirPath,
    logger: console,
    opts: { stats: true }
  }, config)

  await model.load()

  t.teardown(async () => {
    await model.unload().catch(() => {})
    await loader.close().catch(() => {})
    specLogger.release()
  })

  return { model }
}

async function collectResponse (response) {
  const chunks = []
  await response.onUpdate(data => { chunks.push(data) }).await()
  return chunks.join('').trim()
}

test('idle | run: allowed, returns QvacResponse', { timeout: 600_000 }, async t => {
  const { model } = await setupModel(t)
  const response = await model.run(BASE_PROMPT)
  t.ok(response, 'run() returns a response')
  t.ok(typeof response.onUpdate === 'function', 'response has onUpdate')
  t.ok(typeof response.await === 'function', 'response has await')
  const output = await collectResponse(response)
  t.ok(output.length > 0, 'inference produces output')
})

test('idle | cancel: allowed, no-op', { timeout: 600_000 }, async t => {
  const { model } = await setupModel(t)
  await model.cancel()
  t.pass('cancel when idle does not throw')
})

test('run | cancel: allowed, cancels current job', { timeout: 600_000 }, async t => {
  const { model } = await setupModel(t)
  const response = await model.run(LONG_PROMPT)
  const cancelPromise = model.cancel()
  try {
    await response.await()
  } catch (err) {
    if (!/cancel|aborted|stopp?ed/i.test(err?.message || '')) throw err
  }
  await cancelPromise
  t.pass('cancel during run resolves and stops job')
})

test('run | run: second run() throws busy error', { timeout: 600_000 }, async t => {
  const { model } = await setupModel(t, { n_predict: '256' })
  const firstResponse = await model.run(LONG_PROMPT)
  let firstError = null
  if (typeof firstResponse.onError === 'function') {
    firstResponse.onError(err => { firstError = err })
  }

  await t.exception(
    async () => { await model.run(BASE_PROMPT) },
    /already set or being processed/,
    'second run() throws "already set or being processed"'
  )

  // First response still completes normally
  const output = await collectResponse(firstResponse)
  t.ok(output.length > 0, 'first response completes with output')
  t.ok(!firstError, 'first response did not fail')
})
