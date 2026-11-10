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
//   - QVAC_RUN_SPECULATIVE_DSPARK=1: DSpark (`spec-type: 'draft-dspark'`) on
//     LiquidAI's LFM2.5-1.2B-Instruct with its DSpark drafter (about 1 GB of
//     models).
//   - QVAC_RUN_SPECULATIVE_DSPARK_VL=1: DSpark after an image prompt, on
//     LiquidAI's LFM2.5-VL-3B with its projector and DSpark drafter (about
//     2.8 GB of models).
//
// QVAC_SPECULATIVE_TOLERATE_DIVERGENCE=1 lets greedy output differ from plain
// decoding and between runs, for GPU backends (e.g. RADV Vulkan) whose batched
// verification flips near-ties. Off by default: CI requires identical output.
// Always on for Android: with quantized weights, a single token decodes through
// the GPU's integer-dot matrix-vector path and a verify batch through the
// matrix-matrix path, and their logits differ by more than a near-tie's margin.
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
// prestage-ignore: LFM2.5-1.2B-Instruct-Q4_K_M.gguf — opt-in via QVAC_RUN_SPECULATIVE_DSPARK=1, desktop-only
// prestage-ignore: LFM2.5-1.2B-Instruct-DSpark-Q8_0.gguf — opt-in via QVAC_RUN_SPECULATIVE_DSPARK=1, desktop-only
// prestage-ignore: LFM2.5-VL-3B-Q4_K_M.gguf — opt-in via QVAC_RUN_SPECULATIVE_DSPARK_VL=1, desktop-only
// prestage-ignore: mmproj-LFM2.5-VL-3B-Q8_0.gguf — opt-in via QVAC_RUN_SPECULATIVE_DSPARK_VL=1, desktop-only
// prestage-ignore: LFM2.5-VL-3B-DSpark-F16.gguf — opt-in via QVAC_RUN_SPECULATIVE_DSPARK_VL=1, desktop-only

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
const skipDspark = optIn('QVAC_RUN_SPECULATIVE_DSPARK', 'DSpark on LFM2.5-1.2B')
const skipDsparkVl = optIn('QVAC_RUN_SPECULATIVE_DSPARK_VL', 'DSpark on LFM2.5-VL-3B')
const DSPARK_TARGET = 'LFM2.5-1.2B-Instruct-Q4_K_M.gguf'
const DSPARK_DRAFT = 'LFM2.5-1.2B-Instruct-DSpark-Q8_0.gguf'
const tolerateDivergence =
  platform === 'android' || readEnv('QVAC_SPECULATIVE_TOLERATE_DIVERGENCE') === '1'

