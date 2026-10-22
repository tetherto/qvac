'use strict'

// Speculative decoding on the single-prompt, multimodal, cached and
// continuous-batching paths. Every variant runs the same decoding tests:
//
// - MTP (`spec-type: 'draft-mtp'`) on ggml-org's Qwen3.5-0.8B quant, which
//   keeps the `blk.*.nextn.*` MTP layers that the unsloth quants used
//   elsewhere strip. The external-head tests attach that quant as
//   `spec-draft-model` to unsloth's, which has no MTP layers.
// - Opt-in, with models CI does not download:
//   - QVAC_RUN_SPECULATIVE_DFLASH=1: DFlash (`spec-type: 'draft-dflash'`) on
//     Qwen3-4B with AtomicChat's GGUF of z-lab's drafter (about 3 GB of
//     models).
//   - QVAC_RUN_SPECULATIVE_27B=1: MTP on the model's own layers, an external
//     MTP head and a DFlash2 drafter on Qwen3.8-27B (about 21 GB of models).
//   - QVAC_RUN_SPECULATIVE_MTP_HEADS=1: external MTP heads on other models, a
//     Gemma 4 assistant on Gemma 4 E2B and unsloth's MTP quant on its
//     Qwen3.5-2B (about 6 GB of models).
//
// QVAC_SPECULATIVE_TOLERATE_DIVERGENCE=1 lets greedy output differ from plain
// decoding and between runs, for GPU backends (e.g. RADV Vulkan) whose batched
// verification flips near-ties. Off by default: CI requires identical output.
//
// prestage-ignore: Qwen3-4B-Q4_K_M.gguf — opt-in via QVAC_RUN_SPECULATIVE_DFLASH=1, desktop-only
// prestage-ignore: Qwen3-4B-DFlash-Q8_0.gguf — opt-in via QVAC_RUN_SPECULATIVE_DFLASH=1, desktop-only
// prestage-ignore: Qwen3.8-27B-UD-Q4_K_XL.gguf — opt-in via QVAC_RUN_SPECULATIVE_27B=1, desktop-only
// prestage-ignore: mtp-Qwen3.8-27B-Q4_0.gguf — opt-in via QVAC_RUN_SPECULATIVE_27B=1, desktop-only
// prestage-ignore: Qwen3.8-27B-DFlash2-Q8_0.gguf — opt-in via QVAC_RUN_SPECULATIVE_27B=1, desktop-only
// prestage-ignore: google_gemma-4-E2B-it-Q4_K_M.gguf — opt-in via QVAC_RUN_SPECULATIVE_MTP_HEADS=1, desktop-only
// prestage-ignore: gemma-4-E2B-it-assistant-Q8_0.gguf — opt-in via QVAC_RUN_SPECULATIVE_MTP_HEADS=1, desktop-only
// prestage-ignore: Qwen3.5-2B-Q4_0.gguf — opt-in via QVAC_RUN_SPECULATIVE_MTP_HEADS=1, desktop-only
// prestage-ignore: Qwen3.5-2B-MTP-Q4_0.gguf — opt-in via QVAC_RUN_SPECULATIVE_MTP_HEADS=1, desktop-only

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
const isMobile = platform === 'ios' || platform === 'android'
const isDarwinX64 = platform === 'darwin' && arch === 'x64'
const isLinuxArm64 = platform === 'linux' && arch === 'arm64'
const useCpu = isDarwinX64 || isLinuxArm64

function safeTest(name, opts, fn) {
  integrationTest(name, { ...opts, skip: opts.skip || isDarwinX64 }, fn)
}

function readEnv(key) {
  if (typeof os.getEnv === 'function') return os.getEnv(key) || ''
  if (typeof process !== 'undefined' && process.env) return process.env[key] || ''
  return ''
}

function optIn(key, what) {
  if (isMobile) return `${what} is desktop-only`
  return readEnv(key) === '1' ? false : `${what} is opt-in; set ${key}=1`
}

const MTP_MODEL = 'Qwen3.5-0.8B-MTP-Q8_0.gguf'
const NO_MTP_MODEL = 'Qwen3.5-0.8B-Q8_0.gguf'
const MMPROJ = 'mmproj-Qwen3.5-0.8B-F16.gguf'

const LARGE_TARGET = 'Qwen3.8-27B-UD-Q4_K_XL.gguf'
const skipDflash = optIn('QVAC_RUN_SPECULATIVE_DFLASH', 'DFlash on Qwen3-4B')
const skipLarge = optIn('QVAC_RUN_SPECULATIVE_27B', 'Speculative decoding on Qwen3.8-27B')
const skipMtpHeads = optIn('QVAC_RUN_SPECULATIVE_MTP_HEADS', 'External MTP heads')
const tolerateDivergence = readEnv('QVAC_SPECULATIVE_TOLERATE_DIVERGENCE') === '1'

