'use strict'

// MTP (Multi-Token Prediction) speculative-decoding integration test.
//
// Uses a Qwen3.5-0.8B GGUF that BUNDLES the next-n / MTP head (blk.24.nextn.*),
// so spec-type=draft-mtp builds a real LLAMA_CONTEXT_TYPE_MTP draft context over
// the same model and the draft/verify/accept loop actually fires. The standard
// unsloth Qwen3.5 GGUF omits the MTP head, which is why a draft-mtp run against
// it is silently inert — this test guards against that by asserting a real
// speculative signal (stats.draftAccepted > 0), not just coherent output.
//
// Tests use `safeTest` + `attachSpecLogger` (not plain brittle `test`): these
// files are routed to the Device Farm mobile groups, where a thrown native
// error would otherwise abort the whole shard, and attachSpecLogger is the only
// path that captures the native QLOG_IF diagnostics (the MTP fallback/warning
// lines) into the test log.

const path = require('bare-path')
const LlmLlamacpp = require('../../index.js')
const { ensureModel, safeTest, cleanupIntegrationCacheFiles } = require('./utils')
const { attachSpecLogger } = require('./spec-logger')
const os = require('bare-os')

const platform = os.platform()
const arch = os.arch()
const isDarwinX64 = platform === 'darwin' && arch === 'x64'
const isLinuxArm64 = platform === 'linux' && arch === 'arm64'
const useCpu = isDarwinX64 || isLinuxArm64

// Qwen3.5-0.8B with the MTP/nextn head bundled in the single model GGUF — the
// self-speculative model this addon's draft-mtp path supports.
// `url` is required so scripts/generate-model-manifest.js stages this model for
// the Device Farm mobile groups (pinned to match test/integration/models.manifest.json).
const MODEL = {
  name: 'Qwen3.5-0.8B-MTP-Q8_0.gguf',
  url: 'https://huggingface.co/prithivMLmods/Qwen3.5-0.8B-MTP-GGUF/resolve/e84039e503be9c81c5bfe3f0b0d00a7636894d9d/Qwen3.5-0.8B.Q8_0.gguf'
}

// Gemma-4 E2B: a real multimodal model WITHOUT a bundled MTP (nextn) head.
// Gemma-4 ships its MTP as a separate `-assistant` draft model (llama.cpp's
// two-file `-m base --spec-draft-model draft` workflow), which this addon's
// single-file self-MTP loader does not use. So spec-type=draft-mtp must stay
// INERT here (draftTotal === 0) while generation still succeeds
// non-speculatively — the graceful-fallback contract for a model with no head.
// `url` (pinned, matches models.manifest.json) so it is staged on mobile too.
const GEMMA_MODEL = {
  name: 'google_gemma-4-E2B-it-Q4_K_M.gguf',
  url: 'https://huggingface.co/bartowski/google_gemma-4-E2B-it-GGUF/resolve/b5e99bd964eaacc27ba484bb2eb3e9f6160b9143/google_gemma-4-E2B-it-Q4_K_M.gguf'
}