// `draft` is the `spec-draft-model`. The 27B variants download their models
// on first use, so their tests get room for that.
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
    // Its MTP tensors are nextn_proj_pre/post, not the nextn.eh_proj that
    // fabric's type detection looks for, so `auto` refuses it, as
    // llama-server does.
    autoDetects: false,
    skip: skipMtpHeads
  },
  {
    label: 'An external MTP head on Qwen3.5-2B',
    target: 'Qwen3.5-2B-Q4_0.gguf',
    type: 'draft-mtp',
    draft: 'Qwen3.5-2B-MTP-Q4_0.gguf',
    skip: skipMtpHeads
  },
  {
    // The drafter's block is 9 tokens; the default n-max of 3 would use a
    // third of it.
    label: 'DSpark',
    target: 'LFM2.5-1.2B-Instruct-Q4_K_M.gguf',
    type: 'draft-dspark',
    draft: 'LFM2.5-1.2B-Instruct-DSpark-Q8_0.gguf',
    extra: { 'spec-draft-n-max': '9' },
    skip: skipDspark
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
  return baseConfig({ 'spec-type': variant.type, ...draft, ...variant.extra, ...extra })
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

// A stop word that first appears in the second half of `text`, so generation
// drafts for a while before an accepted run reaches it. Stop strings match
// case-insensitively.
function pickStopWord(text) {
  const lower = text.toLowerCase()
  const half = Math.floor(lower.length / 2)
  return (lower.slice(half).match(/[a-z]{5,}/g) || []).find((word) => lower.indexOf(word) >= half)
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

      const reference = await run(baseConfig({ 'spec-type': 'none' }))
      const stopWord = pickStopWord(reference.output)
      t.ok(stopWord, `found a stop word in the plain output: ${stopWord}`)

      const plain = await run(baseConfig({ 'spec-type': 'none', reverse_prompt: stopWord }))
      const speculative = await run(await variantConfig(variant, { reverse_prompt: stopWord }))
      t.is(plain.stats.stopReason, 'antiprompt', 'plain decoding stopped on the stop word')
      if (tolerateDivergence) {
        // Outputs may diverge before the stop, and the speculative text may then
        // never contain the stop word. Each output that does must stop at its own
        // first match, and where one contains the other they must be equal.
        assertStopsAtFirstMatch(t, plain.output, stopWord, 'plain')
        if (speculative.output.toLowerCase().includes(stopWord)) {
          t.is(
            speculative.stats.stopReason,
            'antiprompt',
            'speculative decoding stopped on the stop word'
          )
          assertStopsAtFirstMatch(t, speculative.output, stopWord, 'speculative')
        } else {
          t.is(
            speculative.stats.stopReason,
            'predictionLimit',
            'speculative text without the stop word ran to the prediction limit'
          )
          // That run never matched, so it is the speculative output without a
          // stop. A word from it must stop speculative decoding, unless the
          // next run diverges from it before the word.
          const own = speculative.output
          const ownWord = pickStopWord(own)
          t.ok(ownWord, `found a stop word in the speculative output: ${ownWord}`)
          const stopped = await run(await variantConfig(variant, { reverse_prompt: ownWord }))
          if (stopped.output.toLowerCase().includes(ownWord)) {
            t.is(
              stopped.stats.stopReason,
              'antiprompt',
              'speculative decoding stopped on a word from its own output'
            )
            assertStopsAtFirstMatch(t, stopped.output, ownWord, 'speculative')
            assertDrafted(t, stopped.stats, 'own stop string')
          } else {
            const at = commonPrefixLength(stopped.output, own)
            t.ok(
              at < own.toLowerCase().indexOf(ownWord) + ownWord.length,
              'speculative text without its own stop word diverged from its own output before it'
            )
            t.comment(`second speculative run diverged at character ${at}`)
          }
        }
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
          speculative.stats.stopReason,
          'antiprompt',
          'speculative decoding stopped on the stop word'
        )
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

// Speculation after an image: fabric fixed both llama-server's drafting after
// an image and DFlash's decoding of image chunks, which the addon mirrors in
// its own batch path. The drafter takes the target's hidden states for the
// image positions too. A one-sentence answer, like the MTP image test's: a
// longer description reaches near-ties that batched verification can flip
// (fabric's llama-server flips the same one), which
// QVAC_SPECULATIVE_TOLERATE_DIVERGENCE covers as for every other variant.
safeTest(
  'DSpark drafts after an image prompt as plain decoding answers',
  { timeout: 1_200_000, skip: skipDsparkVl },
  async (t) => {
    const VL_TARGET = 'LFM2.5-VL-3B-Q4_K_M.gguf'
    const files = { projectionModel: await modelPath('mmproj-LFM2.5-VL-3B-Q8_0.gguf') }
    const prompt = [
      { role: 'user', type: 'media', content: getMediaPath('elephant.jpg') },
      { role: 'user', content: 'What animal is in the image? Answer in one sentence.' }
    ]
    async function run(config) {
      const model = await loadModel(VL_TARGET, config, files)
      try {
        return await runOnce(model, prompt)
      } finally {
        await model.unload()
      }
    }
    const plain = await run(baseConfig({ 'spec-type': 'none' }))
    const speculative = await run(
      baseConfig({
        'spec-type': 'draft-dspark',
        'spec-draft-model': await modelPath('LFM2.5-VL-3B-DSpark-F16.gguf'),
        'spec-draft-n-max': '8'
      })
    )
    t.ok(/elephant/i.test(speculative.output), 'recognised the elephant')
    assertDrafted(t, speculative.stats, 'after an image')
    if (tolerateDivergence) {
      if (speculative.output !== plain.output) {
        t.comment(
          `diverged from plain at character ${commonPrefixLength(speculative.output, plain.output)}`
        )
      }
    } else {
      t.is(speculative.output, plain.output, 'same output as plain decoding')
    }
  }
)

// A prompt several times longer than the drafter's block, fresh and then as a
// cached second turn, so the prompt end the drafter is given moves with the
// cache. (LFM2.5's drafter has no attention window; a windowed drafter, such
// as DeepSeek V4's, is what exercises fabric's window cut-off.)
safeTest(
  'DSpark on a long prompt and its cached follow-up',
  { timeout: 900_000, skip: skipDspark },
  async (t) => {
    const passage = Array.from(
      { length: 24 },
      (_, i) =>
        `Paragraph ${i + 1}: speculative decoding drafts several tokens with a small model and verifies them with the large one in a single pass, which helps most when decoding is bound by memory bandwidth.`
    ).join('\n')
    const cacheKey = path.join(os.tmpdir(), `qvac-dspark-long-${Date.now()}.bin`)
    cleanupIntegrationCacheFiles(cacheKey)
    const model = await loadModel(
      DSPARK_TARGET,
      baseConfig({
        'spec-type': 'draft-dspark',
        'spec-draft-model': await modelPath(DSPARK_DRAFT),
        'spec-draft-n-max': '9',
        n_predict: '96'
      })
    )
    try {
      const history = [
        { role: 'user', content: `Summarize this text in three bullet points.\n\n${passage}` }
      ]
      const first = await runOnce(model, history, { cacheKey })
      t.ok(first.stats.promptTokens > 600, `long prompt: ${first.stats.promptTokens} tokens`)
      assertDrafted(t, first.stats, 'long prompt')
      history.push({ role: 'assistant', content: first.output })
      history.push({ role: 'user', content: 'Now give it a one-line title.' })
      const second = await runOnce(model, history, { cacheKey })
      const reused =
        second.stats.CacheTokens - second.stats.promptTokens - second.stats.generatedTokens
      t.ok(reused > 600, `follow-up reused ${reused} cached tokens`)
      assertDrafted(t, second.stats, 'cached follow-up')
    } finally {
      await model.unload()
      cleanupIntegrationCacheFiles(cacheKey)
    }
  }
)

// Four sequences, two of them sharing the prefix of a request just served,
// so drafting runs alongside cached and fresh prompts in the same batch.
safeTest(
  'DSpark with four sequences and mixed cache hits',
  { timeout: 900_000, skip: skipDspark },
  async (t) => {
    const model = await loadModel(
      DSPARK_TARGET,
      baseConfig({
        'spec-type': 'draft-dspark',
        'spec-draft-model': await modelPath(DSPARK_DRAFT),
        'spec-draft-n-max': '6',
        parallel: '4',
        ctx_size: '16384'
      })
    )
    try {
      // Warm the prefix the "hit" sequences share.
      await runOnce(model, PROMPT, { generationParams: { predict: 8 } })
      const jobs = [
        { id: 'hit-a', prompt: PROMPT },
        {
          id: 'hit-b',
          prompt: [
            ...PROMPT,
            { role: 'assistant', content: 'Sure.' },
            { role: 'user', content: 'Add type hints.' }
          ]
        },
        { id: 'miss-a', prompt: [{ role: 'user', content: 'Explain how a hash map works.' }] },
        { id: 'miss-b', prompt: [{ role: 'user', content: 'Write a haiku about the sea.' }] }
      ].map((job) => ({ ...job, runOptions: { generationParams: { predict: 48 } } }))
      const response = await model.run(jobs)
      const outputs = new Map()
      response.onUpdate(({ id, chunk }) => outputs.set(id, (outputs.get(id) || '') + chunk))
      await response.await()
      for (const { id } of jobs) t.ok((outputs.get(id) || '').length > 0, `${id} produced output`)
      // A short answer may end before its budget; a draft must never overrun it.
      t.ok(
        response.stats.generatedTokens <= 4 * 48,
        `no sequence ran past its budget (${response.stats.generatedTokens} tokens)`
      )
      assertDrafted(t, response.stats, 'four sequences')
    } finally {
      await model.unload()
    }
  }
)

// A projection with a draft model is a verdict, and the draft model is in
// its figures, including one that borrows from the model (a Gemma 4
// assistant, a DFlash drafter). Kept here rather than in fit.test.js because
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

      t.ok(fit.status === 'fits' || fit.status === 'does-not-fit', 'a verdict')
      const used = (projection) => projection.devices.reduce((sum, row) => sum + row.usedBytes, 0)
      t.comment(`${variant.label}: plain ${used(plain)} bytes, speculative ${used(fit)}`)
      t.ok(used(fit) > used(plain), 'the draft model is in the rows')
    }
  )
}

