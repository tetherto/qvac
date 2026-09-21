'use strict'

// Regression test for unload() vs throwing user listeners.
//
// QvacResponse.failed() emits 'error' synchronously BEFORE settling its
// finish promise, so a user onError listener that throws unwinds out of
// unload()'s sink-settlement loop. Unfixed, that aborts unload before the
// remaining sinks are failed, before the native addon.unload(), and before
// the state reset — stranding other callers and leaking the native instance.
// unload() must isolate each sink settlement and always run native cleanup.
//
// In-flight state is set up through a deterministic seam: unload() settles
// whatever is registered in _jobSinks at the moment its loop runs, and real
// jobs settle racily (the pause() cancel inside unload can end them before
// the loop, emptying the map). So the test registers two live QvacResponse
// sinks directly — exactly the objects _runInternal stores — guaranteeing
// the loop hits an unsettled response whose listener throws.

const path = require('bare-path')
const os = require('bare-os')
const LlmLlamacpp = require('../../index.js')
// Through the package, not require('@qvac/infer-base'): the mobile test
// bundle resolves a direct infer-base require to a module without the class
// ("QvacResponse is not a constructor"), while the package's own import works
// on-device — and it keeps class identity aligned with the model's sinks.
const { QvacResponse } = LlmLlamacpp
const { ensureModel, safeTest } = require('./utils')

const isDarwinX64 = os.platform() === 'darwin' && os.arch() === 'x64'
const isLinuxArm64 = os.platform() === 'linux' && os.arch() === 'arm64'
const useCpu = isDarwinX64 || isLinuxArm64

// Smallest model with fast load, same as api-behavior.test.js
const MODEL = {
  name: 'Qwen3-0.6B-Q8_0.gguf',
  url: 'https://huggingface.co/unsloth/Qwen3-0.6B-GGUF/resolve/main/Qwen3-0.6B-Q8_0.gguf'
}

const BASE_PROMPT = [
  { role: 'system', content: 'You are a helpful assistant.' },
  { role: 'user', content: 'Say hello in one word.' }
]

safeTest(
  'run | unload: a throwing onError listener must not abort unload cleanup',
  { timeout: 600_000 },
  async (t) => {
    const [modelName, dirPath] = await ensureModel({
      modelName: MODEL.name,
      downloadUrl: MODEL.url
    })
    const modelPath = path.join(dirPath, modelName)

    const model = new LlmLlamacpp({
      files: { model: [modelPath] },
      config: {
        device: useCpu ? 'cpu' : 'gpu',
        gpu_layers: '999',
        ctx_size: '1024',
        n_predict: '32',
        verbosity: '2'
      },
      logger: console,
      opts: { stats: true }
    })
    await model.load()
    t.teardown(async () => {
      await model.unload().catch(() => {})
    })

    // Two live (unsettled) responses: the first carries the throwing listener,
    // the second proves the settlement loop keeps going past the throw.
    const first = new QvacResponse({ cancelHandler: () => {} })
    const second = new QvacResponse({ cancelHandler: () => {} })
    model._jobSinks.set(1000001, first)
    model._jobSinks.set(1000002, second)

    // Throw only once: the first 'error' emit is unload()'s own sink loop.
    // Later emits (e.g. the teardown's retried unload) must settle instead of
    // throwing again, so a red run still exits cleanly.
    let listenerCalls = 0
    first.onError(() => {
      listenerCalls++
      if (listenerCalls === 1) throw new Error('listener boom')
    })
    second.onError(() => {})
    first.await().catch(() => {})
    const secondSettled = second.await().then(
      () => 'resolved',
      (err) => err
    )

    let unloadError = null
    try {
      await model.unload()
    } catch (err) {
      unloadError = err
    }
    t.absent(unloadError, 'unload() resolves even when a response error listener throws')
    t.is(listenerCalls, 1, 'the throwing onError listener was invoked by the unload sink loop')
    t.is(model.addon, null, 'unload releases and nulls the native addon despite the throw')
    t.is(model.getState().configLoaded, false, 'unload resets configLoaded despite the throw')
    t.is(model._jobSinks.size, 0, 'unload drops every job sink despite the throw')

    // The remaining sink must be failed by unload itself, not left pending.
    const secondOutcome = await Promise.race([
      secondSettled,
      new Promise((resolve) => setTimeout(() => resolve('pending'), 5_000))
    ])
    const secondMessage =
      secondOutcome instanceof Error ? secondOutcome.message : String(secondOutcome)
    t.ok(
      secondOutcome instanceof Error && /Model was unloaded/.test(secondOutcome.message),
      `second response rejects with "Model was unloaded" (got: ${secondMessage})`
    )

    // Native cleanup ran: a fresh load() must rebuild the addon and generate.
    await model.load()
    const reuse = await model.run(BASE_PROMPT)
    const chunks = []
    await reuse.onUpdate((chunk) => chunks.push(chunk)).await()
    t.ok(chunks.join('').trim().length > 0, 'model generates again after unload + reload')
  }
)