const PROMPT = [
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

function baseConfig(overrides = {}) {
  return {
    device: useCpu ? 'cpu' : 'gpu',
    gpu_layers: '999',
    ctx_size: '1024',
    n_predict: '64',
    temp: '0',
    seed: '42',
    'reasoning-budget': '0',
    verbosity: '2',
    ...overrides
  }
}

// Create + load an addon and register its teardown (unload + release the native
// log sink) on the test. Returns the loaded addon so a test can drive multiple
// run() calls against a single context (needed to exercise the between-request
// reset / cache-reuse paths where the ctxDraft_ rollback lives).
async function loadAddon(t, { model = MODEL, withSpec = true, overrides = {} } = {}) {
  const [modelName, dirPath] = await ensureModel({ modelName: model.name })
  const modelPath = path.join(dirPath, modelName)

  const config = baseConfig(overrides)
  if (withSpec) {
    config['spec-type'] = 'draft-mtp'
  }

  const specLogger = attachSpecLogger({ forwardToConsole: true })
  const addon = new LlmLlamacpp({
    files: { model: [modelPath] },
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

async function runOnce(t, opts = {}) {
  const addon = await loadAddon(t, opts)
  const response = await addon.run(PROMPT, opts.runOptions)
  const output = await collectResponse(response)
  return { output, stats: response.stats }
}

safeTest(
  'Qwen3.5-0.8B with spec-type=draft-mtp drafts + accepts',
  { timeout: 600_000 },
  async (t) => {
    const { output, stats } = await runOnce(t, { withSpec: true })
    t.ok(output.length > 0, `spec run produced output (${output.length} chars)`)
    console.log(`  spec output: "${output.slice(0, 200)}"`)
    t.ok(stats, 'spec run has response.stats')
    t.ok(/paris/i.test(output), 'spec output names the capital (Paris) in the reply')
    // The real speculative signal: the MTP head must have drafted tokens that the
    // target model verified and accepted. Without this assertion the test would
    // pass even if draft-mtp were inert (no draft context, no acceptance).
    console.log(`  draftAccepted=${stats.draftAccepted} draftTotal=${stats.draftTotal}`)
    t.ok(stats.draftTotal > 0, `MTP head produced draft tokens (draftTotal=${stats.draftTotal})`)
    t.ok(
      stats.draftAccepted > 0,
      `target accepted MTP draft tokens (draftAccepted=${stats.draftAccepted})`
    )
  }
)

safeTest('Qwen3.5-0.8B without spec-type', { timeout: 600_000 }, async (t) => {
  // Sentinel: confirms the addon's existing single-context path still works,
  // proving the MTP code added to TextLlmContext is correctly gated behind
  // the `spec-type` config check and doesn't fire for default-config loads.
  const { output, stats } = await runOnce(t, { withSpec: false })
  t.ok(output.length > 0, `non-spec run produced output (${output.length} chars)`)
  t.ok(stats, 'non-spec run has stats')
  t.ok(/paris/i.test(output), 'non-spec output names the capital (Paris) in the reply')
  t.is(stats.draftAccepted, 0, 'non-spec run performs no speculative drafting (draftAccepted=0)')
})

safeTest(
  'Gemma-4 E2B with spec-type=draft-mtp stays inert (no bundled MTP head)',
  { timeout: 600_000 },
  async (t) => {
    // Gemma-4 has no bundled nextn head, so the draft context can't be built and
    // draft-mtp must degrade to plain decoding: coherent output, zero drafts, no
    // crash. This guards the "spec-type requested on a model without an MTP head
    // -> gracefully non-speculative" contract (and documents that Gemma-4's MTP
    // assistant is a separate draft model this loader doesn't consume).
    const { output, stats } = await runOnce(t, { model: GEMMA_MODEL, withSpec: true })
    t.ok(output.length > 0, `Gemma-4 fallback run produced output (${output.length} chars)`)
    console.log(`  gemma fallback output: "${output.slice(0, 200)}"`)
    console.log(`  draftAccepted=${stats.draftAccepted} draftTotal=${stats.draftTotal}`)
    t.is(stats.draftTotal, 0, 'no MTP head -> no drafts proposed (draftTotal=0)')
    t.is(stats.draftAccepted, 0, 'no MTP head -> nothing accepted (draftAccepted=0)')
    t.ok(/paris/i.test(output), 'Gemma-4 still names the capital running non-speculatively')
  }
)

safeTest(
  'Qwen3.5-0.8B MTP with reasoning enabled stays coherent + balanced',
  { timeout: 600_000 },
  async (t) => {
    const { output, stats } = await runOnce(t, {
      withSpec: true,
      overrides: { 'reasoning-budget': '32', n_predict: '200' }
    })
    t.ok(output.length > 0, `produced output (${output.length} chars)`)
    console.log(`  reasoning+spec output: "${output.slice(0, 200)}"`)
    t.ok(
      stats.draftAccepted > 0,
      `MTP still drafts with reasoning on (draftAccepted=${stats.draftAccepted})`
    )

    if (output.includes('<think>')) {
      t.ok(output.includes('</think>'), 'reasoning block closed (balanced tags)')
      // The reasoning-recovery EOG ban must leave a non-empty answer AFTER the
      // close marker — the failure mode of the spec-path bug was an empty reply.
      const afterThink = output.split('</think>').pop().trim()
      t.ok(afterThink.length > 0, 'non-empty answer follows the reasoning block')
    }
    t.ok(/paris/i.test(output), 'output still names the capital after reasoning')
  }
)

safeTest(
  'Qwen3.5-0.8B MTP honors a small n_predict without over-committing KV',
  { timeout: 600_000 },
  async (t) => {
    const addon = await loadAddon(t, { withSpec: true, overrides: { n_predict: '4' } })
    const response = await addon.run(PROMPT)
    const output = await collectResponse(response)
    const stats = response.stats
    const nPredict = 4
    t.ok(output.length > 0, `produced output (${output.length} chars)`)
    console.log(
      `  short output: "${output.slice(0, 120)}" ` +
        `draftAccepted=${stats.draftAccepted} draftTotal=${stats.draftTotal}`
    )
    t.ok(
      stats.draftAccepted <= nPredict,
      'accepted drafts bounded by the budget, no over-committed tail ' +
        `(draftAccepted=${stats.draftAccepted} <= n_predict=${nPredict})`
    )
    // Regression guard for the spec-path stopReason: a budget cutoff (n_predict
    // reached, not EOS) must report 'predictionLimit'. The Text spec path used
    // to leave it 'none' because the non-spec reset runs after the spec branch —
    // which also skipped the mid-<think> recurrent-rollback that keys off it.
    t.is(
      stats.stopReason,
      'predictionLimit',
      `budget cutoff reports predictionLimit on the spec path (got '${stats.stopReason}')`
    )
  }
)

safeTest(
  'Qwen3.5-0.8B MTP slides past the context ceiling without FailedToDecode',
  { timeout: 600_000 },
  async (t) => {
    // Tiny ctx_size + a prompt that greedily generates far more tokens than fit
    // (counting won't EOS early) + a slide budget (n_discarded > 0) forces the
    // generation to repeatedly SLIDE at the context ceiling. This is the exact
    // scenario the feedback doc flagged: the spec path "hard-errors at the
    // boundary instead of gracefully sliding". A boundary round where headroom <
    // draft length would build a verify batch past specCtxCeiling() and
    // llama_decode would hard-fail (FailedToDecode) — the MTP drafter ignores
    // the per-round dp.n_max hint, so only the explicit draft-truncation-to-
    // headroom prevents it. With the fix the run slides and completes (safeTest
    // turns any throw into a t.fail). Without a slide budget the ceiling is a
    // designed ContextOverflow throw, so n_discarded is required to hit the
    // slide path rather than the overflow path.
    const addon = await loadAddon(t, {
      withSpec: true,
      overrides: { ctx_size: '128', n_predict: '400', n_discarded: '48' }
    })
    const longPrompt = [
      { role: 'system', content: 'You are a helpful assistant.' },
      {
        role: 'user',
        content: 'Count from 1 to 300, writing each number on its own line in words.'
      }
    ]
    const response = await addon.run(longPrompt)
    const output = await collectResponse(response)
    const stats = response.stats
    t.ok(output.length > 0, `slide run completed with output (${output.length} chars)`)
    console.log(
      `  near-ceiling slide: ${output.length} chars, generatedTokens=${stats.generatedTokens}, ` +
        `contextSlides=${stats.contextSlides}, draftTotal=${stats.draftTotal}, ` +
        `stopReason=${stats.stopReason}`
    )
    t.ok(stats.draftTotal > 0, 'MTP still drafted while sliding at the ceiling')
    // The real regression signal: the generation crossed the ceiling and slid
    // (>=1 slide) instead of throwing FailedToDecode at a boundary round.
    t.ok(
      stats.contextSlides > 0,
      `generation slid past the context ceiling (contextSlides=${stats.contextSlides})`
    )
  }
)

safeTest(
  'Qwen3.5-0.8B MTP stays consistent across sequential requests on one context',
  { timeout: 600_000 },
  async (t) => {
    // Two back-to-back generations on the SAME loaded addon. Between requests the
    // context runs resetState / removeLastNTokens, which must also roll back the
    // MTP draft context (ctxDraft_) — otherwise the draft cache diverges from the
    // target and the second run silently stops drafting. Assert both runs draft.
    const addon = await loadAddon(t, { withSpec: true })

    const r1 = await addon.run(PROMPT)
    const out1 = await collectResponse(r1)
    const s1 = r1.stats
    t.ok(
      out1.length > 0 && s1.draftAccepted > 0,
      `run 1 drafted (draftAccepted=${s1.draftAccepted})`
    )

    const r2 = await addon.run(PROMPT)
    const out2 = await collectResponse(r2)
    const s2 = r2.stats
    t.ok(out2.length > 0, `run 2 produced output (${out2.length} chars)`)
    t.ok(
      s2.draftAccepted > 0,
      `run 2 still drafts after the between-request reset (draftAccepted=${s2.draftAccepted})`
    )
  }
)

safeTest(
  'Qwen3.5-0.8B MTP still drafts after a cache save/load round-trip',
  { timeout: 600_000 },
  async (t) => {
    // Exercises the loadCache path with MTP active: a cache save/load restores
    // only the target KV, so loadCache must clear the (unpersisted) draft context
    // to keep it from diverging. Re-running with the same cacheKey loads the
    // saved cache; MTP must survive the load and keep drafting.
    //
    // cacheKey must be an ABSOLUTE .bin path (the addon writes the cache file
    // there, and cleanupIntegrationCacheFiles rejects relative paths) — mirrors
    // cache-state-machine.test.js's `path.join(dirPath, '<name>.bin')`.
    const [, dirPath] = await ensureModel({ modelName: MODEL.name })
    const cachePath = path.join(dirPath, 'mtp-cache-roundtrip.bin')
    t.teardown(() => cleanupIntegrationCacheFiles(cachePath))

    const addon = await loadAddon(t, { withSpec: true })
    const runOpts = { cacheKey: cachePath, saveCacheToDisk: true }

    const r1 = await addon.run(PROMPT, runOpts)
    const out1 = await collectResponse(r1)
    t.ok(out1.length > 0 && r1.stats.CacheTokens > 0, 'run 1 wrote a cache (CacheTokens > 0)')

    const r2 = await addon.run(PROMPT, runOpts)
    const out2 = await collectResponse(r2)
    const s2 = r2.stats
    t.ok(out2.length > 0, `cache-reusing run produced output (${out2.length} chars)`)
    console.log(
      `  after cache reuse: draftAccepted=${s2.draftAccepted} draftTotal=${s2.draftTotal}`
    )
    t.ok(s2.draftTotal > 0, 'MTP still drafts after the cache load (draft context re-seeded)')
  }
)

safeTest(
  'Qwen3.5-0.8B MTP still drafts on a long multi-ubatch prompt',
  { timeout: 600_000 },
  async (t) => {
    // Prefill-side coverage for the logits-marking removal in
    // decodeAndSpecProcess. A prompt well past the default n_ubatch (512) is
    // split into several internal ubatches, only the last of which carries the
    // single output-marked row. The MTP hidden-state capture must still work for
    // the whole prompt (the target runs unmasked nextn, so extraction is
    // per-ubatch-position, not per output mark) — if it did not, the draft
    // context would be seeded with garbage and acceptance would collapse. Short
    // prompts (all other tests) fit one ubatch and cannot catch that.
    // Sized deliberately modestly: the coverage only needs the prompt to exceed
    // n_ubatch (512) so the prefill spans several ubatches. MTP holds a second
    // context over the same model, so KV roughly doubles — keeping ctx_size at
    // 2048 (not 4096) keeps this runnable on memory-constrained mobile GPUs.
    const addon = await loadAddon(t, {
      withSpec: true,
      overrides: { ctx_size: '2048', n_predict: '32' }
    })
    // ~800 tokens of filler — comfortably past n_ubatch, well inside ctx_size.
    const filler = Array.from(
      { length: 60 },
      (_, i) => `Note ${i + 1}: reference material about European geography, history, and culture.`
    ).join(' ')
    const longPrompt = [
      { role: 'system', content: 'You are a helpful assistant.' },
      {
        role: 'user',
        content: `${filler}\n\nGiven all of the above, what is the capital of France? Answer in one complete sentence.`
      }
    ]
    const response = await addon.run(longPrompt)
    const output = await collectResponse(response)
    const stats = response.stats
    t.ok(output.length > 0, `long-prompt run produced output (${output.length} chars)`)
    console.log(
      `  long prompt: promptTokens=${stats.promptTokens}, draftAccepted=${stats.draftAccepted}, ` +
        `draftTotal=${stats.draftTotal}`
    )
    t.ok(
      stats.promptTokens > 512,
      `prompt spanned multiple ubatches (promptTokens=${stats.promptTokens} > 512)`
    )
    t.ok(/paris/i.test(output), 'long-prompt output names the capital (Paris)')
    t.ok(
      stats.draftAccepted > 0,
      `MTP drafts accepted after a multi-ubatch prefill (draftAccepted=${stats.draftAccepted})`
    )
  }
)

safeTest(
  'Qwen3.5-0.8B MTP drafts on the turn after a prefill-only request',
  { timeout: 600_000 },
  async (t) => {
    // A prefill-only request marks NO output row at all, so it is the strongest
    // case for the capture question above: if prefill decoding failed to feed the
    // draft context, the following generation would draft against a stale/garbage
    // draft cache and acceptance would drop to zero.
    const addon = await loadAddon(t, { withSpec: true })
    const prefillResp = await addon.run(PROMPT, { prefill: true })
    await collectResponse(prefillResp)
    t.ok(true, 'prefill-only request completed')

    const response = await addon.run(PROMPT)
    const output = await collectResponse(response)
    const stats = response.stats
    t.ok(output.length > 0, `follow-up generation produced output (${output.length} chars)`)
    console.log(
      `  after prefill: draftAccepted=${stats.draftAccepted} draftTotal=${stats.draftTotal}`
    )
    t.ok(
      stats.draftAccepted > 0,
      `MTP still drafts after a prefill-only turn (draftAccepted=${stats.draftAccepted})`
    )
  }
)