// `spec-type: 'auto'` reads the type from the drafter's header and must then
// run exactly as the explicit type: same tokens, same drafts. The external
// MTP head on Qwen3.5-0.8B runs in CI; the other drafters are opt-in.
const AUTO_CASES = [
  {
    label: 'an external MTP head',
    target: NO_MTP_MODEL,
    type: 'draft-mtp',
    draft: MTP_MODEL
  },
  ...VARIANTS.filter((v) => v.draft)
]

for (const variant of AUTO_CASES) {
  safeTest(
    `spec-type auto drafts like ${variant.type} for ${variant.label}`,
    { timeout: Math.max(600_000, variant.timeout || 0), skip: variant.skip },
    async (t) => {
      async function run(type) {
        const model = await loadModel(
          variant.target,
          baseConfig({
            'spec-type': type,
            'spec-draft-model': await modelPath(variant.draft),
            ...variant.extra
          })
        )
        try {
          return await runOnce(model, PROMPT)
        } finally {
          await model.unload()
        }
      }
      if (variant.autoDetects === false) {
        await t.exception(run('auto'), /spec-type "auto" cannot read the type of/)
        return
      }
      const explicit = await run(variant.type)
      const detected = await run('auto')
      assertDrafted(t, detected.stats, 'auto')
      t.is(detected.output, explicit.output, `same output as ${variant.type}`)
      t.is(detected.stats.draftTokens, explicit.stats.draftTokens, 'same drafted tokens')
      t.is(
        detected.stats.draftAcceptedTokens,
        explicit.stats.draftAcceptedTokens,
        'same accepted tokens'
      )
    }
  )
}

