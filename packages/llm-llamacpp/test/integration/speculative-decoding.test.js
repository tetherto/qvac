'use strict'

// MTP speculative decoding (`spec-type: 'draft-mtp'`) on the single-prompt,
// multimodal, cached and continuous-batching paths. The model is ggml-org's
// Qwen3.5-0.8B quant, which keeps the `blk.*.nextn.*` MTP layers that the
// unsloth quants used elsewhere strip.
//
// DFlash (`spec-type: 'draft-dflash'`) shares the drafting, verification,
// rollback, batching and cache code with MTP; only its load-time validation
// runs here. No DFlash drafter small enough for CI exists, so its decoding
// path is validated manually against a 27B target.

const path = require('bare-path')
const os = require('bare-os')
const LlmLlamacpp = require('../../index.js')
const {
  cleanupIntegrationCacheFiles,
  ensureModel,
  getMediaPath,
  safeTest: integrationTest
} = require('./utils')

const platform = os.platform()
const arch = os.arch()
const isDarwinX64 = platform === 'darwin' && arch === 'x64'
const isLinuxArm64 = platform === 'linux' && arch === 'arm64'
const useCpu = isDarwinX64 || isLinuxArm64

function safeTest(name, opts, fn) {
  integrationTest(name, { ...opts, skip: opts.skip || isDarwinX64 }, fn)
}

const MTP_MODEL = 'Qwen3.5-0.8B-MTP-Q8_0.gguf'
const NO_MTP_MODEL = 'Qwen3.5-0.8B-Q8_0.gguf'
const MMPROJ = 'mmproj-Qwen3.5-0.8B-F16.gguf'

const PROMPT = [
  { role: 'user', content: 'Write a Python function that checks whether a number is prime.' }
]

function baseConfig(extra = {}) {
  return {
    device: useCpu ? 'cpu' : 'gpu',
    gpu_layers: '999',
    ctx_size: '4096',
    n_predict: '96',
    temp: '0',
    'spec-type': 'draft-mtp',
    verbosity: '1',
    ...extra
  }
}

async function modelPath(name) {
  const [file, dir] = await ensureModel({ modelName: name })
  return path.join(dir, file)
}

async function loadModel(config, files = {}) {
  const model = new LlmLlamacpp({
    files: { model: [await modelPath(MTP_MODEL)], ...files },
    config,
    logger: null,
    opts: { stats: true }
  })
  await model.load()
  return model
}

async function runOnce(model, prompt, runOptions) {
  const response = await model.run(prompt, runOptions)
  let output = ''
  await response
    .onUpdate((data) => {
      output += data
    })
    .await()
  return { output, stats: response.stats }
}

function assertDrafted(t, stats, label) {
  t.ok(stats.draftTokens > 0, `${label}: drafted ${stats.draftTokens} tokens`)
  t.ok(
    stats.draftAcceptedTokens > 0 && stats.draftAcceptedTokens <= stats.draftTokens,
    `${label}: accepted ${stats.draftAcceptedTokens} of ${stats.draftTokens}`
  )
}

safeTest('MTP drafts and verifies on a single prompt', { timeout: 600_000 }, async (t) => {
  const model = await loadModel(baseConfig())
  try {
    const first = await runOnce(model, PROMPT)
    t.ok(first.output.length > 0, 'produced output')
    t.is(first.stats.stopReason, 'predictionLimit', 'ran to the prediction limit')
    t.is(first.stats.generatedTokens, 96, 'speculation keeps the exact token budget')
    assertDrafted(t, first.stats, 'single prompt')

    // Greedy speculative decoding is deterministic run to run.
    const second = await runOnce(model, PROMPT)
    t.is(second.output, first.output, 'identical output on a second greedy run')
  } finally {
    await model.unload()
  }
})

safeTest(
  'MTP stops on a stop string exactly where plain decoding does',
  { timeout: 900_000 },
  async (t) => {
    async function run(config) {
      const model = await loadModel(config)
      try {
        return await runOnce(model, PROMPT)
      } finally {
        await model.unload()
      }
    }

    // A stop word that first appears in the second half of the plain output,
    // so generation drafts for a while before an accepted run reaches it.
    // Stop strings match case-insensitively.
    const reference = await run(baseConfig({ 'spec-type': 'none' }))
    const lower = reference.output.toLowerCase()
    const half = Math.floor(lower.length / 2)
    const stopWord = (lower.slice(half).match(/[a-z]{5,}/g) || []).find(
      (word) => lower.indexOf(word) >= half
    )
    t.ok(stopWord, `found a stop word in the plain output: ${stopWord}`)

    const plain = await run(baseConfig({ 'spec-type': 'none', reverse_prompt: stopWord }))
    const speculative = await run(baseConfig({ reverse_prompt: stopWord }))
    t.is(plain.stats.stopReason, 'antiprompt', 'plain decoding stopped on the stop word')
    t.is(
      speculative.stats.stopReason,
      'antiprompt',
      'speculative decoding stopped on the stop word'
    )
    t.is(speculative.output, plain.output, 'speculative output matches plain output up to the stop')
    t.is(speculative.stats.generatedTokens, plain.stats.generatedTokens, 'same token count')
    assertDrafted(t, speculative.stats, 'stop string')
  }
)

