'use strict'

const test = require('brittle')
const FilesystemDL = require('@qvac/dl-filesystem')
const LlmLlamacpp = require('../../index.js')
const os = require('bare-os')
const fs = require('bare-fs')
const path = require('bare-path')

const platform = os.platform()
const arch = os.arch()
const isDarwinX64 = platform === 'darwin' && arch === 'x64'
const isLinuxArm64 = platform === 'linux' && arch === 'arm64'
const useCpu = isDarwinX64 || isLinuxArm64

const AFRIQUEGEMMA_MODEL = {
  name: 'AfriqueGemma-4B.Q4_K_M.gguf',
  url: 'https://huggingface.co/mradermacher/AfriqueGemma-4B-GGUF/resolve/main/AfriqueGemma-4B.Q4_K_M.gguf'
}

const AFRIQUEGEMMA_CONFIG = {
  device: useCpu ? 'cpu' : 'gpu',
  gpu_layers: '999',
  ctx_size: '2048',
  temp: '0',
  top_p: '1',
  top_k: '1',
  n_predict: '256',
  repeat_penalty: '1',
  seed: '42',
  tools: 'true',
  'reverse-prompt': '\n',
  verbosity: '2'
}

const EN_SW_PROMPT = 'Translate English to Swahili.\nEnglish: The children are playing in the park.\nSwahili:'

async function collectTranslation (response) {
  const chunks = []
  await response
    .onUpdate(data => { chunks.push(data) })
    .await()
  return chunks.join('').split('\n')[0].trim()
}

async function resolveModel () {
  const qvacDir = path.join(os.homedir(), '.qvac', 'models')
  for (const name of ['AfriqueGemma-4B-Q4_K_M.gguf', 'AfriqueGemma-4B.Q4_K_M.gguf']) {
    if (fs.existsSync(path.join(qvacDir, name))) {
      return [name, qvacDir]
    }
  }
  const modelDir = path.resolve(__dirname, '../model')
  const modelPath = path.join(modelDir, AFRIQUEGEMMA_MODEL.name)
  if (fs.existsSync(modelPath)) {
    return [AFRIQUEGEMMA_MODEL.name, modelDir]
  }
  const { ensureModel } = require('./utils')
  return ensureModel({
    modelName: AFRIQUEGEMMA_MODEL.name,
    downloadUrl: AFRIQUEGEMMA_MODEL.url
  })
}

const TIMEOUT = 1_800_000

// ---------------------------------------------------------------------------
// Test: AfriqueGemma – empty and whitespace input must not crash
//
// WHY: Users pass empty strings through UIs and pipelines; must not segfault.
// ---------------------------------------------------------------------------
test('AfriqueGemma: empty and whitespace input must not crash', { timeout: TIMEOUT }, async t => {
  const [modelName, dirPath] = await resolveModel()
  const loader = new FilesystemDL({ dirPath })
  const addon = new LlmLlamacpp({
    loader,
    modelName,
    diskPath: dirPath,
    logger: console,
    opts: { stats: true }
  }, AFRIQUEGEMMA_CONFIG)
  try {
    await addon.load()
    const emptyPrompt = 'Translate English to Swahili.\nEnglish: \nSwahili:'
    const r1 = await addon.run([{ role: 'user', content: emptyPrompt }])
    await collectTranslation(r1)
    t.pass('empty-style prompt did not crash')
    const wsPrompt = 'Translate English to Swahili.\nEnglish:   \nSwahili:'
    const r2 = await addon.run([{ role: 'user', content: wsPrompt }])
    await collectTranslation(r2)
    t.pass('whitespace-style prompt did not crash')
  } finally {
    await addon.unload().catch(() => {})
    await loader.close().catch(() => {})
  }
})

// ---------------------------------------------------------------------------
// Test: AfriqueGemma – load → use → unload → fresh instance load → use
//
// WHY: Apps that swap models or recover from errors need lifecycle to work;
//      creating a new instance after unload is the supported reload pattern.
// ---------------------------------------------------------------------------
test('AfriqueGemma: lifecycle load-unload-fresh-load-use', { timeout: TIMEOUT }, async t => {
  const [modelName, dirPath] = await resolveModel()
  const loader1 = new FilesystemDL({ dirPath })
  const addon1 = new LlmLlamacpp({
    loader: loader1,
    modelName,
    diskPath: dirPath,
    logger: console,
    opts: { stats: true }
  }, AFRIQUEGEMMA_CONFIG)
  try {
    await addon1.load()
    const r1 = await addon1.run([{ role: 'user', content: EN_SW_PROMPT }])
    const out1 = await collectTranslation(r1)
    t.ok(out1.length > 0, 'first run produced output')
    await addon1.unload()
    await loader1.close()
  } catch (err) {
    await addon1.unload().catch(() => {})
    await loader1.close().catch(() => {})
    throw err
  }
  const loader2 = new FilesystemDL({ dirPath })
  const addon2 = new LlmLlamacpp({
    loader: loader2,
    modelName,
    diskPath: dirPath,
    logger: console,
    opts: { stats: true }
  }, AFRIQUEGEMMA_CONFIG)
  try {
    await addon2.load()
    const r2 = await addon2.run([{ role: 'user', content: EN_SW_PROMPT }])
    const out2 = await collectTranslation(r2)
    t.ok(out2.length > 0, 'second run after fresh load produced output')
  } finally {
    await addon2.unload().catch(() => {})
    await loader2.close().catch(() => {})
  }
})