safeTest('spec-type auto fails to load a drafter of no type', { timeout: 300_000 }, async (t) => {
  // A plain Qwen3.5 model: no MTP layers, not a DFlash model.
  const model = new LlmLlamacpp({
    files: { model: [await modelPath(MTP_MODEL)] },
    config: baseConfig({
      'spec-type': 'auto',
      'spec-draft-model': await modelPath(NO_MTP_MODEL)
    }),
    logger: null
  })
  await t.exception(
    model.load(),
    /spec-type "auto" cannot read the type of '.*': it is neither a DFlash or DSpark model nor a model with MTP layers/
  )
  await model.unload().catch(() => {})
})

safeTest(
  'spec-type rejects types other than draft-mtp, draft-dflash, draft-dspark and auto',
  { timeout: 300_000 },
  async (t) => {
    const model = new LlmLlamacpp({
      files: { model: [await modelPath(MTP_MODEL)] },
      config: baseConfig({ 'spec-type': 'ngram-simple' }),
      logger: null
    })
    await t.exception(
      model.load(),
      /must be "none", "draft-mtp", "draft-dflash", "draft-dspark" or "auto"/
    )
    await model.unload().catch(() => {})
  }
)

for (const type of ['draft-dflash', 'draft-dspark', 'auto']) {
  safeTest(`${type} requires spec-draft-model`, { timeout: 300_000 }, async (t) => {
    const model = new LlmLlamacpp({
      files: { model: [await modelPath(MTP_MODEL)] },
      config: baseConfig({ 'spec-type': type }),
      logger: null
    })
    await t.exception(model.load(), /requires spec-draft-model/)
    await model.unload().catch(() => {})
  })
}

// Checked from the drafter's header before fabric loads it: fabric would run
// any DFlash-architecture model with DSpark's block layout.
safeTest(
  'draft-dspark fails to load a drafter that is not a DSpark model',
  { timeout: 300_000 },
  async (t) => {
    const model = new LlmLlamacpp({
      files: { model: [await modelPath(MTP_MODEL)] },
      config: baseConfig({
        'spec-type': 'draft-dspark',
        'spec-draft-model': await modelPath(NO_MTP_MODEL)
      }),
      logger: null
    })
    await t.exception(
      model.load(),
      /cannot draft for spec-type "draft-dspark": it is a \w+ model, not a DSpark drafter/
    )
    await model.unload().catch(() => {})
  }
)

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