safeTest('MTP keeps cached conversations working across turns', { timeout: 900_000 }, async (t) => {
  const cacheKey = path.join(os.tmpdir(), `qvac-mtp-cache-${Date.now()}.bin`)
  cleanupIntegrationCacheFiles(cacheKey)
  const model = await loadModel(baseConfig({ n_predict: '64' }))
  try {
    const history = [...PROMPT]
    const first = await runOnce(model, history, { cacheKey })
    assertDrafted(t, first.stats, 'turn 1')
    history.push({ role: 'assistant', content: first.output })
    history.push({ role: 'user', content: 'Now make it faster for large inputs.' })

    const second = await runOnce(model, history, { cacheKey })
    t.ok(second.output.length > 0, 'turn 2 produced output')
    const reused =
      second.stats.CacheTokens - second.stats.promptTokens - second.stats.generatedTokens
    t.ok(reused > 0, `turn 2 reused ${reused} cached tokens`)
    assertDrafted(t, second.stats, 'turn 2')

    await model.saveCache(cacheKey)
  } finally {
    await model.unload()
  }

  // A cacheKey file holds the target state only; drafting restarts from it.
  const reloaded = await loadModel(baseConfig({ n_predict: '64' }))
  try {
    const third = await runOnce(
      reloaded,
      [...PROMPT, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'Thanks.' }],
      { cacheKey }
    )
    t.ok(third.output.length > 0, 'reloaded turn produced output')
    assertDrafted(t, third.stats, 'reloaded turn')
  } finally {
    await reloaded.unload()
  }
})

safeTest('MTP under continuous batching', { timeout: 900_000 }, async (t) => {
  const model = await loadModel(baseConfig({ parallel: '2', ctx_size: '8192' }))
  try {
    const response = await model.run([
      { id: 'a', prompt: PROMPT, runOptions: { generationParams: { predict: 64 } } },
      {
        id: 'b',
        prompt: [{ role: 'user', content: 'Explain how a hash map works.' }],
        runOptions: { generationParams: { predict: 64 } }
      }
    ])
    const outputs = new Map()
    response.onUpdate(({ id, chunk }) => outputs.set(id, (outputs.get(id) || '') + chunk))
    await response.await()
    t.ok((outputs.get('a') || '').length > 0, 'sequence a produced output')
    t.ok((outputs.get('b') || '').length > 0, 'sequence b produced output')
    t.is(response.stats.generatedTokens, 128, 'both sequences used their exact budget')
    assertDrafted(t, response.stats, 'batch')
  } finally {
    await model.unload()
  }
})

safeTest('MTP with an image prompt', { timeout: 900_000 }, async (t) => {
  // The model reasons before it answers, so leave room for the answer.
  const model = await loadModel(baseConfig({ n_predict: '384' }), {
    projectionModel: await modelPath(MMPROJ)
  })
  try {
    const { output, stats } = await runOnce(model, [
      { role: 'user', type: 'media', content: getMediaPath('elephant.jpg') },
      { role: 'user', content: 'What animal is in the image? Answer in one sentence.' }
    ])
    t.ok(/elephant/i.test(output), 'recognised the elephant')
    t.ok(stats.draftTokens > 0, `drafted ${stats.draftTokens} tokens`)
  } finally {
    await model.unload()
  }
})

safeTest(
  'spec-type rejects types other than draft-mtp and draft-dflash',
  { timeout: 300_000 },
  async (t) => {
    const model = new LlmLlamacpp({
      files: { model: [await modelPath(MTP_MODEL)] },
      config: baseConfig({ 'spec-type': 'ngram-simple' }),
      logger: null
    })
    await t.exception(model.load(), /must be "none", "draft-mtp" or "draft-dflash"/)
    await model.unload().catch(() => {})
  }
)

safeTest('draft-dflash requires spec-draft-model', { timeout: 300_000 }, async (t) => {
  const model = new LlmLlamacpp({
    files: { model: [await modelPath(MTP_MODEL)] },
    config: baseConfig({ 'spec-type': 'draft-dflash' }),
    logger: null
  })
  await t.exception(model.load(), /requires spec-draft-model/)
  await model.unload().catch(() => {})
})

safeTest('draft-mtp fails to load a model without MTP layers', { timeout: 300_000 }, async (t) => {
  const model = new LlmLlamacpp({
    files: { model: [await modelPath(NO_MTP_MODEL)] },
    config: baseConfig(),
    logger: null
  })
  await t.exception(model.load(), /failed to create the MTP context/)
  await model.unload().catch(() => {})
})