// `draft` is the `spec-draft-model`. The 27B variants download their models
// on first use, so their tests get room for that. `unmeasured` marks a draft
// fabric cannot measure, which a fit leaves out; drop it from the Gemma 4
// assistant once fabric measures a draft that borrows from the model.
const VARIANTS = [
  { label: 'MTP', target: MTP_MODEL, type: 'draft-mtp' },
  {
    label: 'DFlash',
    target: 'Qwen3-4B-Q4_K_M.gguf',
    type: 'draft-dflash',
    draft: 'Qwen3-4B-DFlash-Q8_0.gguf',
    skip: skipDflash
  },
  {
    label: 'MTP on Qwen3.8-27B',
    target: LARGE_TARGET,
    type: 'draft-mtp',
    skip: skipLarge,
    timeout: 7_200_000
  },
  {
    label: 'An external MTP head on Qwen3.8-27B',
    target: LARGE_TARGET,
    type: 'draft-mtp',
    draft: 'mtp-Qwen3.8-27B-Q4_0.gguf',
    skip: skipLarge,
    timeout: 7_200_000
  },
  {
    label: 'DFlash2 on Qwen3.8-27B',
    target: LARGE_TARGET,
    type: 'draft-dflash',
    draft: 'Qwen3.8-27B-DFlash2-Q8_0.gguf',
    skip: skipLarge,
    timeout: 7_200_000
  },
  {
    label: 'A Gemma 4 assistant on Gemma 4 E2B',
    target: 'google_gemma-4-E2B-it-Q4_K_M.gguf',
    type: 'draft-mtp',
    draft: 'gemma-4-E2B-it-assistant-Q8_0.gguf',
    unmeasured: true,
    skip: skipMtpHeads
  },
  {
    label: 'An external MTP head on Qwen3.5-2B',
    target: 'Qwen3.5-2B-Q4_0.gguf',
    type: 'draft-mtp',
    draft: 'Qwen3.5-2B-MTP-Q4_0.gguf',
    skip: skipMtpHeads
  }
]

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

async function variantConfig(variant, extra = {}) {
  const draft = variant.draft ? { 'spec-draft-model': await modelPath(variant.draft) } : {}
  return baseConfig({ 'spec-type': variant.type, ...draft, ...extra })
}

