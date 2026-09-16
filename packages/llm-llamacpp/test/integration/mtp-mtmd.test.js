'use strict'

// MTP speculative decoding through the multimodal (mtmd) context path.
//
// The Qwen3.5-0.8B-MTP GGUF ships both an mmproj and the next-n / MTP head, so
// loading it with a projectionModel builds an MtmdLlmContext that can draft.
// Text turns draft; image turns fall back to non-speculative decoding because
// the vision prefill bypasses the draft context.
//
// Uses `safeTest` + `attachSpecLogger` (not plain brittle `test`): these files
// are routed to the Device Farm mobile groups, where a thrown native error
// would abort the whole shard, and attachSpecLogger captures the native QLOG_IF
// MTP diagnostics into the test log.

const fs = require('bare-fs')
const path = require('bare-path')
const LlmLlamacpp = require('../../index.js')
const { ensureModel, safeTest, getMediaPath, cleanupIntegrationCacheFiles } = require('./utils')
const { attachSpecLogger } = require('./spec-logger')
const os = require('bare-os')

const platform = os.platform()
const arch = os.arch()
const isDarwinX64 = platform === 'darwin' && arch === 'x64'
const isLinuxArm64 = platform === 'linux' && arch === 'arm64'
const useCpu = isDarwinX64 || isLinuxArm64

// `url` fields (pinned, matching test/integration/models.manifest.json) are
// required so scripts/generate-model-manifest.js stages these for the Device
// Farm mobile groups instead of the phone downloading from huggingface.co.
const MODEL = {
  name: 'Qwen3.5-0.8B-MTP-Q8_0.gguf',
  url: 'https://huggingface.co/prithivMLmods/Qwen3.5-0.8B-MTP-GGUF/resolve/e84039e503be9c81c5bfe3f0b0d00a7636894d9d/Qwen3.5-0.8B.Q8_0.gguf'
}
const MMPROJ = {
  name: 'Qwen3.5-0.8B-MTP-mmproj-q8_0.gguf',
  url: 'https://huggingface.co/prithivMLmods/Qwen3.5-0.8B-MTP-GGUF/resolve/e84039e503be9c81c5bfe3f0b0d00a7636894d9d/Qwen3.5-0.8B.mmproj-q8_0.gguf'
}

// Gemma's target and assistant head are desktop-only because the target plus
// projection model exceed the mobile test memory budget.
// prestage-ignore: google_gemma-4-E2B-it-Q4_K_M.gguf - desktop-only separate-head coverage.
const GEMMA_MODEL = {
  name: 'google_gemma-4-E2B-it-Q4_K_M.gguf'
}
// prestage-ignore: mmproj-google_gemma-4-E2B-it-f16.gguf - desktop-only separate-head coverage.
const GEMMA_MMPROJ = {
  name: 'mmproj-google_gemma-4-E2B-it-f16.gguf'
}
// prestage-ignore: gemma-4-E2B-it-assistant.Q4_K_M.gguf - used only with the desktop-only Gemma target.
const GEMMA_DRAFT_MODEL = {
  name: 'gemma-4-E2B-it-assistant.Q4_K_M.gguf'
}

const TEXT_PROMPT = [
  { role: 'system', content: 'You are a helpful assistant.' },
  { role: 'user', content: 'What is the capital of France? Answer in one complete sentence.' }
]

function mtpCacheFiles(cachePath) {
  return [cachePath, `${cachePath}.mtp-draft`, `${cachePath}.mtp-state`]
}

async function collectResponse(response) {
  const chunks = []
  const ticker = setInterval(() => {}, 50)
  try {
    await response
      .onUpdate((data) => {
        chunks.push(data)
      })
      .await()
  } finally {
    clearInterval(ticker)
  }
  return chunks.join('').trim()
}

async function loadMtmdMtp(
  t,
  { model = MODEL, projectionModel = MMPROJ, draftModel = null, overrides = {} } = {}
) {
  const [modelName, dirPath] = await ensureModel({ modelName: model.name })
  const [projName, projDir] = await ensureModel({ modelName: projectionModel.name })
  const draft = draftModel ? await ensureModel({ modelName: draftModel.name }) : null
  const specLogger = attachSpecLogger({ forwardToConsole: true })
  const addon = new LlmLlamacpp({
    files: {
      model: [path.join(dirPath, modelName)],
      projectionModel: path.join(projDir, projName)
    },
    config: {
      device: useCpu ? 'cpu' : 'gpu',
      gpu_layers: '999',
      ctx_size: '4096',
      n_predict: '48',
      temp: '0',
      seed: '42',
      'reasoning-budget': '0',
      'spec-type': 'draft-mtp',
      verbosity: '2',
      ...(draft ? { 'spec-draft-model': path.join(draft[1], draft[0]) } : {}),
      ...overrides
    },
    logger: console,
    opts: { stats: true }
  })
  await addon.load()
  t.teardown(async () => {
    await addon.unload().catch(() => {})
    specLogger.release()
  })
  return addon
}

