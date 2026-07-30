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
const isMobile = platform === 'ios' || platform === 'android'
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
//
// DESKTOP ONLY (see the `skip: isMobile` on the test below). Deliberately no
// `url` here: scripts/generate-model-manifest.js discovers mobile staging
// models by regex-scanning these files for `{ name, url }` pairs, so omitting
// the url keeps this 3.3 GB model out of the Device Farm payload for
// runMtpTest. Desktop is unaffected — ensureModel() resolves the download URL
// (and sha256/bytes) exclusively from test/integration/models.manifest.json,
// where this model is already pinned.
//
// Why excluded from mobile: mmap of the 3.3 GB mapping intermittently fails
// with ENOMEM on smaller iOS devices (observed on Apple iPhone 16:
// `llama_model_load: error loading model: mmap failed: Cannot allocate
// memory`), which reddens whichever suite happens to load it. The head-less
// fallback contract is architecture-level, not device-specific, so desktop
// coverage is sufficient. Re-enable on mobile once a smaller quant is staged.
const GEMMA_MODEL = {
  name: 'google_gemma-4-E2B-it-Q4_K_M.gguf'
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
    // Acceptance RATE, not just "> 0". draftAccepted > 0 passes even if the
    // drafter is mostly wrong, which is the failure mode that silently erases
    // MTP's benefit: every rejected draft costs a wasted draft forward pass, so
    // a drafter accepted ~10% of the time is slower than not speculating at
    // all. This is the deterministic, hardware-independent signal that MTP is
    // doing its job (temp=0 + fixed seed), so it is the right thing to gate on
    // — unlike throughput, which is far too runner-dependent to assert here.
    // Floor is deliberately well under what this model/prompt actually
    // achieves (observed 5/6 ~= 0.83 on linux-arm64) to leave room for
    // backend-to-backend numerical variation; raise it once there is data
    // across all platforms.
    const acceptRate = stats.draftAccepted / stats.draftTotal
    console.log(`  acceptance rate=${acceptRate.toFixed(2)}`)
    t.ok(
      acceptRate >= 0.25,
      `MTP acceptance rate is high enough to be a win (${stats.draftAccepted}/${stats.draftTotal} = ${acceptRate.toFixed(2)}, floor 0.25)`
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
  'Qwen3.5-0.8B MTP output matches the non-speculative output token-for-token',
  { timeout: 600_000 },
  async (t) => {
    // The defining guarantee of speculative decoding: the target verifies every
    // drafted token, so with greedy sampling (temp=0, fixed seed) enabling
    // spec-type must not change a single character of the answer. It is purely
    // a speed optimisation.
    //
    // This is the assertion the rest of the suite was missing. The spec/non-spec
    // tests above each only check their own output matches /paris/i, so an
    // accept-loop bug — committing the wrong token, an off-by-one in the
    // accepted prefix, a mis-rolled-back rejected tail — would still emit
    // fluent text containing "Paris" and pass everything. Only a direct
    // comparison catches that class.
    //
    // Both configs also run here in ONE test, giving the `draftTotal === 0`
    // negative check a positive control in the same test body: if `spec-type`
    // silently stopped being read (a config-key regression), the zero would no
    // longer look like correct gating because the paired run would be zero too.
    //
    // KNOWN CAVEAT: llama.cpp logits are not bit-identical across different
    // batch shapes (the verify batch decodes N+1 positions at once, the
    // non-spec path decodes one at a time), so an exact greedy tie could in
    // principle break the tie differently and diverge. PROMPT is a short,
    // high-confidence factual answer chosen to make that vanishingly unlikely.
    // If this ever flakes, that is the reason — and the fix is a lower-variance
    // prompt, NOT deleting the assertion.
    const specAddon = await loadAddon(t, { withSpec: true })
    const specResp = await specAddon.run(PROMPT)
    const specOutput = await collectResponse(specResp)

    const plainAddon = await loadAddon(t, { withSpec: false })
    const plainResp = await plainAddon.run(PROMPT)
    const plainOutput = await collectResponse(plainResp)

    console.log(`  spec    : "${specOutput}"`)
    console.log(`  non-spec: "${plainOutput}"`)
    console.log(
      `  spec drafted ${specResp.stats.draftAccepted}/${specResp.stats.draftTotal}, non-spec drafted ${plainResp.stats.draftTotal}`
    )

    t.ok(specOutput.length > 0, 'speculative run produced output')
    t.is(
      specOutput,
      plainOutput,
      'MTP produces byte-identical output to non-speculative decoding at temp=0'
    )
    // Positive + negative control, same test: speculation demonstrably ran on
    // one side and demonstrably did not on the other.
    t.ok(
      specResp.stats.draftTotal > 0,
      `speculative run really did draft (draftTotal=${specResp.stats.draftTotal})`
    )
    t.is(plainResp.stats.draftTotal, 0, 'non-speculative run drafted nothing (draftTotal=0)')
  }
)

safeTest(
  'Gemma-4 E2B with spec-type=draft-mtp stays inert (no bundled MTP head)',
  // Desktop only: the 3.3 GB Gemma-4 mapping intermittently fails to mmap on
  // memory-constrained mobile devices (see GEMMA_MODEL above). The contract
  // under test is architecture-level, so desktop coverage suffices.
  { skip: isMobile, timeout: 600_000 },
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
    const prefillOutput = await collectResponse(prefillResp)
    t.is(prefillOutput.length, 0, 'prefill-only request emits no generated text')
    t.is(prefillResp.stats.generatedTokens, 0, 'prefill-only request generates no tokens')

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

safeTest(
  'Qwen3.5-0.8B MTP draft counters do not echo the previous generation on prefill',
  { timeout: 600_000 },
  async (t) => {
    // The context resets draftAccepted/draftTotal at generateResponse entry,
    // which a prefill-only request never reaches — so without an explicit
    // wasPrefill guard in singleRuntimeStatsLocked the prefill turn reports the
    // PREVIOUS generation's counters, contradicting the index.d.ts contract.
    // Generate first so the counters are non-zero, then prefill and require
    // zeros.
    const addon = await loadAddon(t, { withSpec: true })

    const genResp = await addon.run(PROMPT)
    await collectResponse(genResp)
    t.ok(
      genResp.stats.draftTotal > 0,
      `generation drafted, so the counters are non-zero to begin with (draftTotal=${genResp.stats.draftTotal})`
    )

    const prefillResp = await addon.run(PROMPT, { prefill: true })
    await collectResponse(prefillResp)
    t.is(
      prefillResp.stats.draftAccepted,
      0,
      'prefill-only request reports draftAccepted=0, not the previous generation value'
    )
    t.is(
      prefillResp.stats.draftTotal,
      0,
      'prefill-only request reports draftTotal=0, not the previous generation value'
    )
  }
)

// Distinguish a cancellation surfaced as an error from a real failure — same
// helper as cache-state-machine.test.js / qwen3-5-multimodal-cache-stress.test.js.
function isCancellationError(err) {
  if (!err) return false
  return /cancel|aborted|stopp?ed/i.test(err.message || String(err))
}

// Start a run, cancel it once generation is demonstrably under way (2nd
// chunk), and swallow the resulting cancellation error. Returns the number of
// chunks streamed before the cancel landed.
async function runAndCancelMidGeneration(addon) {
  const response = await addon.run(PROMPT)
  let chunkCount = 0
  const ticker = setInterval(() => {}, 50)
  try {
    await response
      .onUpdate(() => {
        chunkCount++
        if (chunkCount === 2) addon.cancel().catch(() => {})
      })
      .await()
  } catch (err) {
    if (!isCancellationError(err)) throw err
  } finally {
    clearInterval(ticker)
  }
  return chunkCount
}

safeTest(
  'Qwen3.5-0.8B repeated cancels mid-speculation do not leak into later requests',
  { timeout: 600_000 },
  async (t) => {
    // Regression guard for two cancel-path defects on the speculative loop:
    //
    //  1. `stopGeneration_` leak: exits of runSpeculativeGeneration that skip
    //     the stop check drop the cancel AND leave the flag set, so the NEXT
    //     generation returns a cancelled/empty result for a request the caller
    //     never cancelled (rolling back its fresh prefill). Fixed by routing
    //     every exit through specFinishRespectingStop / specFail.
    //  2. Cancel cleanup did not mirror the rollback onto the MTP draft context
    //     on the recurrent/hybrid branch — and Qwen3.5-*-MTP is hybrid — so
    //     orphaned draft-cache positions accumulated across cancels until
    //     llama_decode(ctx_dft) failed and MTP silently switched itself off for
    //     the rest of the session.
    //
    // Both surface on requests AFTER a cancel, so the load-bearing assertions
    // are on the follow-up turns. Cancels are repeated across several cycles:
    // defect 2 is cumulative (one orphaned prompt's worth of cells is not
    // enough to break a 2048-cell draft cache, several are observable as
    // drafting degrading to zero), and each extra cycle is another chance for
    // a stop to land in an exit window for defect 1. The exact
    // stop-races-the-final-round timing is not deterministically reachable
    // from JS — the structural guarantee is the single-exit helper in
    // LlmContext.hpp; this test makes a reintroduced leak likely, not certain,
    // to surface.
    const CYCLES = 8
    const addon = await loadAddon(t, {
      withSpec: true,
      overrides: { n_predict: '48', ctx_size: '2048' }
    })

    for (let cycle = 1; cycle <= CYCLES; cycle++) {
      const chunkCount = await runAndCancelMidGeneration(addon)
      t.ok(
        chunkCount > 0,
        `cycle ${cycle}: cancelled turn streamed before the cancel (${chunkCount} chunks)`
      )

      // The follow-up turn must behave as if the cancel never happened.
      const followUp = await addon.run(PROMPT)
      const output = await collectResponse(followUp)
      const stats = followUp.stats
      console.log(
        `  cycle ${cycle}: chars=${output.length} generatedTokens=${stats.generatedTokens} draftAccepted=${stats.draftAccepted} draftTotal=${stats.draftTotal}`
      )
      t.ok(
        output.length > 0,
        `cycle ${cycle}: request after a cancel produces real output, not a stale-flag cancellation`
      )
      t.ok(
        stats.generatedTokens > 0,
        `cycle ${cycle}: request after a cancel generates tokens (generatedTokens=${stats.generatedTokens})`
      )
      // Defect 2: a divergent draft context degrades MTP toward inert.
      t.ok(
        stats.draftTotal > 0,
        `cycle ${cycle}: MTP still drafts after ${cycle} cancel(s) (draftTotal=${stats.draftTotal})`
      )
      t.ok(
        stats.draftAccepted > 0,
        `cycle ${cycle}: MTP still accepts drafts after ${cycle} cancel(s) (draftAccepted=${stats.draftAccepted})`
      )
    }
  }
)