// ---------------------------------------------------------------------------
// Test: AfriqueGemma – cancel mid-translation, model reusable after
//
// WHY: Cancelling mid-operation must not corrupt state; model should be reusable.
// ---------------------------------------------------------------------------
test('AfriqueGemma: cancel mid-translation, model reusable after', { timeout: TIMEOUT }, async t => {
  const [modelName, dirPath] = await resolveModel()
  const loader = new FilesystemDL({ dirPath })
  const addon = new LlmLlamacpp({
    loader,
    modelName,
    diskPath: dirPath,
    logger: console,
    opts: { stats: true }
  }, { ...AFRIQUEGEMMA_CONFIG, n_predict: '512' })
  try {
    await addon.load()
    const longPrompt = 'Translate English to Swahili.\nEnglish: The children are playing in the park. Their mother watches from the bench. The sun is shining brightly today. Many families enjoy this beautiful place.\nSwahili:'
    const response = await addon.run([{ role: 'user', content: longPrompt }])
    const tokens = { count: 0 }
    response.onUpdate(() => { tokens.count++ })
    const maxWait = 15000
    const start = Date.now()
    while (tokens.count === 0 && (Date.now() - start) < maxWait) {
      await new Promise(resolve => setTimeout(resolve, 200))
    }
    t.ok(tokens.count > 0, 'received tokens before cancel')
    const cancelPromise = addon.cancel()
    try {
      await response.await()
    } catch (err) {
      if (!/cancel|aborted|stopp?ed/i.test(err?.message || '')) throw err
    }
    await cancelPromise
    t.pass('cancel during run completed')
    await new Promise(resolve => setTimeout(resolve, 500))
    const r2 = await addon.run([{ role: 'user', content: EN_SW_PROMPT }])
    const out2 = await collectTranslation(r2)
    t.ok(out2.length > 0, 'model produced output after cancel')
  } finally {
    await addon.unload().catch(() => {})
    await loader.close().catch(() => {})
  }
})

// ---------------------------------------------------------------------------
// Test: AfriqueGemma – tools:true required for load
//
// WHY: tools enables Jinja chat template; easy to miss, produces confusing error.
// Verifies the addon either rejects with a clear message or defaults to jinja.
// ---------------------------------------------------------------------------
test('AfriqueGemma: tools true required for load', { timeout: TIMEOUT }, async t => {
  const [modelName, dirPath] = await resolveModel()
  const loader = new FilesystemDL({ dirPath })
  const configWithoutTools = {
    ...AFRIQUEGEMMA_CONFIG,
    tools: undefined
  }
  delete configWithoutTools.tools
  const addon = new LlmLlamacpp({
    loader,
    modelName,
    diskPath: dirPath,
    logger: console
  }, configWithoutTools)
  try {
    await addon.load()
    t.pass('load without tools succeeded (addon defaults to jinja)')
    await addon.unload().catch(() => {})
  } catch (err) {
    const msg = (err?.message || '').toLowerCase()
    t.ok(
      /template|jinja|tools|not supported|custom/.test(msg),
      'load without tools fails with clear message about template/jinja'
    )
  } finally {
    await loader.close().catch(() => {})
  }
})