safeTest('mtmd context: text turn drafts through the MTP head', { timeout: 600_000 }, async (t) => {
  const addon = await loadMtmdMtp(t)
  const response = await addon.run(TEXT_PROMPT)
  const output = await collectResponse(response)
  const stats = response.stats
  t.ok(output.length > 0, `text turn produced output (${output.length} chars)`)
  console.log(`  text output: "${output.slice(0, 200)}"`)
  t.ok(/paris/i.test(output), 'text output names the capital (Paris)')
  console.log(`  draftAccepted=${stats.draftAccepted} draftTotal=${stats.draftTotal}`)
  // The real signal: a text-only turn through the mtmd context drafts.
  t.ok(stats.draftTotal > 0, `MTP head drafted on a text turn (draftTotal=${stats.draftTotal})`)
  t.ok(
    stats.draftAccepted > 0,
    `target accepted MTP drafts on a text turn (draftAccepted=${stats.draftAccepted})`
  )
})

safeTest(
  'mtmd context: text turn drafts through a separate MTP head',
  { skip: platform === 'ios' || platform === 'android', timeout: 600_000 },
  async (t) => {
    const addon = await loadMtmdMtp(t, {
      model: GEMMA_MODEL,
      projectionModel: GEMMA_MMPROJ,
      draftModel: GEMMA_DRAFT_MODEL,
      overrides: { ctx_size: '1024' }
    })
    const response = await addon.run(TEXT_PROMPT)
    const output = await collectResponse(response)
    const stats = response.stats
    t.ok(output.length > 0, `separate-head text turn produced output (${output.length} chars)`)
    t.ok(/paris/i.test(output), 'separate-head text output names the capital (Paris)')
    t.ok(stats.draftTotal > 0, `separate head drafted tokens (draftTotal=${stats.draftTotal})`)
    t.ok(
      stats.draftAccepted > 0,
      `target accepted separate-head drafts (draftAccepted=${stats.draftAccepted})`
    )
  }
)

safeTest(
  'mtmd context: fresh addon restores MTP driver state at the cache boundary',
  { timeout: 600_000 },
  async (t) => {
    const [, dirPath] = await ensureModel({ modelName: MODEL.name })
    const cachePath = path.join(dirPath, 'mtp-mtmd-cache-cold-load.bin')
    t.teardown(() => cleanupIntegrationCacheFiles(mtpCacheFiles(cachePath)))

    const firstAddon = await loadMtmdMtp(t, { n_predict: '2' })
    const first = await firstAddon.run(TEXT_PROMPT, {
      cacheKey: cachePath,
      saveCacheToDisk: true
    })
    const firstOutput = await collectResponse(first)
    t.ok(firstOutput.length > 0, 'first mtmd addon wrote a populated MTP cache')
    t.ok(fs.statSync(`${cachePath}.mtp-state`).size > 0, 'mtmd persisted MTP driver state')
    await firstAddon.unload()

    const secondAddon = await loadMtmdMtp(t, { n_predict: '2' })
    const second = await secondAddon.run(TEXT_PROMPT, {
      cacheKey: cachePath,
      saveCacheToDisk: false
    })
    const secondOutput = await collectResponse(second)
    t.ok(secondOutput.length > 0, 'fresh mtmd addon used the persisted target cache')
    t.ok(second.stats.draftTotal > 0, 'fresh mtmd addon proposed a boundary draft')
    t.ok(
      second.stats.draftAccepted > 0,
      'fresh mtmd addon accepted a draft in the first and only verify round ' +
        `(draftAccepted=${second.stats.draftAccepted})`
    )
    await secondAddon.unload()
  }
)

safeTest('mtmd context: one-token MTP text turn commits to KV', { timeout: 600_000 }, async (t) => {
  const cachePath = path.join(os.tmpdir(), `qvac-mtp-mtmd-one-token-${Date.now()}.bin`)
  t.teardown(() => cleanupIntegrationCacheFiles(mtpCacheFiles(cachePath)))

  const addon = await loadMtmdMtp(t, { overrides: { n_predict: '1' } })
  const response = await addon.run(TEXT_PROMPT, { cacheKey: cachePath, saveCacheToDisk: true })
  const output = await collectResponse(response)
  const stats = response.stats
  t.ok(output.length > 0, `one-token text turn produced output (${output.length} chars)`)
  t.is(stats.generatedTokens, 1, 'one-token mtmd MTP turn reports exactly one generated token')
  t.ok(stats.CacheTokens > stats.promptTokens, 'one-token mtmd MTP turn committed the token to KV')
  t.is(stats.stopReason, 'predictionLimit', 'one-token mtmd MTP turn stops at the prediction limit')
})

