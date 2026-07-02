'use strict'

// Tests must match the behavior described in README section "API behavior by state".

const path = require('bare-path')
const LlmLlamacpp = require('../../index.js')
const { ensureModel, safeTest } = require('./utils')
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

  const modelPath = path.join(dirPath, modelName)
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
    files: { model: [modelPath] },
    config,
    logger: console,
    opts: { stats: true }
  })

  await model.load()

  t.teardown(async () => {
    await model.unload().catch(() => {})
    specLogger.release()
  })

  return { model }
}

async function collectResponse (response) {
  const chunks = []
  await response.onUpdate(data => { chunks.push(data) }).await()
  return chunks.join('').trim()
}

const toNumber = value => typeof value === 'number' ? value : Number(value || 0)

safeTest('idle | run: allowed, returns QvacResponse', { timeout: 600_000 }, async t => {
  const { model } = await setupModel(t)
  const response = await model.run(BASE_PROMPT)
  t.ok(response, 'run() returns a response')
  t.ok(typeof response.onUpdate === 'function', 'response has onUpdate')
  t.ok(typeof response.await === 'function', 'response has await')
  const output = await collectResponse(response)
  t.ok(output.length > 0, 'inference produces output')
  t.ok(
    response?.stats?.backendDevice === 'cpu' || response?.stats?.backendDevice === 'gpu',
    'runtime stats report resolved backendDevice as cpu or gpu'
  )
})

safeTest('idle | run batch: returns ids, keyed chunks, ordered results', { timeout: 600_000 }, async t => {
  const { model } = await setupModel(t, {
    parallel: '2', // 3 prompts but 2 in parallel at a time
    n_predict: '16'
  })
  const batchPrompts = [
    {
      prompt: [
        { role: 'system', content: 'You answer with one short word.' },
        { role: 'user', content: 'Say red.' }
      ],
      runOptions: { generationParams: { predict: 8 } }
    },
    {
      id: 'explicit-blue',
      prompt: [
        { role: 'system', content: 'You answer with one short word.' },
        { role: 'user', content: 'Say blue.' }
      ]
    },
    [
      { role: 'system', content: 'You answer with one short word.' },
      { role: 'user', content: 'Say green.' }
    ]
  ]

  await t.exception.all(
    () => model.run(batchPrompts, { generationParams: { predict: 8 } }),
    /Batch run options must be set per BatchPrompt item/,
    'batch run rejects separate runOptions'
  )

  const response = await model.run(batchPrompts)
  t.ok(Array.isArray(response.ids), 'batch response exposes generated ids')
  t.is(response.ids.length, 3, 'one id per prompt')
  t.ok(response.ids.includes('explicit-blue'), 'explicit id is preserved')
  t.is(new Set(response.ids).size, 3, 'generated ids are unique')

  const chunksById = {}
  response.onUpdate(({ id, chunk }) => {
    chunksById[id] = (chunksById[id] || '') + chunk
  })
  const results = await response.await()
  for (const result of results) {
    t.comment(`${result.id}: ${result.output.trim()}`)
  }
  t.comment(`avgConcurrentSeq: ${toNumber(response?.stats?.avgConcurrentSeq)}`)

  t.alike(results.map(result => result.id), response.ids, 'results preserve generated id order')
  t.ok(results.every(result => typeof result.output === 'string'), 'each result has output text')
  t.ok(
    Object.keys(chunksById).every(id => response.ids.includes(id)),
    'streamed chunks are keyed by generated ids'
  )
  t.ok(toNumber(response?.stats?.avgConcurrentSeq) > 1.1, 'batch stats report concurrent sequence decoding')
})

safeTest('idle | run batch: provided falsy runOptions are rejected, not silently defaulted', { timeout: 600_000 }, async t => {
  // Every provided-but-invalid runOptions must throw the same TypeError as the
  // single-prompt path, instead of being coerced to {} and bypassing
  // validation. Only undefined (property absent) is allowed to default, and
  // that path is already exercised by the batch tests above.
  const { model } = await setupModel(t, { parallel: '2' })
  const prompt = [{ role: 'user', content: 'Say red.' }]

  const invalidCases = [
    { label: 'null', value: null },
    { label: 'false', value: false },
    { label: '0', value: 0 },
    { label: 'empty string', value: '' },
    { label: 'NaN', value: NaN },
    { label: 'array', value: [] }
  ]

  for (const { label, value } of invalidCases) {
    await t.exception.all(
      () => model.run([{ prompt, runOptions: value }]),
      /Run options must be an object when provided/,
      `batch item with runOptions: ${label} rejects`
    )
  }
})