async function loadModel(target, config, files = {}) {
  const model = new LlmLlamacpp({
    files: { model: [await modelPath(target)], ...files },
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

function assertStopsAtFirstMatch(t, output, stopWord, label) {
  const lower = output.toLowerCase()
  const first = lower.indexOf(stopWord)
  t.ok(
    first !== -1 && lower.indexOf(stopWord, first + 1) === -1,
    `${label} output ends at the first "${stopWord}"`
  )
}

function commonPrefixLength(a, b) {
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  return i
}

for (const variant of VARIANTS) {
  const { label, target, skip } = variant
  const timeout = (ms) => Math.max(ms, variant.timeout || 0)

  safeTest(
    `${label} drafts and verifies on a single prompt`,
    { timeout: timeout(600_000), skip },
    async (t) => {
      const model = await loadModel(target, await variantConfig(variant))
      try {
        const first = await runOnce(model, PROMPT)
        t.ok(first.output.length > 0, 'produced output')
        t.is(first.stats.stopReason, 'predictionLimit', 'ran to the prediction limit')
        t.is(first.stats.generatedTokens, 96, 'speculation keeps the exact token budget')
        assertDrafted(t, first.stats, 'single prompt')

        // Greedy speculative decoding is deterministic run to run.
        const second = await runOnce(model, PROMPT)
        if (tolerateDivergence) {
          t.is(second.stats.generatedTokens, 96, 'second greedy run keeps the token budget')
          if (second.output !== first.output) {
            const at = commonPrefixLength(second.output, first.output)
            t.comment(`second greedy run diverged at character ${at}`)
          }
        } else {
          t.is(second.output, first.output, 'identical output on a second greedy run')
        }
      } finally {
        await model.unload()
      }
    }
  )

  safeTest(
    `${label} stops on a stop string exactly where plain decoding does`,
    { timeout: timeout(900_000), skip },
    async (t) => {
      async function run(config) {
        const model = await loadModel(target, config)
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
      const speculative = await run(await variantConfig(variant, { reverse_prompt: stopWord }))
      t.is(plain.stats.stopReason, 'antiprompt', 'plain decoding stopped on the stop word')
      t.is(
        speculative.stats.stopReason,
        'antiprompt',
        'speculative decoding stopped on the stop word'
      )
      if (tolerateDivergence) {
        // Outputs may diverge before the stop; each must still stop at its own
        // first match, and where one contains the other they must be equal.
        assertStopsAtFirstMatch(t, plain.output, stopWord, 'plain')
        assertStopsAtFirstMatch(t, speculative.output, stopWord, 'speculative')
        const a = speculative.output
        const b = plain.output
        t.ok(
          a === b || !(a.startsWith(b) || b.startsWith(a)),
          'speculative decoding stops where plain decoding does on the same text'
        )
        if (a === b) {
          t.is(speculative.stats.generatedTokens, plain.stats.generatedTokens, 'same token count')
        } else {
          t.comment(`outputs diverged at character ${commonPrefixLength(a, b)} before the stop`)
        }
      } else {
        t.is(
          speculative.output,
          plain.output,
          'speculative output matches plain output up to the stop'
        )
        t.is(speculative.stats.generatedTokens, plain.stats.generatedTokens, 'same token count')
      }
      assertDrafted(t, speculative.stats, 'stop string')
    }
  )

  safeTest(
    `${label} keeps cached conversations working across turns`,
    { timeout: timeout(900_000), skip },
    async (t) => {
      const cacheKey = path.join(os.tmpdir(), `qvac-spec-cache-${Date.now()}.bin`)
      cleanupIntegrationCacheFiles(cacheKey)
      const config = await variantConfig(variant, { n_predict: '64' })
      const model = await loadModel(target, config)
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
      const reloaded = await loadModel(target, config)
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
    }
  )

  safeTest(`${label} under continuous batching`, { timeout: timeout(900_000), skip }, async (t) => {
    const model = await loadModel(
      target,
      await variantConfig(variant, { parallel: '2', ctx_size: '8192' })
    )
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
}

safeTest('MTP with an image prompt', { timeout: 900_000 }, async (t) => {
  // The model reasons before it answers, so leave room for the answer.
  const model = await loadModel(MTP_MODEL, baseConfig({ n_predict: '384' }), {
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

// A projection with a draft model is a verdict; only a draft fabric can
// measure adds to the figures. Kept here rather than in fit.test.js because
// the variants' models are opt-in.
for (const variant of VARIANTS.filter((v) => v.draft)) {
  safeTest(
    `${variant.label}: assessFit projects the load`,
    { timeout: Math.max(600_000, variant.timeout || 0), skip: variant.skip },
    async (t) => {
      const file = await modelPath(variant.target)
      // A pinned context and placement keep the two projections comparable.
      const config = { device: 'gpu', 'gpu-layers': '999', 'ctx-size': '4096' }
      const plain = await LlmLlamacpp.assessFit({ modelPath: file, config })
      const fit = await LlmLlamacpp.assessFit({
        modelPath: file,
        config: {
          ...config,
          'spec-type': variant.type,
          'spec-draft-model': await modelPath(variant.draft)
        }
      })

      t.ok(fit.status === 'fits' || fit.status === 'does-not-fit', 'a verdict, not an error')
      const total = (projection) =>
        projection.devices.reduce(
          (sum, row) => sum + row.modelBytes + row.contextBytes + row.computeBytes,
          0
        )
      t.comment(`${variant.label}: plain ${total(plain)} bytes, speculative ${total(fit)} bytes`)
      if (variant.unmeasured) {
        t.ok(total(fit) >= total(plain), 'the unmeasured draft takes nothing away')
      } else if (variant.type === 'draft-mtp') {
        t.ok(total(fit) > total(plain), 'the MTP head and its context are in the figures')
      }
    }
  )
}

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

safeTest(
  'an external MTP head drafts for a model without MTP layers',
  { timeout: 600_000 },
  async (t) => {
    const model = new LlmLlamacpp({
      files: { model: [await modelPath(NO_MTP_MODEL)] },
      config: baseConfig({ 'spec-draft-model': await modelPath(MTP_MODEL) }),
      logger: null,
      opts: { stats: true }
    })
    await model.load()
    try {
      const { output, stats } = await runOnce(model, PROMPT)
      t.ok(output.length > 0, 'produced output')
      t.is(stats.generatedTokens, 96, 'speculation keeps the exact token budget')
      assertDrafted(t, stats, 'external head')
    } finally {
      await model.unload()
    }
  }
)

safeTest('an external head without MTP layers fails to load', { timeout: 300_000 }, async (t) => {
  const model = new LlmLlamacpp({
    files: { model: [await modelPath(NO_MTP_MODEL)] },
    config: baseConfig({ 'spec-draft-model': await modelPath(NO_MTP_MODEL) }),
    logger: null
  })
  await t.exception(model.load(), /failed to create the MTP context; '.*' has no MTP layers/)
  await model.unload().catch(() => {})
})

// A head for another model is refused before fabric loads it; fabric itself
// aborts on a width mismatch and does not check the vocabulary.
// prestage-ignore: Qwen3-0.6B-Q8_0.gguf — desktop-only; the test skips on mobile
safeTest(
  'an external head for another model fails to load',
  { timeout: 300_000, skip: isMobile },
  async (t) => {
    const model = new LlmLlamacpp({
      files: { model: [await modelPath('Qwen3-0.6B-Q8_0.gguf')] },
      config: baseConfig({ 'spec-draft-model': await modelPath(MTP_MODEL) }),
      logger: null
    })
    await t.exception(model.load(), /the MTP head '.*' does not match the model/)
    await model.unload().catch(() => {})
  }
)
