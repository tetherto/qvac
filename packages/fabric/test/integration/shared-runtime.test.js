'use strict'

// Integration tests for @qvac/fabric.
//
// These exercise *real* inference through the two migrated consumers
// (@qvac/llm-llamacpp and @qvac/embed-llamacpp). Because both addons declare
// @qvac/fabric as their npm dependency and dynamically link the shared
// qvac__fabric@0.bare, running them in a single Bare process proves that the
// shared runtime resolves, loads once, and serves both consumers.

const test = require('brittle')
const os = require('bare-os')
const fs = require('bare-fs')
const { ensureModel } = require('./download')

const LlmLlamacpp = require('@qvac/llm-llamacpp')
const GGMLBert = require('@qvac/embed-llamacpp')

const platform = os.platform()
const arch = os.arch()
// darwin-x64 and linux-arm64 lack a usable GPU backend in CI; force CPU there.
const useCpu = (platform === 'darwin' && arch === 'x64') || (platform === 'linux' && arch === 'arm64')
const device = useCpu ? 'cpu' : 'gpu'

// The LLM tests can't run on darwin-x64 (no GPU backend, and CPU completion is
// too slow for CI), so they're skipped there — and we must not prefetch that
// ~770MB model when it will never be used.
const llmSkip = useCpu && platform === 'darwin'

const TIMEOUT = 15 * 60 * 1000

const LLM_MODEL = {
  name: 'Llama-3.2-1B-Instruct-Q4_0.gguf',
  url: 'https://huggingface.co/bartowski/Llama-3.2-1B-Instruct-GGUF/resolve/main/Llama-3.2-1B-Instruct-Q4_0.gguf'
}

const EMBED_MODEL = {
  name: 'embeddinggemma-300M-Q8_0.gguf',
  url: 'https://huggingface.co/unsloth/embeddinggemma-300m-GGUF/resolve/main/embeddinggemma-300M-Q8_0.gguf',
  dimension: 768
}

// brittle runs tests serially, so calling ensureModel() inside each test body
// downloads the models back-to-back (~955MB serialized on a cold worker).
// Memoize per model and kick the needed downloads off in parallel up front so
// the cold-cache path overlaps both transfers; warm caches are unaffected.
const modelDownloads = new Map()
function ensureModelOnce (model) {
  if (!modelDownloads.has(model)) modelDownloads.set(model, ensureModel(model))
  return modelDownloads.get(model)
}

const prefetchModels = [EMBED_MODEL]
if (!llmSkip) prefetchModels.unshift(LLM_MODEL)
// Start the transfers now; tests await the memoized per-model promises below.
// Attach a noop catch so an early failure isn't flagged as an unhandled
// rejection before a test gets a chance to await (and surface) it.
Promise.all(prefetchModels.map(ensureModelOnce)).catch(() => {})

const PROMPT = [
  { role: 'system', content: 'You are a helpful, respectful and honest assistant.' },
  { role: 'user', content: 'Say hello in one short sentence.' }
]

async function collectCompletion (response) {
  const chunks = []
  await response
    .onUpdate(data => { chunks.push(data) })
    .await()
  return chunks.join('').trim()
}

async function runCompletion (modelPath) {
  const addon = new LlmLlamacpp({
    files: { model: [modelPath] },
    config: { gpu_layers: '999', ctx_size: '1024', device, n_predict: '32', verbosity: '2' },
    logger: console,
    opts: { stats: true }
  })
  await addon.load()
  try {
    const output = await collectCompletion(await addon.run(PROMPT))
    return { addon, output }
  } catch (err) {
    await addon.unload().catch(() => {})
    throw err
  }
}

async function runEmbedding (modelPath) {
  const addon = new GGMLBert({
    files: { model: [modelPath] },
    config: { gpu_layers: useCpu ? '0' : '999', batch_size: '1024', device },
    logger: console,
    opts: { stats: true }
  })
  await addon.load()
  try {
    const response = await addon.run('That is a happy person')
    const embeddings = await response._finishPromise
    return { addon, embeddings }
  } catch (err) {
    await addon.unload().catch(() => {})
    throw err
  }
}

// On Linux we can inspect the process' memory map to confirm the shared
// runtime is mapped exactly once across both consumers.
function fabricMappings () {
  if (platform !== 'linux') return null
  const maps = fs.readFileSync('/proc/self/maps', 'utf8')
  const found = new Set()
  for (const line of maps.split('\n')) {
    const idx = line.indexOf('/')
    if (idx === -1) continue
    const file = line.slice(idx).trim()
    // The shared runtime is loaded from qvac__fabric.bare on disk; its SONAME
    // is qvac__fabric@0.bare, so accept either spelling. dlopen dedups by
    // SONAME, so a correctly shared runtime appears as a single mapped file.
    if (/\/qvac__fabric(@\d+)?\.bare$/.test(file)) found.add(file)
  }
  return found
}

test('llm-llamacpp runs inference through @qvac/fabric', { timeout: TIMEOUT, skip: llmSkip }, async t => {
  const modelPath = await ensureModelOnce(LLM_MODEL)
  const { addon, output } = await runCompletion(modelPath)
  try {
    t.ok(output.length > 0, 'completion produced non-empty output')
  } finally {
    await addon.unload().catch(() => {})
  }
})

test('embed-llamacpp runs inference through @qvac/fabric', { timeout: TIMEOUT }, async t => {
  const modelPath = await ensureModelOnce(EMBED_MODEL)
  const { addon, embeddings } = await runEmbedding(modelPath)
  try {
    t.is(embeddings[0][0].length, EMBED_MODEL.dimension, 'embedding has the expected dimension')
  } finally {
    await addon.unload().catch(() => {})
  }
})

test('llm + embed share a single @qvac/fabric runtime in one process', { timeout: TIMEOUT, skip: llmSkip }, async t => {
  const [llmModelPath, embedModelPath] = await Promise.all([
    ensureModelOnce(LLM_MODEL),
    ensureModelOnce(EMBED_MODEL)
  ])

  const llm = await runCompletion(llmModelPath)
  t.ok(llm.output.length > 0, 'llm completion ran')
  // Free the LLM weights before loading the embedder to keep memory bounded,
  // but keep the process alive so the shared .bare stays mapped.
  await llm.addon.unload().catch(() => {})

  const embed = await runEmbedding(embedModelPath)
  t.is(embed.embeddings[0][0].length, EMBED_MODEL.dimension, 'embed inference ran')
  await embed.addon.unload().catch(() => {})

  const mappings = fabricMappings()
  if (mappings === null) {
    t.comment('Skipping memory-map assertion on non-Linux platform')
  } else {
    t.is(mappings.size, 1, `exactly one qvac__fabric@0.bare is mapped (found: ${[...mappings].join(', ') || 'none'})`)
  }
})

// Keep the event loop alive briefly so pending async cleanup finishes before
// native destructors run (mirrors the consumer integration suites).
setImmediate(() => {
  setTimeout(() => {}, 500)
})
