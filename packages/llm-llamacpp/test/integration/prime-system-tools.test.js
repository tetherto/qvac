'use strict'

// A prefill of only a system prompt and tools, saved and reloaded, leaves the
// first question to prefill only its user turn. Qwen3.5's template renders no
// tools without a user turn (the placeholder-user render); Qwen3's renders them
// in the system turn (the plain render).
//
// The first test runs everywhere. The rest are desktop-only: they cover the
// prefill as the first request on an empty cache with parallel 1, 2 and 4, and
// prefills decoded while another request on the same model is still
// generating.

const fs = require('bare-fs')
const os = require('bare-os')
const path = require('bare-path')
const process = require('bare-process')
const LlmLlamacpp = require('../../index.js')
const { ensureModelPath, safeTest } = require('./utils')

const platform = os.platform()
const arch = os.arch()
const isMobile = platform === 'ios' || platform === 'android'
const isDarwinX64 = platform === 'darwin' && arch === 'x64'
const isLinuxArm64 = platform === 'linux' && arch === 'arm64'
const noGpu = String(os.getEnv?.('NO_GPU') || process.env.NO_GPU || '').toLowerCase() === 'true'
const useCpu = isDarwinX64 || isLinuxArm64 || noGpu
const desktopOnly = isMobile ? 'desktop-only: several model loads per test' : false

const QWEN35 = { modelName: 'Qwen3.5-0.8B-Q8_0.gguf' }
// prestage-ignore: Qwen3-0.6B-Q8_0.gguf — used only by the desktop concurrency tests
const QWEN3 = { modelName: 'Qwen3-0.6B-Q8_0.gguf' }
const MODELS = [
  { label: 'Qwen3.5', def: QWEN35 },
  { label: 'Qwen3', def: QWEN3 }
]

const CONFIG = {
  device: useCpu ? 'cpu' : 'gpu',
  gpu_layers: useCpu ? '0' : '999',
  ctx_size: '4096',
  n_predict: '8',
  temp: '0',
  seed: '7',
  tools: 'true',
  verbosity: '0'
}

const SYSTEM = { role: 'system', content: 'You are a weather assistant.' }
const TOOLS = [
  {
    type: 'function',
    name: 'getWeather',
    description: 'Get the current weather for a city',
    parameters: {
      type: 'object',
      properties: { city: { type: 'string' } },
      required: ['city']
    }
  }
]
const QUESTION = { role: 'user', content: 'What is the weather in Paris?' }
const PRIME = [SYSTEM, ...TOOLS]
const ASK = [SYSTEM, ...TOOLS, QUESTION]
const LONG = [
  { role: 'system', content: 'You are a storyteller.' },
  { role: 'user', content: 'Tell me a long story about a lighthouse keeper.' }
]

function scratchDir(t, name) {
  const dir = path.join(os.tmpdir(), `qvac-prime-${name}-${Date.now()}`)
  fs.mkdirSync(dir, { recursive: true })
  t.teardown(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch (_) {}
  })
  return dir
}

async function loadModel(t, modelPath, parallel = '1') {
  const model = new LlmLlamacpp({
    files: { model: [modelPath] },
    config: { ...CONFIG, parallel },
    logger: console,
    opts: { stats: true }
  })
  await model.load()
  let unloaded = false
  const unload = async () => {
    if (unloaded) return
    unloaded = true
    await model.unload().catch(() => {})
  }
  t.teardown(unload)
  return { model, unload }
}

async function run(model, messages, runOptions) {
  const response = await model.run(messages, runOptions)
  let output = ''
  await response
    .onUpdate((chunk) => {
      output += chunk
    })
    .await()
  const stats = response.stats || {}
  return {
    output,
    promptTokens: Number(stats.promptTokens || 0),
    cacheTokens: Number(stats.CacheTokens || 0),
    toolDefinitionsDropped: Number(stats.toolDefinitionsDropped || 0)
  }
}

// Starts a request and resolves once it has streamed its first piece, so a
// request issued afterwards is decoded while this one is still generating.
async function startGenerating(model, messages, runOptions) {
  const response = await model.run(messages, runOptions)
  let firstPiece
  const generating = new Promise((resolve) => {
    firstPiece = resolve
  })
  const done = response
    .onUpdate(() => firstPiece())
    .await()
    .then(() => Date.now())
  await Promise.race([
    generating,
    done.then(() => {
      throw new Error('The background request finished before streaming any output')
    })
  ])
  return { done }
}

// The prompt size of the question with nothing cached, and how many tokens a
// prefill of the system prompt and tools caches, each on a fresh model.
const baselines = new Map()
async function baseline(t, def, modelPath) {
  if (baselines.has(def.modelName)) return baselines.get(def.modelName)
  const dir = scratchDir(t, 'baseline')
  const cold = await loadModel(t, modelPath)
  const ask = await run(cold.model, ASK, { cacheKey: path.join(dir, 'ask.bin') })
  await cold.unload()
  const fresh = await loadModel(t, modelPath)
  const prime = await run(fresh.model, PRIME, {
    cacheKey: path.join(dir, 'prime.bin'),
    prefill: true
  })
  await fresh.unload()
  const result = { promptTokens: ask.promptTokens, primedTokens: prime.cacheTokens }
  t.ok(result.primedTokens > 0, 'the baseline prefill caches a nonempty prefix')
  t.ok(
    result.promptTokens > result.primedTokens,
    'the cold question includes tokens beyond the primed prefix'
  )
  baselines.set(def.modelName, result)
  return result
}