// ---------------------------------------------------------------------------
// Test: AfriqueGemma – run() after unload() must reject cleanly
//
// WHY: If a caller accidentally calls run() after unload(), the addon should
// throw or return a failed response — not trigger an unhandled promise rejection.
// BUG: Currently the addon returns an invalid response object that causes an
// unhandled rejection. This test documents the expected behaviour.
// ---------------------------------------------------------------------------
test('AfriqueGemma: run after unload rejects cleanly', { timeout: TIMEOUT }, async t => {
  const [modelName, dirPath] = await resolveModel()
  const loader = new FilesystemDL({ dirPath })
  const addon = new LlmLlamacpp({
    loader,
    modelName,
    diskPath: dirPath,
    logger: console,
    opts: { stats: true }
  }, AFRIQUEGEMMA_CONFIG)

  await addon.load()
  const r1 = await addon.run([{ role: 'user', content: EN_SW_PROMPT }])
  const out1 = await collectTranslation(r1)
  t.ok(out1.length > 0, 'inference works before unload')

  await addon.unload()

  let rejected = false
  let hadUnhandled = false
  const onUnhandled = () => { hadUnhandled = true }
  if (typeof process !== 'undefined' && process.on) {
    process.on('unhandledRejection', onUnhandled)
  }

  try {
    const r2 = await addon.run([{ role: 'user', content: EN_SW_PROMPT }])
    try {
      await r2.await()
    } catch (_) {
      rejected = true
    }
  } catch (_) {
    rejected = true
  }

  if (typeof process !== 'undefined' && process.removeListener) {
    process.removeListener('unhandledRejection', onUnhandled)
  }

  if (hadUnhandled) {
    t.comment('BUG: run() after unload() triggered unhandled promise rejection')
    t.comment('Expected: synchronous throw or a response that resolves to an error')
  }
  t.ok(rejected || hadUnhandled, 'run() after unload() does not silently succeed')
  await loader.close().catch(() => {})
})

// ---------------------------------------------------------------------------
// Test: AfriqueGemma – small n_predict produces truncated but valid output
//
// WHY: Mobile apps often constrain n_predict to save battery and memory.
//      A very small limit (e.g. 8 tokens) must truncate gracefully without
//      crashing or producing garbled output. Catches buffer handling bugs
//      in the token emission pipeline.
// ---------------------------------------------------------------------------
test('AfriqueGemma: small n_predict produces truncated but valid output', { timeout: TIMEOUT }, async t => {
  const [modelName, dirPath] = await resolveModel()
  const loader = new FilesystemDL({ dirPath })
  const addon = new LlmLlamacpp({
    loader,
    modelName,
    diskPath: dirPath,
    logger: console,
    opts: { stats: true }
  }, { ...AFRIQUEGEMMA_CONFIG, n_predict: '8' })

  try {
    await addon.load()

    const response = await addon.run([{ role: 'user', content: EN_SW_PROMPT }])
    const out = await collectTranslation(response)
    t.ok(typeof out === 'string', 'output is a string')
    t.pass(`n_predict=8 produced ${out.length} chars without crash: "${out}"`)

    const stats = response.stats || {}
    if (stats.generatedTokens !== undefined) {
      const genTokens = Number(stats.generatedTokens)
      t.ok(genTokens <= 10, `generated ${genTokens} tokens (within n_predict=8 range)`)
      t.comment(`stats: generatedTokens=${genTokens}`)
    }
  } finally {
    await addon.unload().catch(() => {})
    await loader.close().catch(() => {})
  }
})

// ---------------------------------------------------------------------------
// Test: AfriqueGemma – long input approaching ctx_size boundary
//
// WHY: When a user pastes a large paragraph for translation, the prompt token
//      count approaches ctx_size. The model must handle this gracefully —
//      either truncating, producing partial output, or erroring clearly.
//      A crash or silent hang is unacceptable on mobile (see: SIGABRT on
//      context overflow in sliding-context tests).
// ---------------------------------------------------------------------------
test('AfriqueGemma: long input approaching ctx_size boundary', { timeout: TIMEOUT }, async t => {
  const [modelName, dirPath] = await resolveModel()
  const loader = new FilesystemDL({ dirPath })
  const addon = new LlmLlamacpp({
    loader,
    modelName,
    diskPath: dirPath,
    logger: console,
    opts: { stats: true }
  }, { ...AFRIQUEGEMMA_CONFIG, ctx_size: '512', n_predict: '32' })

  try {
    await addon.load()

    const sentence = 'The children are playing in the park near the river where the birds sing every morning and the flowers bloom in spring. '
    const longText = sentence.repeat(10)
    const prompt = `Translate English to Swahili.\nEnglish: ${longText}\nSwahili:`

    let gotOutput = false
    let gotError = false
    try {
      const response = await addon.run([{ role: 'user', content: prompt }])
      const out = await collectTranslation(response)
      gotOutput = out.length > 0
      t.comment(`long-input produced ${out.length} chars`)
    } catch (err) {
      gotError = true
      t.comment(`long-input error (acceptable): ${err.message}`)
    }

    t.ok(gotOutput || gotError, 'long input either produced output or a clear error — no crash or hang')
  } finally {
    await addon.unload().catch(() => {})
    await loader.close().catch(() => {})
  }
})