safeTest('idle | run batch without parallel >= 2: rejects before admission', { timeout: 600_000 }, async t => {
  // Default load (parallel = 1) leaves continuous batching inactive, so batch
  // input must be rejected up front rather than reaching the worker thread.
  const { model } = await setupModel(t)
  const batchPrompts = [
    [{ role: 'user', content: 'Say red.' }],
    [{ role: 'user', content: 'Say blue.' }]
  ]

  await t.exception.all(
    () => model.run(batchPrompts),
    /parallel >= 2/,
    'batch run rejects when the model was not loaded with parallel >= 2'
  )
})

safeTest('idle | run with prefill: evaluates prompt without token generation', { timeout: 600_000 }, async t => {
  const { model } = await setupModel(t)

  const prefillResponse = await model.run(BASE_PROMPT, { prefill: true })
  const prefillOutput = await collectResponse(prefillResponse)

  t.is(prefillOutput, '', 'prefill emits no generated output')
  t.is(
    toNumber(prefillResponse?.stats?.generatedTokens),
    0,
    'prefill reports zero generated tokens'
  )
  t.is(
    toNumber(prefillResponse?.stats?.promptTokens),
    0,
    'prefill reports zero prompt tokens'
  )
  t.ok(
    toNumber(prefillResponse?.stats?.CacheTokens) > 0,
    'prefill stores prompt in model context'
  )
  t.ok(
    toNumber(prefillResponse?.stats?.ppTPS) > 0,
    'prefill reports prompt processing throughput'
  )

  const normalResponse = await model.run(BASE_PROMPT)
  const normalOutput = await collectResponse(normalResponse)
  t.ok(normalOutput.length > 0, 'normal run still generates output after prefill')
})

safeTest('idle | cancel: allowed, no-op', { timeout: 600_000 }, async t => {
  const { model } = await setupModel(t)
  await model.cancel()
  t.pass('cancel when idle does not throw')
})

safeTest('run | cancel: allowed, cancels current job', { timeout: 600_000 }, async t => {
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

safeTest('run | run: second run() throws busy error', { timeout: 600_000 }, async t => {
  const { model } = await setupModel(t, { n_predict: '256' })
  const firstResponse = await model.run(LONG_PROMPT)
  let firstError = null
  if (typeof firstResponse.onError === 'function') {
    firstResponse.onError(err => { firstError = err })
  }

  const result = await Promise.race([
    model.run(BASE_PROMPT)
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

  // First response still completes normally
  const output = await collectResponse(firstResponse)
  t.ok(output.length > 0, 'first response completes with output')
  t.ok(!firstError, 'first response did not fail')
})

// Resource-release coverage (QVAC-18929): teardown while a job is in flight,
// and use-after-unload. AddonJs.hpp documents a use-after-free risk on these
// paths. Assertions are non-empty / type / clean-error only.

// unload() mid-inference must not crash, and the model must be reusable after.
safeTest('run | unload: unload during active inference does not crash, model reusable', { timeout: 600_000 }, async t => {
  const { model } = await setupModel(t, { n_predict: '256' })

  const response = await model.run(LONG_PROMPT)
  // Drain in the background so the interrupted job's rejection doesn't abort
  // the process; we only care that unload is safe while a job is live.
  response.onError(() => {})
  response.await().catch(() => {})

  await model.unload()
  t.pass('unload() during active inference completed without crashing')

  await model.load()
  const reuse = await model.run(BASE_PROMPT)
  const output = await collectResponse(reuse)
  t.ok(output.length > 0, 'model still generates after unload-during-inference + reload')
})

// run() after unload() must throw/reject cleanly, not segfault.
safeTest('unloaded | run: run after unload throws a clean error', { timeout: 600_000 }, async t => {
  const { model } = await setupModel(t)

  const first = await model.run(BASE_PROMPT)
  await collectResponse(first)
  await model.unload()

  try {
    const resp = await model.run(BASE_PROMPT)
    // Throwing on run() or failing the response both count, as long as it
    // doesn't crash.
    await collectResponse(resp)
    t.fail('expected run() after unload to throw or reject')
  } catch (err) {
    t.ok(err instanceof Error, 'run() after unload threw a valid Error (not an undefined rejection)')
    t.comment('Error message: ' + (err && err.message))
    t.pass('unloaded model rejects run() without crashing')
  }
})

// cancel() resolves async while the native job is still unwinding; an immediate
// unload() must not race into a use-after-free.
safeTest('run | cancel | unload: cancel then immediate unload does not crash', { timeout: 600_000 }, async t => {
  const { model } = await setupModel(t, { n_predict: '256' })

  const response = await model.run(LONG_PROMPT)
  response.onError(() => {})
  response.await().catch(() => {})

  model.cancel().catch(() => {})
  await model.unload()

  t.pass('cancel() then immediate unload() did not crash')
})