// Asks the question on a fresh model loaded from a copy of `primedKey`.
async function askAfterReload(t, modelPath, parallel, primedKey) {
  const reloadKey = `${primedKey}.reload.bin`
  fs.copyFileSync(primedKey, reloadKey)
  const { model, unload } = await loadModel(t, modelPath, parallel)
  const ask = await run(model, ASK, { cacheKey: reloadKey })
  await unload()
  return ask
}

safeTest(
  'prime: a saved system prompt and tools prefill leaves only the user turn to prefill',
  { timeout: 600_000 },
  async (t) => {
    const dir = scratchDir(t, 'saved')
    const coldKey = path.join(dir, 'cold.bin')
    const primedKey = path.join(dir, 'primed.bin')
    const modelPath = await ensureModelPath(QWEN35)

    const first = await loadModel(t, modelPath)
    const cold = await run(first.model, ASK, { cacheKey: coldKey })
    const primed = await run(first.model, PRIME, { cacheKey: primedKey, prefill: true })
    await first.model.saveCache(primedKey)
    await first.unload()

    t.is(primed.output, '', 'the prefill generates no answer')
    t.is(primed.toolDefinitionsDropped, 0, 'the prefill keeps the tool definitions')
    t.ok(primed.cacheTokens > 0, `the prefill cached ${primed.cacheTokens} tokens`)
    t.ok(
      primed.cacheTokens < cold.promptTokens,
      `the prefill (${primed.cacheTokens}) stops before the user turn (${cold.promptTokens})`
    )

    const second = await loadModel(t, modelPath)
    const warm = await run(second.model, ASK, { cacheKey: primedKey })

    t.is(warm.toolDefinitionsDropped, 0, 'the question keeps the tool definitions')
    t.is(
      warm.promptTokens,
      cold.promptTokens - primed.cacheTokens,
      `after a reload the question prefilled ${warm.promptTokens} of ${cold.promptTokens} tokens`
    )
  }
)

for (const { label, def } of MODELS) {
  for (const parallel of ['1', '2', '4']) {
    safeTest(
      `prime: ${label}, parallel ${parallel}: a prefill on an empty cache is reused in the same process and after a reload`,
      { skip: desktopOnly, timeout: 600_000 },
      async (t) => {
        const modelPath = await ensureModelPath(def)
        const base = await baseline(t, def, modelPath)
        const userTurn = base.promptTokens - base.primedTokens
        const dir = scratchDir(t, `empty-${parallel}`)
        const primedKey = path.join(dir, 'primed.bin')

        const { model, unload } = await loadModel(t, modelPath, parallel)
        const prime = await run(model, PRIME, { cacheKey: primedKey, prefill: true })
        await model.saveCache(primedKey)
        t.is(prime.output, '', 'the prefill generates no answer')
        t.is(prime.toolDefinitionsDropped, 0, 'the prefill keeps the tool definitions')
        t.is(
          prime.cacheTokens,
          base.primedTokens,
          `the first request cached the ${base.primedTokens}-token system prompt and tools`
        )
        t.ok(fs.statSync(primedKey).size > 0, 'the primed cache is saved')

        const reloaded = await askAfterReload(t, modelPath, parallel, primedKey)
        const same = await run(model, ASK, { cacheKey: primedKey })
        await unload()

        t.is(
          same.promptTokens,
          userTurn,
          `in the same process the question prefilled only its ${userTurn}-token user turn`
        )
        t.is(
          reloaded.promptTokens,
          userTurn,
          `after a reload the question prefilled only its ${userTurn}-token user turn`
        )
        t.is(reloaded.toolDefinitionsDropped, 0, 'the question keeps the tool definitions')
      }
    )
  }

  for (const parallel of ['2', '4']) {
    const primes = parallel === '4' ? 2 : 1
    safeTest(
      `prime: ${label}, parallel ${parallel}: ${primes} prefill(s) decoded next to a generating request are reused`,
      { skip: desktopOnly, timeout: 600_000 },
      async (t) => {
        const modelPath = await ensureModelPath(def)
        const base = await baseline(t, def, modelPath)
        const userTurn = base.promptTokens - base.primedTokens
        const dir = scratchDir(t, `concurrent-${parallel}`)
        const primedKeys = Array.from({ length: primes }, (_, i) =>
          path.join(dir, `primed-${i}.bin`)
        )

        const { model, unload } = await loadModel(t, modelPath, parallel)
        const story = await startGenerating(model, LONG, {
          cacheKey: path.join(dir, 'story.bin'),
          generationParams: { predict: 256 }
        })
        const primed = await Promise.all(
          primedKeys.map((cacheKey) =>
            run(model, PRIME, { cacheKey, prefill: true }).then((result) => ({
              result,
              doneAt: Date.now()
            }))
          )
        )
        const storyDoneAt = await story.done

        for (const [i, { result, doneAt }] of primed.entries()) {
          t.ok(doneAt < storyDoneAt, `prefill ${i} finished while the story was still generating`)
          t.is(result.output, '', `prefill ${i} generates no answer`)
          t.is(result.toolDefinitionsDropped, 0, `prefill ${i} keeps the tool definitions`)
        }

        for (const [i, primedKey] of primedKeys.entries()) {
          await model.saveCache(primedKey)
          const reloaded = await askAfterReload(t, modelPath, parallel, primedKey)
          const same = await run(model, ASK, { cacheKey: primedKey })
          t.is(
            same.promptTokens,
            userTurn,
            `prefill ${i}: in the same process the question prefilled only its ${userTurn}-token user turn`
          )
          t.is(
            reloaded.promptTokens,
            userTurn,
            `prefill ${i}: after a reload the question prefilled only its ${userTurn}-token user turn`
          )
        }
        await unload()
      }
    )
  }
}
