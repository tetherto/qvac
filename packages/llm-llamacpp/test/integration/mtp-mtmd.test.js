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

const TEXT_PROMPT = [
  { role: 'system', content: 'You are a helpful assistant.' },
  { role: 'user', content: 'What is the capital of France? Answer in one complete sentence.' }
]

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

// `withSpec: false` OMITS the spec-type key rather than setting it to undefined
// — the non-speculative control arm must load exactly as a default config would.
async function loadMtmdMtp(t, { withSpec = true, ...overrides } = {}) {
  const [modelName, dirPath] = await ensureModel({ modelName: MODEL.name })
  const [projName, projDir] = await ensureModel({ modelName: MMPROJ.name })
  const specLogger = attachSpecLogger({ forwardToConsole: true })
  const config = {
    device: useCpu ? 'cpu' : 'gpu',
    gpu_layers: '999',
    ctx_size: '4096',
    n_predict: '48',
    temp: '0',
    seed: '42',
    'reasoning-budget': '0',
    verbosity: '2',
    ...overrides
  }
  if (withSpec) {
    config['spec-type'] = 'draft-mtp'
  }
  const addon = new LlmLlamacpp({
    files: {
      model: [path.join(dirPath, modelName)],
      projectionModel: path.join(projDir, projName)
    },
    config,
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
      ctx_size: '2048',
      'batch-size': '256',
      n_predict: '32'
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

safeTest(
  'mtmd context: MTP output matches the non-speculative output token-for-token',
  { timeout: 600_000 },
  async (t) => {
    // mtp.test.js pins greedy equivalence for TextLlmContext only. The mtmd path
    // has its own position accounting (specSetPos / advanceTextSpan, where
    // cacheTokens can exceed pos because M-RoPE media occupies more KV cells than
    // positions), so an accept-loop or position bug specific to MtmdLlmContext —
    // committing the wrong token, an off-by-one accepted prefix, a mis-rolled-back
    // rejected tail — would still emit fluent text containing "Paris" and pass
    // every other assertion in this file.
    //
    // KNOWN CAVEAT (same as mtp.test.js): llama.cpp logits are not bit-identical
    // across batch shapes, since the verify batch decodes N+1 positions at once
    // while the non-spec path decodes one at a time. An exact greedy tie could in
    // principle break differently. TEXT_PROMPT is a short, high-confidence factual
    // answer chosen to make that vanishingly unlikely. If this ever flakes, that
    // is why — and the fix is a lower-variance prompt, NOT deleting the assertion.
    const specAddon = await loadMtmdMtp(t, { withSpec: true })
    const specResp = await specAddon.run(TEXT_PROMPT)
    const specOutput = await collectResponse(specResp)

    const plainAddon = await loadMtmdMtp(t, { withSpec: false })
    const plainResp = await plainAddon.run(TEXT_PROMPT)
    const plainOutput = await collectResponse(plainResp)

    console.log(`  spec    : "${specOutput}"`)
    console.log(`  non-spec: "${plainOutput}"`)

    t.ok(specOutput.length > 0, 'speculative mtmd run produced output')
    t.is(
      specOutput,
      plainOutput,
      'mtmd MTP produces byte-identical output to non-speculative decoding at temp=0'
    )
    // Positive + negative control in one test: speculation demonstrably ran on one
    // side and demonstrably did not on the other, so the zero below cannot be a
    // silent config-key regression.
    t.ok(
      specResp.stats.draftTotal > 0,
      `speculative mtmd run really did draft (draftTotal=${specResp.stats.draftTotal})`
    )
    t.is(plainResp.stats.draftTotal, 0, 'non-speculative mtmd run drafted nothing (draftTotal=0)')
  }
)

safeTest(
  'mtmd context: an image turn disables speculation for the rest of the session',
  { timeout: 600_000 },
  async (t) => {
    // The disable is SESSION-SCOPED AND PERMANENT, not per-turn. MtmdLlmContext's
    // image branch does `spec_.reset(); ctxDraft_.reset()` because the vision
    // decode bypasses the MTP draft context and leaves it misaligned — so every
    // later turn on this context decodes non-speculatively too, even a pure text
    // one that would otherwise draft happily.
    //
    // The existing image test above only covers the image turn itself. Without
    // this, a change that re-armed speculation after an image (or moved the reset)
    // would silently resume drafting against a misaligned draft cache.
    //
    // Scope note: this covers the IN-PROCESS path only. Media and live
    // speculation CAN coexist on one context via `loadCache`, which restores a
    // media-bearing cache and calls only `rollbackDraftContext()` — never
    // resetting `spec_`. That is why `specSetPos` must keep its delta form (see
    // MtmdLlmContext.hpp); an earlier version of this comment claimed the
    // media-KV accounting path was unreachable, which is wrong for restores.
    const addon = await loadMtmdMtp(t)

    // Turn 1, text only: positive control. If this is 0 the premise is wrong and
    // the two zeros below prove nothing.
    const firstResp = await addon.run(TEXT_PROMPT)
    const firstOutput = await collectResponse(firstResp)
    console.log(`  turn 1 (text) : draftTotal=${firstResp.stats.draftTotal}`)
    t.ok(firstOutput.length > 0, 'turn 1 (text) produced output')
    t.ok(
      firstResp.stats.draftTotal > 0,
      `turn 1 (text) drafts, proving speculation was live (draftTotal=${firstResp.stats.draftTotal})`
    )

    // Turn 2: the image tears the draft context down.
    const imageBytes = new Uint8Array(fs.readFileSync(getMediaPath('elephant.jpg')))
    const imageResp = await addon.run([
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', type: 'media', content: imageBytes },
      { role: 'user', content: 'Describe this image in one sentence.' }
    ])
    const imageOutput = await collectResponse(imageResp)
    console.log(`  turn 2 (image): draftTotal=${imageResp.stats.draftTotal}`)
    t.ok(imageOutput.length > 0, 'turn 2 (image) produced output')
    t.is(imageResp.stats.draftTotal, 0, 'turn 2 (image) does not draft')

    // Turn 3, text again: THE GAP. Speculation must stay off.
    const thirdResp = await addon.run(TEXT_PROMPT)
    const thirdOutput = await collectResponse(thirdResp)
    console.log(`  turn 3 (text) : draftTotal=${thirdResp.stats.draftTotal}`)
    // Asserted separately from draftTotal so a broken session is distinguishable
    // from a merely non-speculative one.
    t.ok(thirdOutput.length > 0, 'turn 3 (text) still produces output after the image turn')
    t.ok(/paris/i.test(thirdOutput), 'turn 3 (text) output is coherent (names the capital)')
    t.is(
      thirdResp.stats.draftTotal,
      0,
      'turn 3 (text) stays non-speculative — the image disabled MTP for the whole session'
    )
  }
)

safeTest(
  'mtmd context: a text turn on a restored media cache keeps the KV surplus',
  { timeout: 900_000 },
  async (t) => {
    // Regression guard for specSetPos's KV accounting, and proof the path is
    // REACHABLE — an earlier comment in this file wrongly claimed it was not.
    //
    // Under M-RoPE an image occupies MORE KV cells than positions, so
    // `cacheTokens > pos`. In-process that surplus never meets live speculation:
    // the image branch does `spec_.reset(); ctxDraft_.reset()`. But `loadCache`
    // restores the surplus and calls only `rollbackDraftContext()`, which never
    // resets `spec_` — so a FRESH context loading a media-bearing cache and
    // running a TEXT-only turn drafts with the surplus present. Verified: that
    // turn reports draftTotal > 0 while CacheTokens greatly exceeds the prompt.
    //
    // specSetPos used to assign `cacheTokens = pos`, collapsing the surplus.
    // What this test detects is the second-order consequence: saveCache persists
    // the understated value, and the NEXT loadCache hard-throws
    // UnableToLoadSessionFile on its `restoredCacheTokens != getCacheTokens()`
    // check — the cache file becomes permanently unloadable. Hence three phases.
    const [, dirPath] = await ensureModel({ modelName: MODEL.name })
    const cachePath = path.join(dirPath, 'mtp-mtmd-media-surplus.bin')
    t.teardown(() => cleanupIntegrationCacheFiles(cachePath))
    const runOpts = { cacheKey: cachePath, saveCacheToDisk: true }
    const imageBytes = new Uint8Array(fs.readFileSync(getMediaPath('elephant.jpg')))

    // Phase 1 — image turn writes a cache carrying the media surplus.
    const a = await loadMtmdMtp(t)
    const ra = await a.run(
      [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', type: 'media', content: imageBytes },
        { role: 'user', content: 'Describe this image in one sentence.' }
      ],
      runOpts
    )
    const outA = await collectResponse(ra)
    t.ok(outA.length > 0, 'phase 1 (image) produced output')
    t.ok(
      ra.stats.CacheTokens > 0,
      `phase 1 wrote a media cache (CacheTokens=${ra.stats.CacheTokens})`
    )
    await a.unload()

    // Phase 2 — FRESH context (spec_ alive) loads that cache and runs a
    // text-only turn, so specSetPos executes with cacheTokens > pos.
    const b = await loadMtmdMtp(t)
    const rb = await b.run(TEXT_PROMPT, runOpts)
    const outB = await collectResponse(rb)
    t.ok(outB.length > 0, 'phase 2 (text on restored media cache) produced output')
    console.log(
      `  phase 2: CacheTokens=${rb.stats.CacheTokens} promptTokens=${rb.stats.promptTokens} ` +
        `draftTotal=${rb.stats.draftTotal}`
    )
    // Positive control: without this the phase-3 check proves nothing, because
    // specSetPos would never have run.
    t.ok(
      rb.stats.draftTotal > 0,
      `phase 2 really drafted, so specSetPos ran with the surplus live (draftTotal=${rb.stats.draftTotal})`
    )
    t.ok(
      rb.stats.CacheTokens > rb.stats.promptTokens,
      `phase 2 kept a KV surplus over its own prompt ` +
        `(CacheTokens=${rb.stats.CacheTokens} > promptTokens=${rb.stats.promptTokens})`
    )
    await b.unload()

    // Phase 3 — the assertion that catches the bug. With the absolute assign,
    // phase 2 persisted a collapsed cacheTokens and this load throws.
    const c = await loadMtmdMtp(t)
    const rc = await c.run(TEXT_PROMPT, runOpts)
    const outC = await collectResponse(rc)
    t.ok(
      outC.length > 0,
      'phase 3 reloaded the cache written after a speculative turn without throwing'
    )
    t.ok(
      rc.stats.CacheTokens > 0,
      `phase 3 cache still valid (CacheTokens=${rc.stats.CacheTokens})`
    )
  }
)

safeTest(
  'mtmd context: a media surplus exhausting KV stops gracefully, not FailedToDecode',
  { timeout: 900_000 },
  async (t) => {
    // Preserving the media surplus (previous test) is necessary but not
    // sufficient: something has to READ it. The speculative loop's budget checks
    // were positional-only, so with `cacheTokens > pos` the physical KV could run
    // out while `specPos() + 1 > specCtxCeiling()` still passed — llama_decode
    // then finds no free cell and the loop throws FailedToDecode, where the
    // non-speculative path stops gracefully with ContextOverflow.
    //
    // `specBudgetUsed()` now gates on max(position, KV cells), matching what the
    // non-speculative Mtmd loops and ContextSlider already do.
    //
    // Setup: a small ctx makes the surplus dominate. The image commits ~287 cells
    // against ctx_size 512, so a long text turn on the restored cache exhausts
    // cells while `pos` stays far below 512. Verified against the unfixed build:
    // this run raised "[LlmContext] failed to decode speculative batch"; with the
    // fix it raises the graceful "context overflow".
    const [, dirPath] = await ensureModel({ modelName: MODEL.name })
    const cachePath = path.join(dirPath, 'mtp-mtmd-surplus-exhaustion.bin')
    t.teardown(() => cleanupIntegrationCacheFiles(cachePath))
    const runOpts = { cacheKey: cachePath, saveCacheToDisk: true }
    const imageBytes = new Uint8Array(fs.readFileSync(getMediaPath('elephant.jpg')))

    const a = await loadMtmdMtp(t, { ctx_size: '512', n_predict: '24' })
    const ra = await a.run(
      [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', type: 'media', content: imageBytes },
        { role: 'user', content: 'Describe this image in one sentence.' }
      ],
      runOpts
    )
    await collectResponse(ra)
    t.ok(
      ra.stats.CacheTokens > 0,
      `phase 1 wrote a media cache (CacheTokens=${ra.stats.CacheTokens})`
    )
    await a.unload()

    // Fresh context: spec_ is live across the load, surplus restored.
    const b = await loadMtmdMtp(t, { ctx_size: '512', n_predict: '400' })
    let threw = null
    let stats = null
    try {
      const rb = await b.run(
        [
          { role: 'system', content: 'You are a helpful assistant.' },
          {
            role: 'user',
            content:
              'Explain in as much detail as you can, over many sentences, how quantization reduces the memory footprint of a neural network and what trade-offs it introduces.'
          }
        ],
        runOpts
      )
      await collectResponse(rb)
      stats = rb.stats
    } catch (err) {
      threw = err && err.message ? err.message : String(err)
    }
    console.log(`  phase 2: threw=${threw} stopReason=${stats && stats.stopReason}`)

    // The assertion: whichever way it ends, it must NOT be the hard decode
    // failure. A graceful ContextOverflow, or completing under the budget, are
    // both acceptable outcomes; FailedToDecode is not.
    t.absent(
      threw !== null && /failed to decode/i.test(threw),
      `long text turn on a restored media cache did not hard-fail (${threw || 'no throw'})`
    )
  }
)