safeTest(
  'mtmd context: image turn falls back to non-speculative decoding',
  { timeout: 600_000 },
  async (t) => {
    const addon = await loadMtmdMtp(t)
    const imageBytes = new Uint8Array(fs.readFileSync(getMediaPath('elephant.jpg')))
    const messages = [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', type: 'media', content: imageBytes },
      { role: 'user', content: 'Describe this image in one sentence.' }
    ]
    const response = await addon.run(messages)
    const output = await collectResponse(response)
    const stats = response.stats
    t.ok(output.length > 0, `image turn produced output (${output.length} chars)`)
    console.log(`  image output: "${output.slice(0, 200)}"`)
    console.log(`  draftAccepted=${stats.draftAccepted} draftTotal=${stats.draftTotal}`)
    // The vision prefill bypasses the draft context, so the image turn must
    // fall back to normal decoding: no drafting at all.
    t.is(stats.draftTotal, 0, 'image turn does not draft (fell back to normal decode)')
    t.is(stats.draftAccepted, 0, 'image turn accepted no drafts')
  }
)

safeTest(
  'mtmd context: text turn drafts again after an image fallback',
  { timeout: 600_000 },
  async (t) => {
    const addon = await loadMtmdMtp(t)
    const imageBytes = new Uint8Array(fs.readFileSync(getMediaPath('elephant.jpg')))
    const imageMessages = [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', type: 'media', content: imageBytes },
      { role: 'user', content: 'Describe this image in one sentence.' }
    ]

    const imageResponse = await addon.run(imageMessages)
    const imageOutput = await collectResponse(imageResponse)
    t.ok(imageOutput.length > 0, `image turn produced output (${imageOutput.length} chars)`)
    t.is(imageResponse.stats.draftTotal, 0, 'image turn falls back without drafting')

    const textResponse = await addon.run(TEXT_PROMPT)
    const textOutput = await collectResponse(textResponse)
    const textStats = textResponse.stats
    t.ok(textOutput.length > 0, `text turn produced output (${textOutput.length} chars)`)
    t.ok(/paris/i.test(textOutput), 'text turn still answers coherently after image fallback')
    t.ok(
      textStats.draftTotal > 0,
      `MTP drafts again after image fallback (draftTotal=${textStats.draftTotal})`
    )
    t.ok(
      textStats.draftAccepted > 0,
      `target accepts drafts after image fallback (draftAccepted=${textStats.draftAccepted})`
    )
  }
)

safeTest(
  'mtmd context: text prefill longer than the batch still drafts',
  { timeout: 600_000 },
  async (t) => {
    // Covers the mtmd text-chunk prefill loop in evalMessageWithTools, which
    // feeds the hoisted `specTextBatch` in sub-batches of
    // `specTextBatch.capacity() - 1`. Every other MTP test uses a prompt that
    // fits one sub-batch, so the loop runs a single iteration and the stepping
    // arithmetic is never exercised. `batch-size` is shrunk (rather than the
    // prompt inflated) so several iterations happen with a small, fast prompt
    // that stays well inside ctx_size on memory-constrained mobile GPUs.
    const addon = await loadMtmdMtp(t, {
      overrides: {
        ctx_size: '2048',
        'batch-size': '256',
        n_predict: '32'
      }
    })
    // ~600 tokens of filler — spans several 256-token sub-batches.
    const filler = Array.from(
      { length: 45 },
      (_, i) => `Note ${i + 1}: reference material about European geography and history.`
    ).join(' ')
    const messages = [
      { role: 'system', content: 'You are a helpful assistant.' },
      {
        role: 'user',
        content: `${filler}\n\nGiven all of the above, what is the capital of France? Answer in one complete sentence.`
      }
    ]
    const response = await addon.run(messages)
    const output = await collectResponse(response)
    const stats = response.stats
    t.ok(output.length > 0, `long text prefill produced output (${output.length} chars)`)
    console.log(
      `  long mtmd prefill: promptTokens=${stats.promptTokens}, ` +
        `draftAccepted=${stats.draftAccepted}, draftTotal=${stats.draftTotal}`
    )
    t.ok(
      stats.promptTokens > 256,
      `prompt spanned multiple sub-batches (promptTokens=${stats.promptTokens} > batch-size 256)`
    )
    t.ok(/paris/i.test(output), 'long text prefill output names the capital (Paris)')
    // A mis-stepped sub-batch loop would drop or duplicate prompt tokens (garbled
    // answer) or fail to seed the draft context across iterations (no drafting).
    t.ok(
      stats.draftAccepted > 0,
      `MTP still drafts after a multi-sub-batch text prefill (draftAccepted=${stats.draftAccepted})`
    )
  }
)
